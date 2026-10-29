import { afterAll, afterEach, beforeAll, expect, it } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  createBackfillManager,
  createDatabase,
  createMigrator,
  sql,
} from "../../src/index.js";
import {
  createIntegrationPool,
  createSchema,
  createSqlDirectory,
  describePostgres,
  dropSchema,
  identifier,
  removeDirectory,
} from "./support.js";

const pool = createIntegrationPool(6);
let rootSchema = "";
const directories: string[] = [];

async function directory(
  kind: string,
  files: Readonly<Record<string, string>>,
): Promise<string> {
  const path = await createSqlDirectory(`querier-${kind}`, files);
  directories.push(path);
  return path;
}

describePostgres("PostgreSQL migrations and backfills integration", () => {
  beforeAll(async () => {
    rootSchema = await createSchema(pool, "querier_files");
  });

  afterEach(async () => {
    await Promise.all(directories.splice(0).map(removeDirectory));
  });

  afterAll(async () => {
    if (rootSchema) await dropSchema(pool, rootSchema);
    await pool.end();
  });

  it("reports pending migrations, applies them in order, and is idempotent", async () => {
    const migrations = await directory("migrations", {
      "002_add_email.sql": `alter table ${identifier(rootSchema)}.users add column email text;`,
      "001_create_users.sql": `create table ${identifier(rootSchema)}.users (id integer primary key);`,
    });
    const migrator = createMigrator(pool, {
      directory: migrations,
      schema: rootSchema,
      table: "migration_history_order",
    });

    await expect(migrator.status()).resolves.toEqual({
      applied: [],
      pending: ["001_create_users", "002_add_email"],
    });
    await expect(migrator.up()).resolves.toEqual(["001_create_users", "002_add_email"]);
    await expect(migrator.up()).resolves.toEqual([]);
    await expect(migrator.status()).resolves.toEqual({
      applied: ["001_create_users", "002_add_email"],
      pending: [],
    });
  });

  it("stops at an inclusive migration target and resumes later", async () => {
    const migrations = await directory("migrations", {
      "001_first.sql": `create table ${identifier(rootSchema)}.target_first (id integer);`,
      "002_second.sql": `create table ${identifier(rootSchema)}.target_second (id integer);`,
      "003_third.sql": `create table ${identifier(rootSchema)}.target_third (id integer);`,
    });
    const migrator = createMigrator(pool, {
      directory: migrations,
      schema: rootSchema,
      table: "migration_history_target",
    });

    await expect(migrator.up({ to: "002_second" })).resolves.toEqual([
      "001_first",
      "002_second",
    ]);
    await expect(migrator.status()).resolves.toEqual({
      applied: ["001_first", "002_second"],
      pending: ["003_third"],
    });
    await expect(migrator.up()).resolves.toEqual(["003_third"]);
  });

  it("detects an applied migration whose SQL changed", async () => {
    const migrations = await directory("migrations", {
      "001_checksum.sql": `create table ${identifier(rootSchema)}.checksum_table (id integer);`,
    });
    const migrator = createMigrator(pool, {
      directory: migrations,
      schema: rootSchema,
      table: "migration_history_checksum",
    });
    await migrator.up();
    await writeFile(
      join(migrations, "001_checksum.sql"),
      `select 1; -- changed`,
      "utf8",
    );

    await expect(migrator.status()).rejects.toThrow(
      "Applied migration 001_checksum was modified after it ran",
    );
  });

  it("rolls back failed migration SQL and does not record it", async () => {
    const migrations = await directory("migrations", {
      "001_broken.sql": `
        create table ${identifier(rootSchema)}.must_rollback (id integer);
        insert into ${identifier(rootSchema)}.missing_table values (1);
      `,
    });
    const migrator = createMigrator(pool, {
      directory: migrations,
      schema: rootSchema,
      table: "migration_history_failure",
    });

    await expect(migrator.up()).rejects.toThrow();
    const existence = await pool.query<{ name: string | null }>(
      "select to_regclass($1) as name",
      [`${rootSchema}.must_rollback`],
    );
    expect(existence.rows[0]?.name).toBeNull();
    await expect(migrator.status()).resolves.toEqual({
      applied: [],
      pending: ["001_broken"],
    });
  });

  it("serializes concurrent migration runs with an advisory lock", async () => {
    const migrations = await directory("migrations", {
      "001_concurrent.sql": `create table ${identifier(rootSchema)}.concurrent_table (id integer);`,
    });
    const options = {
      directory: migrations,
      schema: rootSchema,
      table: "migration_history_concurrent",
    };
    const first = createMigrator(pool, options);
    const second = createMigrator(pool, options);

    const results = await Promise.all([first.up(), second.up()]);
    expect(results.map((result) => [...result]).sort((a, b) => b.length - a.length)).toEqual([
      ["001_concurrent"],
      [],
    ]);
  });

  it("rejects an unknown migration target before touching the database", async () => {
    const migrations = await directory("migrations", { "001_known.sql": "select 1;" });
    const migrator = createMigrator(pool, {
      directory: migrations,
      schema: rootSchema,
      table: "migration_history_unknown",
    });

    await expect(migrator.up({ to: "999_missing" })).rejects.toThrow(
      "Unknown migration target: 999_missing",
    );
  });

  it("runs controlled backfills once and records their status", async () => {
    await pool.query(`
      create table ${identifier(rootSchema)}.backfill_users (
        id integer primary key,
        email text not null,
        active boolean
      )
    `);
    await pool.query(
      `insert into ${identifier(rootSchema)}.backfill_users values (1, 'ADA@EXAMPLE.COM', null)`,
    );
    const backfillDirectory = await directory("backfills", {
      "002_activate.sql": `update ${identifier(rootSchema)}.backfill_users set active = true where active is null;`,
      "001_normalize.sql": `update ${identifier(rootSchema)}.backfill_users set email = lower(email);`,
    });
    const backfills = createBackfillManager(pool, {
      directory: backfillDirectory,
      schema: rootSchema,
      table: "backfill_history_success",
    });

    await expect(backfills.run()).resolves.toEqual(["001_normalize", "002_activate"]);
    await expect(backfills.run()).resolves.toEqual([]);
    await expect(backfills.status()).resolves.toEqual({
      applied: ["001_normalize", "002_activate"],
      pending: [],
    });
    const row = await pool.query<{ email: string; active: boolean }>(
      `select email, active from ${identifier(rootSchema)}.backfill_users`,
    );
    expect(row.rows).toEqual([{ email: "ada@example.com", active: true }]);
  });

  it("rolls back a failed backfill and leaves it pending", async () => {
    await pool.query(`create table ${identifier(rootSchema)}.backfill_values (value integer)`);
    const backfillDirectory = await directory("backfills", {
      "001_broken.sql": `
        insert into ${identifier(rootSchema)}.backfill_values values (1);
        select 1 / 0;
      `,
    });
    const backfills = createBackfillManager(pool, {
      directory: backfillDirectory,
      schema: rootSchema,
      table: "backfill_history_failure",
    });

    await expect(backfills.run()).rejects.toThrow();
    const values = await pool.query(`select value from ${identifier(rootSchema)}.backfill_values`);
    expect(values.rows).toEqual([]);
    await expect(backfills.status()).resolves.toEqual({
      applied: [],
      pending: ["001_broken"],
    });
  });

  it("exposes custom migration and backfill managers on createDatabase", async () => {
    const migrations = await directory("migrations", {
      "001_database.sql": `create table ${identifier(rootSchema)}.configured_table (id integer);`,
    });
    const backfills = await directory("backfills", {
      "001_database.sql": `insert into ${identifier(rootSchema)}.configured_table values (42);`,
    });
    const database = createDatabase(pool, {
      migrations: { directory: migrations, schema: rootSchema, table: "custom_migrations" },
      backfills: { directory: backfills, schema: rootSchema, table: "custom_backfills" },
    });

    await expect(database.migrations.up()).resolves.toEqual(["001_database"]);
    await expect(database.backfills.run()).resolves.toEqual(["001_database"]);
    await expect(database.one<{ value: number }>()`
      select id as value from ${sql.identifier(rootSchema, "configured_table")}
    `).resolves.toEqual({ value: 42 });
  });
});
