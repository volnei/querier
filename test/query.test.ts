import { describe, expect, it } from "vitest";
import { expectTypeOf } from "vitest";
import {
  sql,
  type JsonValue,
  type SqlQuery,
  type SqlStatement,
} from "../src/index.js";

describe("sql", () => {
  it("distinguishes statements from typed row queries", () => {
    type User = { id: number; name: string };
    const userSql = sql.type<User>();

    expectTypeOf(sql`delete from users`).toEqualTypeOf<SqlStatement>();
    expectTypeOf(sql<User>`select id, name from users`).toEqualTypeOf<SqlQuery<User>>();
    expectTypeOf(userSql`select id, name from users`).toEqualTypeOf<SqlQuery<User>>();
  });

  it("parameterizes interpolated values", () => {
    const id = 42;
    const active = true;
    const query = sql<{ id: number }>`select id from users where id = ${id} and active = ${active}`;

    expect(query.text).toBe("select id from users where id = $1 and active = $2");
    expect(query.values).toEqual([42, true]);
  });

  it("renumbers nested fragments", () => {
    const filter = sql.fragment`name = ${"Ada"} or email = ${"ada@example.com"}`;
    const query = sql`select * from users where tenant_id = ${7} and (${filter})`;

    expect(query.text).toBe(
      "select * from users where tenant_id = $1 and (name = $2 or email = $3)",
    );
    expect(query.values).toEqual([7, "Ada", "ada@example.com"]);
  });

  it("quotes identifiers", () => {
    const query = sql`select ${sql.identifier("user", "display\"name")} from ${sql.identifier("user")}`;
    expect(query.text).toBe('select "user"."display""name" from "user"');
    expect(query.values).toEqual([]);
  });

  it("builds lists and bulk values", () => {
    const ids = sql.join([1, 2, 3]);
    const rows = sql.values([
      ["Ada", true],
      ["Grace", false],
    ]);
    const query = sql`insert into users (name, active) values ${rows} returning id where id in (${ids})`;

    expect(query.text).toBe(
      "insert into users (name, active) values ($1, $2), ($3, $4) returning id where id in ($5, $6, $7)",
    );
    expect(query.values).toEqual(["Ada", true, "Grace", false, 1, 2, 3]);
  });

  it("encodes JSON values distinctly from SQL null and PostgreSQL arrays", () => {
    const payload = {
      type: "account.created",
      tags: ["billing", "audit"],
      metadata: null,
    } satisfies JsonValue;
    const query = sql`
      select ${sql.json(payload)}, ${sql.json(null)}, ${null}, ${sql.json([1, 2], "jsonb")}
    `;

    expect(query.text).toBe("\n      select $1, $2, $3, $4::jsonb\n    ");
    expect(query.values).toEqual([
      '{"type":"account.created","tags":["billing","audit"],"metadata":null}',
      "null",
      null,
      "[1,2]",
    ]);
  });

  it("rejects values that cannot be represented safely as JSON", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    expect(() => sql.json(undefined as never)).toThrow(
      "sql.json does not support undefined at $",
    );
    expect(() => sql.json(1n as never)).toThrow(
      "sql.json does not support bigint at $",
    );
    expect(() => sql.json(Number.NaN)).toThrow(
      "sql.json does not support non-finite numbers at $",
    );
    expect(() => sql.json(circular as never)).toThrow(
      "sql.json does not support circular values at $.self",
    );

    if (false) {
      // @ts-expect-error undefined is SQL NULL-like, not a JSON value.
      sql.json({ missing: undefined });
      // @ts-expect-error bigint needs an explicit JSON representation.
      sql.json({ amount: 1n });
    }
  });
});
