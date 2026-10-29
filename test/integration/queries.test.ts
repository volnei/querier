import { afterAll, beforeAll, beforeEach, expect, it } from "bun:test";
import { z } from "zod";
import {
  createQuerier,
  NoRowsError,
  RowValidationError,
  sql,
  TooManyRowsError,
} from "../../src/index.js";
import {
  createIntegrationPool,
  createSchema,
  describePostgres,
  dropSchema,
} from "./support.js";

const pool = createIntegrationPool();
const db = createQuerier(pool);
let schema = "";

const table = (name: string) => sql.identifier(schema, name);

describePostgres("PostgreSQL query integration", () => {
  beforeAll(async () => {
    schema = await createSchema(pool, "querier_queries");
    await db.execute(sql`
      create table ${table("people")} (
        id integer generated always as identity primary key,
        name text not null,
        active boolean not null default true,
        score numeric(10, 2),
        tags text[] not null default '{}',
        created_at timestamptz not null default now()
      )
    `);
    await db.execute(sql`
      create table ${table("documents")} (
        id integer generated always as identity primary key,
        payload jsonb,
        bytes bytea
      )
    `);
  });

  beforeEach(async () => {
    await db.execute(sql`truncate ${table("people")}, ${table("documents")} restart identity`);
  });

  afterAll(async () => {
    if (schema) await dropSchema(pool, schema);
    await pool.end();
  });

  it("executes parameterized inserts without interpreting user input as SQL", async () => {
    const dangerous = "Robert'); drop table people; --";
    const inserted = await db.one<{ id: number; name: string }>()`
      insert into ${table("people")} (name)
      values (${dangerous})
      returning id, name
    `;

    expect(inserted).toEqual({ id: 1, name: dangerous });
    await expect(db.one<{ count: number }>()`
      select count(*)::int as count from ${table("people")}
    `).resolves.toEqual({ count: 1 });
  });

  it("returns ordered rows from a prebuilt typed query", async () => {
    await db.execute(sql`
      insert into ${table("people")} (name) values (${"Grace"}), (${"Ada"})
    `);
    const query = sql<{ id: number; name: string }>`
      select id, name from ${table("people")} order by name
    `;

    await expect(db.many(query)).resolves.toEqual([
      { id: 2, name: "Ada" },
      { id: 1, name: "Grace" },
    ]);
  });

  it("returns one row and null for a missing maybeOne row", async () => {
    await db.execute(sql`insert into ${table("people")} (name) values (${"Ada"})`);

    await expect(db.one<{ name: string }>()`
      select name from ${table("people")} where id = ${1}
    `).resolves.toEqual({ name: "Ada" });
    await expect(db.maybeOne<{ name: string }>()`
      select name from ${table("people")} where id = ${999}
    `).resolves.toBeNull();
  });

  it("throws NoRowsError when one returns no rows", async () => {
    await expect(db.one<{ id: number }>()`
      select id from ${table("people")} where false
    `).rejects.toBeInstanceOf(NoRowsError);
  });

  it("throws TooManyRowsError with the real row count", async () => {
    await db.execute(sql`
      insert into ${table("people")} (name) values (${"Ada"}), (${"Grace"})
    `);

    await expect(db.maybeOne<{ id: number }>()`
      select id from ${table("people")}
    `).rejects.toMatchObject({ rowCount: 2 } satisfies Partial<TooManyRowsError>);
  });

  it("composes identifiers, fragments, and joined parameters safely", async () => {
    await db.execute(sql`
      insert into ${table("people")} (name) values (${"Ada"}), (${"Grace"}), (${"Linus"})
    `);
    const filter = sql.fragment`name in (${sql.join(["Ada", "Linus"])})`;

    const rows = await db.many<{ name: string }>()`
      select ${sql.identifier("name")}
      from ${table("people")}
      where ${filter}
      order by name
    `;
    expect(rows).toEqual([{ name: "Ada" }, { name: "Linus" }]);
  });

  it("bulk inserts rows with sql.values", async () => {
    const values = sql.values([
      ["Ada", true, ["math", "code"]],
      ["Grace", false, ["compiler"]],
      ["Linus", true, []],
    ]);
    const result = await db.execute(sql`
      insert into ${table("people")} (name, active, tags) values ${values}
    `);

    expect(result.rowCount).toBe(3);
    await expect(db.many<{ name: string; tags: string[] }>()`
      select name, tags from ${table("people")} order by id
    `).resolves.toEqual([
      { name: "Ada", tags: ["math", "code"] },
      { name: "Grace", tags: ["compiler"] },
      { name: "Linus", tags: [] },
    ]);
  });

  it("round-trips explicit JSONB including nested values", async () => {
    const payload = {
      kind: "created",
      enabled: true,
      count: 3,
      nested: { nullable: null, tags: ["a", "b"] },
    } as const;
    const row = await db.one<{ payload: typeof payload }>()`
      insert into ${table("documents")} (payload)
      values (${sql.json(payload, "jsonb")})
      returning payload
    `;

    expect(row.payload).toEqual(payload);
  });

  it("keeps SQL NULL distinct from JSON null", async () => {
    await db.execute(sql`
      insert into ${table("documents")} (payload)
      values (${null}), (${sql.json(null, "jsonb")})
    `);

    const rows = await db.many<{ sql_null: boolean; json_type: string | null }>()`
      select payload is null as sql_null, jsonb_typeof(payload) as json_type
      from ${table("documents")}
      order by id
    `;
    expect(rows).toEqual([
      { sql_null: true, json_type: null },
      { sql_null: false, json_type: "null" },
    ]);
  });

  it("round-trips PostgreSQL arrays, timestamps, booleans, numeric values, and bytea", async () => {
    const createdAt = new Date("2025-04-05T12:34:56.789Z");
    const bytes = Buffer.from([0, 1, 2, 254, 255]);
    await db.execute(sql`
      insert into ${table("people")} (name, active, score, tags, created_at)
      values (${"Ada"}, ${false}, ${"12.50"}, ${["typed", "pg"]}, ${createdAt})
    `);
    await db.execute(sql`
      insert into ${table("documents")} (bytes) values (${bytes})
    `);

    const person = await db.one<{
      active: boolean;
      score: string;
      tags: string[];
      created_at: Date;
    }>()`select active, score, tags, created_at from ${table("people")}`;
    const document = await db.one<{ bytes: Buffer }>()`
      select bytes from ${table("documents")}
    `;
    expect(person).toEqual({
      active: false,
      score: "12.50",
      tags: ["typed", "pg"],
      created_at: createdAt,
    });
    expect(document.bytes).toEqual(bytes);
  });

  it("infers, validates, and transforms rows through a Zod parser", async () => {
    await db.execute(sql`insert into ${table("people")} (name) values (${"Ada"})`);
    const Person = z.object({
      id: z.number().int().positive(),
      name: z.string().transform((value) => value.toUpperCase()),
    });

    const person = await db.one(Person)`
      select id, name from ${table("people")} where id = ${1}
    `;
    expect(person).toEqual({ id: 1, name: "ADA" });
  });

  it("reports the exact invalid row index from a real result set", async () => {
    await db.execute(sql`
      insert into ${table("people")} (name) values (${"valid"}), (${"x"}), (${"also-valid"})
    `);
    const Person = z.object({ id: z.number(), name: z.string().min(2) });

    await expect(db.many(Person)`
      select id, name from ${table("people")} order by id
    `).rejects.toMatchObject({ rowIndex: 1 } satisfies Partial<RowValidationError>);
  });

  it("returns positional tuple rows without losing duplicate columns", async () => {
    await db.execute(sql`insert into ${table("people")} (name) values (${"Ada"})`);

    const tuple = await db.oneTuple<[left: string, right: string]>()`
      select name, name from ${table("people")}
    `;
    expect(tuple).toEqual(["Ada", "Ada"]);
  });

  it("supports tuple parsers and every tuple cardinality", async () => {
    await db.execute(sql`
      insert into ${table("people")} (name) values (${"Ada"}), (${"Grace"})
    `);
    const PersonTuple = z.tuple([z.number(), z.string().transform((name) => name.length)]);

    await expect(db.tuples(PersonTuple)`
      select id, name from ${table("people")} order by id
    `).resolves.toEqual([[1, 3], [2, 5]]);
    await expect(db.maybeTuple<[id: number]>()`
      select id from ${table("people")} where id = ${999}
    `).resolves.toBeNull();
    await expect(db.oneTuple<[id: number]>()`
      select id from ${table("people")} where false
    `).rejects.toBeInstanceOf(NoRowsError);
    await expect(db.maybeTuple<[id: number]>()`
      select id from ${table("people")}
    `).rejects.toBeInstanceOf(TooManyRowsError);
  });

  it("applies a parser when execute receives a typed query", async () => {
    const Count = z.object({ count: z.number().transform(BigInt) });
    const result = await db.execute(sql.type(Count)`select 42::int as count`);

    expect(result.rows).toEqual([{ count: 42n }]);
    expect(result.command).toBe("SELECT");
  });
});
