import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { QueryResult, QueryResultRow } from "pg";
import { afterEach, describe, expect, it, vi } from "bun:test";
import { createMigrator } from "../src/index.js";

function result<Row extends QueryResultRow>(rows: Row[] = []): QueryResult<Row> {
  return { command: "SELECT", rowCount: rows.length, oid: 0, fields: [], rows };
}

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function migrationDirectory(files: Readonly<Record<string, string>>): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "querier-migrations-"));
  temporaryDirectories.push(directory);
  await Promise.all(
    Object.entries(files).map(([name, contents]) =>
      writeFile(join(directory, name), contents, "utf8"),
    ),
  );
  return directory;
}

function migrationPool(failingSql?: string) {
  const applied = new Map<string, string>();
  const calls: Array<{ text: string; values: readonly unknown[] }> = [];
  const query = vi.fn(async (text: string, values: readonly unknown[] = []) => {
    const normalized = text.replace(/\s+/g, " ").trim();
    calls.push({ text: normalized, values });
    if (normalized === failingSql) throw new Error("broken migration");
    if (normalized.startsWith("select id, checksum from")) {
      return result([...applied].map(([id, checksum]) => ({ id, checksum })));
    }
    if (normalized.startsWith("insert into")) {
      applied.set(String(values[0]), String(values[1]));
    }
    if (normalized.startsWith("delete from")) applied.delete(String(values[0]));
    return result();
  });
  const release = vi.fn();
  const pool = { query: vi.fn(), connect: vi.fn().mockResolvedValue({ query, release }) };
  return { applied, calls, pool, release };
}

describe("SQL file migrations", () => {
  it("loads SQL files in lexical order", async () => {
    const directory = await migrationDirectory({
      "002_posts.sql": "create table posts (id bigint primary key);",
      "001_users.sql": "create table users (id bigint primary key);",
    });
    const database = migrationPool();
    const migrator = createMigrator(database.pool, { directory });

    await expect(migrator.up()).resolves.toEqual(["001_users", "002_posts"]);
    await expect(migrator.status()).resolves.toEqual({
      applied: ["001_users", "002_posts"],
      pending: [],
    });
    const executed = database.calls.map(({ text }) => text);
    expect(executed.indexOf("create table users (id bigint primary key);")).toBeLessThan(
      executed.indexOf("create table posts (id bigint primary key);"),
    );
    expect(database.calls.filter(({ text }) => text === "BEGIN")).toHaveLength(2);
    expect(database.calls.filter(({ text }) => text === "COMMIT")).toHaveLength(2);
  });

  it("detects when an applied up file is edited", async () => {
    const directory = await migrationDirectory({
      "001_users.sql": "create table users ();",
    });
    const database = migrationPool();
    const migrator = createMigrator(database.pool, { directory });
    await migrator.up();
    await writeFile(join(directory, "001_users.sql"), "create table changed ();", "utf8");

    await expect(migrator.status()).rejects.toThrow(
      "Applied migration 001_users was modified after it ran",
    );
  });

  it("rolls back failed SQL and does not record it", async () => {
    const directory = await migrationDirectory({
      "001_broken.sql": "select broken;",
    });
    const database = migrationPool("select broken;");
    const migrator = createMigrator(database.pool, { directory });

    await expect(migrator.up()).rejects.toThrow("broken migration");
    expect(database.applied.size).toBe(0);
    expect(database.calls.some(({ text }) => text === "ROLLBACK")).toBe(true);
  });

  it("rejects old paired-file names to keep one source per migration", async () => {
    const directory = await migrationDirectory({ "001_users.up.sql": "select 1;" });
    const migrator = createMigrator(migrationPool().pool, { directory });

    await expect(migrator.status()).rejects.toThrow(
      "Expected <id>.sql",
    );
  });
});
