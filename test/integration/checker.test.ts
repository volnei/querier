import { afterAll, beforeAll, expect, it } from "bun:test";
import { checkQueries } from "../../src/checker.js";
import {
  createIntegrationPool,
  createSchema,
  createSqlDirectory,
  databaseUrl,
  describePostgres,
  dropSchema,
  identifier,
  removeDirectory,
} from "./support.js";

const pool = createIntegrationPool();
let schema = "";
const directories: string[] = [];

async function fixture(contents: string): Promise<string> {
  const directory = await createSqlDirectory("querier-checker-source", {
    "repository.ts": contents,
  });
  directories.push(directory);
  return directory;
}

describePostgres("PostgreSQL query checker integration", () => {
  beforeAll(async () => {
    schema = await createSchema(pool, "querier_checker");
    await pool.query(`
      create table ${identifier(schema)}.users (
        id integer generated always as identity primary key,
        email text not null unique
      )
    `);
  });

  afterAll(async () => {
    await Promise.all(directories.map(removeDirectory));
    if (schema) await dropSchema(pool, schema);
    await pool.end();
  });

  it("validates parameters and result columns without returning rows", async () => {
    const path = await fixture(`
      const email = "ada@example.com";
      db.maybeOne<{ id: number; email: string }>()\`
        select id, email from users where email = \${email}
      \`;
    `);

    const result = await checkQueries({
      paths: [path],
      databaseUrl: databaseUrl!,
      searchPath: schema,
    });

    expect(result).toEqual({ checked: 1, skipped: 0, diagnostics: [] });
  });

  it("returns PostgreSQL errors at the tagged template location", async () => {
    const path = await fixture(`
      db.one<{ id: number }>()\`select missing_column as id from users\`;
    `);

    const result = await checkQueries({
      paths: [path],
      databaseUrl: databaseUrl!,
      searchPath: schema,
    });

    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        severity: "error",
        line: 2,
        message: expect.stringContaining('column "missing_column" does not exist'),
      }),
    ]);
  });

  it("detects a mismatch between PostgreSQL columns and a TypeScript type", async () => {
    const path = await fixture(`
      db.one<{ id: number; name: string }>()\`select id, email from users\`;
    `);

    const result = await checkQueries({
      paths: [path],
      databaseUrl: databaseUrl!,
      searchPath: schema,
    });

    expect(result.diagnostics.map(({ message }) => message)).toEqual([
      "PostgreSQL does not return typed column(s): name",
      "PostgreSQL returns undeclared column(s): email",
    ]);
  });

  it("checks data-changing statements with PREPARE without executing them", async () => {
    const path = await fixture(`
      const email = "ada@example.com";
      db.one<{ id: number }>()\`
        insert into users (email) values (\${email}) returning id
      \`;
    `);

    const result = await checkQueries({
      paths: [path],
      databaseUrl: databaseUrl!,
      searchPath: schema,
    });
    const count = await pool.query<{ count: number }>(
      `select count(*)::int as count from ${identifier(schema)}.users`,
    );

    expect(result).toEqual({ checked: 1, skipped: 0, diagnostics: [] });
    expect(count.rows[0]?.count).toBe(0);
  });
});
