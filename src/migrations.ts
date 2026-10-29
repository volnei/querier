import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { PgPoolLike, PgTransactionClient, Querier } from "./client.js";
import { createQuerier } from "./client.js";
import { sql, type SqlFragment } from "./query.js";

export interface MigratorOptions {
  /** Directory containing ordered `<id>.sql` migration files. */
  readonly directory: string | URL;
  readonly schema?: string;
  readonly table?: string;
}

export interface MigrationStatus {
  readonly applied: readonly string[];
  readonly pending: readonly string[];
}

export interface MigrateUpOptions {
  /** Apply through this migration id, inclusive. Omit to apply everything pending. */
  readonly to?: string;
}

export interface Migrator {
  status(): Promise<MigrationStatus>;
  up(options?: MigrateUpOptions): Promise<readonly string[]>;
}

interface MigrationFile {
  readonly id: string;
  readonly contents: string;
  readonly checksum: string;
}

interface AppliedMigration {
  readonly id: string;
  readonly checksum: string;
}

function directoryPath(directory: string | URL): string {
  return directory instanceof URL ? fileURLToPath(directory) : resolve(directory);
}

function checksum(contents: string): string {
  return createHash("sha256").update(contents).digest("hex");
}

async function loadMigrations(directory: string | URL): Promise<readonly MigrationFile[]> {
  const path = directoryPath(directory);
  const entries = await readdir(path, { withFileTypes: true });
  const files = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".sql"));

  const migrations = await Promise.all(
    files.map(async (file): Promise<MigrationFile> => {
      const id = file.name.slice(0, -".sql".length);
      if (id === "" || id.endsWith(".up") || id.endsWith(".down")) {
        throw new Error(`Invalid migration filename: ${file.name}. Expected <id>.sql`);
      }

      const contents = await readFile(join(path, file.name), "utf8");
      if (contents.trim() === "") throw new Error(`Migration ${id} is empty`);
      return Object.freeze({ id, contents, checksum: checksum(contents) });
    }),
  );

  return Object.freeze(
    migrations.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)),
  );
}

function assertKnownTarget(migrations: readonly MigrationFile[], target: string): void {
  if (!migrations.some((migration) => migration.id === target)) {
    throw new Error(`Unknown migration target: ${target}`);
  }
}

function assertLinearHistory(
  migrations: readonly MigrationFile[],
  applied: readonly AppliedMigration[],
): void {
  const appliedById = new Map(applied.map((migration) => [migration.id, migration]));
  const knownIds = new Set(migrations.map((migration) => migration.id));
  const unknown = applied.filter(({ id }) => !knownIds.has(id)).map(({ id }) => id);
  if (unknown.length > 0) {
    throw new Error(`Database contains unknown migrations: ${unknown.join(", ")}`);
  }

  let foundPending = false;
  for (const migration of migrations) {
    const appliedMigration = appliedById.get(migration.id);
    if (!appliedMigration) {
      foundPending = true;
      continue;
    }
    if (foundPending) {
      throw new Error(
        `Migration history is not linear: ${migration.id} is applied after a pending migration`,
      );
    }
    if (appliedMigration.checksum !== migration.checksum) {
      throw new Error(`Applied migration ${migration.id} was modified after it ran`);
    }
  }
}

async function ensureMigrationsTable(query: Querier, table: SqlFragment): Promise<void> {
  await query.execute(sql`
    create table if not exists ${table} (
      id text primary key,
      checksum text not null,
      applied_at timestamptz not null default now()
    )
  `);
}

async function readApplied(query: Querier, table: SqlFragment): Promise<AppliedMigration[]> {
  return query.many(sql<AppliedMigration>`select id, checksum from ${table}`);
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

export function createMigrator(pool: PgPoolLike, options: MigratorOptions): Migrator {
  const schema = options.schema ?? "public";
  const tableName = options.table ?? "_querier_migrations";
  const table = sql.identifier(schema, tableName);
  const lockName = `querier:migrations:${schema}.${tableName}`;

  async function withLock<T>(callback: (client: PgTransactionClient) => Promise<T>): Promise<T> {
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
    migrations: readonly MigrationFile[],
  ): Promise<MigrationStatus> {
    const query = createQuerier(client);
    await ensureMigrationsTable(query, table);
    const applied = await readApplied(query, table);
    assertLinearHistory(migrations, applied);
    const appliedIds = new Set(applied.map(({ id }) => id));

    return Object.freeze({
      applied: Object.freeze(
        migrations.filter(({ id }) => appliedIds.has(id)).map(({ id }) => id),
      ),
      pending: Object.freeze(
        migrations.filter(({ id }) => !appliedIds.has(id)).map(({ id }) => id),
      ),
    });
  }

  return Object.freeze({
    async status(): Promise<MigrationStatus> {
      const migrations = await loadMigrations(options.directory);
      return withLock((client) => currentStatus(client, migrations));
    },

    async up(upOptions: MigrateUpOptions = {}): Promise<readonly string[]> {
      const migrations = await loadMigrations(options.directory);
      if (upOptions.to) assertKnownTarget(migrations, upOptions.to);

      return withLock(async (client) => {
        const status = await currentStatus(client, migrations);
        const applied: string[] = [];
        const targetIndex = upOptions.to
          ? migrations.findIndex(({ id }) => id === upOptions.to)
          : migrations.length - 1;

        for (const migration of migrations.slice(0, targetIndex + 1)) {
          if (!status.pending.includes(migration.id)) continue;

          await runInTransaction(client, async () => {
            await client.query(migration.contents);
            await createQuerier(client).execute(sql`
              insert into ${table} (id, checksum)
              values (${migration.id}, ${migration.checksum})
            `);
          });
          applied.push(migration.id);
        }

        return Object.freeze(applied);
      });
    },
  });
}
