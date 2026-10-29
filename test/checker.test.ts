import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkQueries } from "../src/checker.js";
import { defineSchema } from "../src/index.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function source(contents: string): Promise<{ directory: string; file: string }> {
  const directory = await mkdtemp(join(tmpdir(), "querier-checker-"));
  directories.push(directory);
  const file = join(directory, "repository.ts");
  await writeFile(file, contents, "utf8");
  return { directory, file };
}

const schema = defineSchema({
  users: {
    columns: {
      id: { type: "integer", primaryKey: true },
      email: { type: "text" },
    },
  },
});

describe("query checker", () => {
  it("checks a typed query against a declarative schema offline", async () => {
    const fixture = await source(`
      const id = 1;
      db.one<{ id: number; email: string }>()\`
        select id, email from users where id = \${id}
      \`;
    `);

    const result = await checkQueries({ paths: [fixture.file], schema });

    expect(result).toEqual({ checked: 1, skipped: 0, diagnostics: [] });
  });

  it("reports unknown tables with source locations", async () => {
    const fixture = await source(`
      db.many<{ id: number }>()\`select id from missing_users\`;
    `);

    const result = await checkQueries({ paths: [fixture.file], schema });

    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        severity: "error",
        file: fixture.file,
        line: 2,
        message: "Unknown table in schema: missing_users",
      }),
    ]);
  });

  it("compares declared result columns in offline mode", async () => {
    const fixture = await source(`
      db.one<{ id: number; name: string }>()\`select id, email from users\`;
    `);

    const result = await checkQueries({ paths: [fixture.file], schema });

    expect(result.diagnostics.map(({ message }) => message)).toEqual([
      "PostgreSQL does not return typed column(s): name",
      "PostgreSQL returns undeclared column(s): email",
    ]);
  });

  it("understands static identifier and fragment bindings", async () => {
    const fixture = await source(`
      const users = sql.identifier("users");
      const active = sql.fragment\`email = \${"ada@example.com"}\`;
      db.one<{ id: number }>()\`select id from \${users} where \${active}\`;
    `);

    const result = await checkQueries({ paths: [fixture.file], schema });

    expect(result).toEqual({ checked: 1, skipped: 0, diagnostics: [] });
  });

  it("extracts queries created with sql.prepare", async () => {
    const fixture = await source(`
      const byId = sql.prepare<{ id: number; email: string }>("users.by-id");
      byId\`select id, email from users where id = \${1}\`;
    `);

    const result = await checkQueries({ paths: [fixture.file], schema });

    expect(result).toEqual({ checked: 1, skipped: 0, diagnostics: [] });
  });

  it("requires an explicit checking backend", async () => {
    const fixture = await source(`db.execute\`select 1\`;`);

    await expect(checkQueries({ paths: [fixture.file] })).rejects.toThrow(
      "requires databaseUrl or schema",
    );
  });
});
