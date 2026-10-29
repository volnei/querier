import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { PgPoolLike, PgTransactionClient, Querier } from "./client.js";
import { createQuerier } from "./client.js";
import { sql, type SqlFragment } from "./query.js";

export interface SqlFileRunnerOptions {
  readonly directory: string | URL;
  readonly schema?: string;
  readonly table?: string;
}

export interface SqlFileStatus {
  readonly applied: readonly string[];
  readonly pending: readonly string[];
}

export interface ApplySqlFilesOptions {
  readonly to?: string;
}

interface SqlFile {
  readonly id: string;
  readonly contents: string;
  readonly checksum: string;
}

interface AppliedSqlFile {
  readonly id: string;
  readonly checksum: string;
}

interface SqlFileKind {
  readonly singular: string;
  readonly plural: string;
  readonly defaultTable: string;
}

export interface SqlFileRunner {
  status(): Promise<SqlFileStatus>;
  apply(options?: ApplySqlFilesOptions): Promise<readonly string[]>;
}

function directoryPath(directory: string | URL): string {
  return directory instanceof URL ? fileURLToPath(directory) : resolve(directory);
}

function checksum(contents: string): string {
  return createHash("sha256").update(contents).digest("hex");
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

async function loadSqlFiles(
  directory: string | URL,
  kind: SqlFileKind,
): Promise<readonly SqlFile[]> {
  const path = directoryPath(directory);
  const entries = await readdir(path, { withFileTypes: true });
  const files = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".sql"));

  const loaded = await Promise.all(
    files.map(async (file): Promise<SqlFile> => {
      const id = file.name.slice(0, -".sql".length);
      if (id === "" || id.endsWith(".up") || id.endsWith(".down")) {
        throw new Error(
          `Invalid ${kind.singular} filename: ${file.name}. Expected <id>.sql`,
        );
      }

      const contents = await readFile(join(path, file.name), "utf8");
      if (contents.trim() === "") {
        throw new Error(`${capitalize(kind.singular)} ${id} is empty`);
      }
      return Object.freeze({ id, contents, checksum: checksum(contents) });
    }),
  );

  return Object.freeze(
    loaded.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)),
  );
}

function assertKnownTarget(
  files: readonly SqlFile[],
  target: string,
  kind: SqlFileKind,
): void {
  if (!files.some((file) => file.id === target)) {
    throw new Error(`Unknown ${kind.singular} target: ${target}`);
  }
}

function assertLinearHistory(
  files: readonly SqlFile[],
  applied: readonly AppliedSqlFile[],
  kind: SqlFileKind,
): void {
  const appliedById = new Map(applied.map((file) => [file.id, file]));
  const knownIds = new Set(files.map((file) => file.id));
  const unknown = applied.filter(({ id }) => !knownIds.has(id)).map(({ id }) => id);
  if (unknown.length > 0) {
    throw new Error(`Database contains unknown ${kind.plural}: ${unknown.join(", ")}`);
  }

  let foundPending = false;
  for (const file of files) {
    const appliedFile = appliedById.get(file.id);
    if (!appliedFile) {
      foundPending = true;
      continue;
    }
    if (foundPending) {
      throw new Error(
        `${capitalize(kind.singular)} history is not linear: ${file.id} is applied after a pending ${kind.singular}`,
      );
    }
    if (appliedFile.checksum !== file.checksum) {
      throw new Error(`Applied ${kind.singular} ${file.id} was modified after it ran`);
    }
  }
}

async function ensureHistoryTable(query: Querier, table: SqlFragment): Promise<void> {
  await query.execute(sql`
    create table if not exists ${table} (
      id text primary key,
      checksum text not null,
      applied_at timestamptz not null default now()
    )
  `);
}

async function readApplied(query: Querier, table: SqlFragment): Promise<AppliedSqlFile[]> {
  return query.many(sql<AppliedSqlFile>`select id, checksum from ${table}`);
}

async function runInTransaction(
  client: PgTransactionClient,
  callback: () => Promise<void>,
): Promise<void> {
  await client.query("BEGIN");
  try {
    await callback();
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

export function createSqlFileRunner(
  pool: PgPoolLike,
  options: SqlFileRunnerOptions,
  kind: SqlFileKind,
): SqlFileRunner {
  const schema = options.schema ?? "public";
  const tableName = options.table ?? kind.defaultTable;
  const table = sql.identifier(schema, tableName);
  const lockName = `querier:${kind.plural}:${schema}.${tableName}`;

  async function withLock<T>(
    callback: (client: PgTransactionClient) => Promise<T>,
  ): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query("select pg_advisory_lock(hashtext($1))", [lockName]);
      return await callback(client);
    } finally {
      try {
        await client.query("select pg_advisory_unlock(hashtext($1))", [lockName]);
      } finally {
        client.release();
      }
    }
  }

  async function currentStatus(
    client: PgTransactionClient,
    files: readonly SqlFile[],
  ): Promise<SqlFileStatus> {
    const query = createQuerier(client);
    await ensureHistoryTable(query, table);
    const applied = await readApplied(query, table);
    assertLinearHistory(files, applied, kind);
    const appliedIds = new Set(applied.map(({ id }) => id));

    return Object.freeze({
      applied: Object.freeze(files.filter(({ id }) => appliedIds.has(id)).map(({ id }) => id)),
      pending: Object.freeze(files.filter(({ id }) => !appliedIds.has(id)).map(({ id }) => id)),
    });
  }

  return Object.freeze({
    async status(): Promise<SqlFileStatus> {
      const files = await loadSqlFiles(options.directory, kind);
      return withLock((client) => currentStatus(client, files));
    },

    async apply(applyOptions: ApplySqlFilesOptions = {}): Promise<readonly string[]> {
      const files = await loadSqlFiles(options.directory, kind);
      if (applyOptions.to) assertKnownTarget(files, applyOptions.to, kind);

      return withLock(async (client) => {
        const status = await currentStatus(client, files);
        const applied: string[] = [];
        const targetIndex = applyOptions.to
          ? files.findIndex(({ id }) => id === applyOptions.to)
          : files.length - 1;

        for (const file of files.slice(0, targetIndex + 1)) {
          if (!status.pending.includes(file.id)) continue;

          await runInTransaction(client, async () => {
            await client.query(file.contents);
            await createQuerier(client).execute(sql`
              insert into ${table} (id, checksum)
              values (${file.id}, ${file.checksum})
            `);
          });
          applied.push(file.id);
        }

        return Object.freeze(applied);
      });
    },
  });
}
