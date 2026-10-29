import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { QueryResult, QueryResultRow } from "pg";
import { afterEach, describe, expect, it, vi } from "bun:test";
import { createBackfillManager } from "../src/index.js";

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

async function backfillDirectory(files: Readonly<Record<string, string>>): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "querier-backfills-"));
  temporaryDirectories.push(directory);
  await Promise.all(
    Object.entries(files).map(([name, contents]) =>
      writeFile(join(directory, name), contents, "utf8"),
    ),
  );
  return directory;
}

function backfillPool(failingSql?: string) {
  const applied = new Map<string, string>();
  const calls: Array<{ text: string; values: readonly unknown[] }> = [];
  const query = vi.fn(async (text: string, values: readonly unknown[] = []) => {
    const normalized = text.replace(/\s+/g, " ").trim();
    calls.push({ text: normalized, values });
    if (normalized === failingSql) throw new Error("broken backfill");
    if (normalized.startsWith("select id, checksum from")) {
      return result([...applied].map(([id, checksum]) => ({ id, checksum })));
    }
    if (normalized.startsWith("insert into")) {
      applied.set(String(values[0]), String(values[1]));
    }
    return result();
  });
  const release = vi.fn();
  const pool = { query: vi.fn(), connect: vi.fn().mockResolvedValue({ query, release }) };
  return { applied, calls, pool, release };
}

describe("controlled SQL backfills", () => {
  it("runs pending files once in lexical order", async () => {
    const directory = await backfillDirectory({
      "002_activate_users.sql": "update users set active = true where active is null;",
      "001_normalize_emails.sql": "update users set email = lower(email);",
    });
    const database = backfillPool();
    const backfills = createBackfillManager(database.pool, { directory });

    await expect(backfills.run()).resolves.toEqual([
      "001_normalize_emails",
      "002_activate_users",
    ]);
    await expect(backfills.run()).resolves.toEqual([]);
    await expect(backfills.status()).resolves.toEqual({
      applied: ["001_normalize_emails", "002_activate_users"],
      pending: [],
    });

    const executed = database.calls.map(({ text }) => text);
    expect(executed.filter((text) => text === "update users set email = lower(email);")).toHaveLength(1);
    expect(executed.filter((text) => text.startsWith("create table if not exists \"public\".\"_querier_backfills\""))).not.toHaveLength(0);
  });

  it("can stop at a specific backfill", async () => {
    const directory = await backfillDirectory({
      "001_first.sql": "select 1;",
      "002_second.sql": "select 2;",
    });
    const backfills = createBackfillManager(backfillPool().pool, { directory });

    await expect(backfills.run({ to: "001_first" })).resolves.toEqual(["001_first"]);
    await expect(backfills.status()).resolves.toEqual({
      applied: ["001_first"],
      pending: ["002_second"],
    });
  });

  it("rejects an applied file that was edited", async () => {
    const directory = await backfillDirectory({
      "001_normalize.sql": "update users set email = lower(email);",
    });
    const database = backfillPool();
    const backfills = createBackfillManager(database.pool, { directory });
    await backfills.run();
    await writeFile(join(directory, "001_normalize.sql"), "select changed;", "utf8");

    await expect(backfills.status()).rejects.toThrow(
      "Applied backfill 001_normalize was modified after it ran",
    );
  });

  it("rolls back failed SQL without recording it", async () => {
    const directory = await backfillDirectory({
      "001_broken.sql": "select broken;",
    });
    const database = backfillPool("select broken;");
    const backfills = createBackfillManager(database.pool, { directory });

    await expect(backfills.run()).rejects.toThrow("broken backfill");
    expect(database.applied.size).toBe(0);
    expect(database.calls.some(({ text }) => text === "ROLLBACK")).toBe(true);
  });
});
