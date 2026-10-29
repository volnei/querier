import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe } from "bun:test";
import { Pool } from "pg";

export const databaseUrl = process.env.DATABASE_URL;
export const describePostgres = databaseUrl ? describe : describe.skip;

export function createIntegrationPool(max = 4): Pool {
  return new Pool({
    connectionString: databaseUrl ?? "postgres://integration-tests-disabled",
    max,
  });
}

export function identifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

export async function createSchema(pool: Pool, prefix: string): Promise<string> {
  const suffix = `${process.pid}_${crypto.randomUUID().replaceAll("-", "")}`;
  const schema = `${prefix}_${suffix}`;
  await pool.query(`create schema ${identifier(schema)}`);
  return schema;
}

export async function dropSchema(pool: Pool, schema: string): Promise<void> {
  await pool.query(`drop schema if exists ${identifier(schema)} cascade`);
}

export async function createSqlDirectory(
  prefix: string,
  files: Readonly<Record<string, string>>,
): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), `${prefix}-`));
  await Promise.all(
    Object.entries(files).map(([name, contents]) =>
      writeFile(join(directory, name), contents, "utf8"),
    ),
  );
  return directory;
}

export async function removeDirectory(directory: string): Promise<void> {
  await rm(directory, { recursive: true, force: true });
}
