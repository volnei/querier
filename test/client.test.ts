import { Pool, type QueryResult, type QueryResultRow } from "pg";
import { describe, expect, expectTypeOf, it, vi } from "bun:test";
import {
  createDatabase,
  createQuerier,
  NoRowsError,
  Repository,
  RowValidationError,
  sql,
  TooManyRowsError,
  TransactionClosedError,
} from "../src/index.js";

function result<Row extends QueryResultRow>(rows: Row[]): QueryResult<Row> {
  return {
    command: "SELECT",
    rowCount: rows.length,
    oid: 0,
    fields: [],
    rows,
  };
}

describe("createQuerier", () => {
  it("accepts a real pg Pool without adapters", () => {
    const typecheck = () => {
      createQuerier(new Pool());
      const db = createDatabase(new Pool(), {
        repositories: {},
        migrations: { directory: "./migrations" },
        backfills: { directory: "./backfills" },
      });
      void db.migrations.status();
      void db.backfills.status();
    };
    expect(typecheck).toBeInstanceOf(Function);
  });

  it("preserves the declared row type", async () => {
    const query = vi.fn().mockResolvedValue(result([{ id: 1, name: "Ada" }]));
    const db = createQuerier({ query });

    const user = await db.one(sql<{ id: number; name: string }>`select id, name from users`);

    expectTypeOf(user).toEqualTypeOf<{ id: number; name: string }>();
    expect(user).toEqual({ id: 1, name: "Ada" });
  });

  it("executes typed SQL directly from cardinality methods", async () => {
    const query = vi.fn().mockResolvedValue(result([{ id: 1, name: "Ada" }]));
    const db = createQuerier({ query });

    const user = await db.one<{ id: number; name: string }>()`
      select id, name from users where id = ${1}
    `;

    expectTypeOf(user).toEqualTypeOf<{ id: number; name: string }>();
    expect(user).toEqual({ id: 1, name: "Ada" });
    expect(query).toHaveBeenCalledWith(
      "\n      select id, name from users where id = $1\n    ",
      [1],
    );
  });

  it("accepts a parser directly in a cardinality method", async () => {
    const userRow = {
      parse(value: unknown): { id: bigint } {
        return { id: BigInt((value as { id: string }).id) };
      },
    };
    const db = createQuerier({
      query: vi.fn().mockResolvedValue(result([{ id: "42" }])),
    });

    const users = await db.many(userRow)`select id from users`;

    expectTypeOf(users).toEqualTypeOf<{ id: bigint }[]>();
    expect(users).toEqual([{ id: 42n }]);
  });

  it("returns typed tuples using pg array row mode", async () => {
    const query = vi.fn().mockResolvedValue({
      command: "SELECT",
      rowCount: 1,
      oid: 0,
      fields: [],
      rows: [[42, "Ada"]],
    });
    const db = createQuerier({ query });

    const user = await db.oneTuple<[id: number, name: string]>()`
      select id, name from users where id = ${42}
    `;

    expectTypeOf(user).toEqualTypeOf<[id: number, name: string]>();
    expect(user).toEqual([42, "Ada"]);
    expect(query).toHaveBeenCalledWith({
      text: "\n      select id, name from users where id = $1\n    ",
      values: [42],
      rowMode: "array",
    });
  });

  it("infers and validates tuple rows with a parser", async () => {
    const tupleParser = {
      parse(value: unknown): [id: bigint, name: string] {
        const [id, name] = value as [string, string];
        return [BigInt(id), name];
      },
    };
    const query = vi.fn().mockResolvedValue({ rows: [["42", "Ada"]] });
    const db = createQuerier({ query });

    const users = await db.tuples(tupleParser)`select id, name from users`;

    expectTypeOf(users).toEqualTypeOf<Array<[id: bigint, name: string]>>();
    expect(users).toEqual([[42n, "Ada"]]);
  });

  it("uses execute itself as a parameterized SQL tag", async () => {
    const query = vi.fn().mockResolvedValue(result([]));
    const db = createQuerier({ query });

    const executed = await db.execute`delete from users where id = ${7}`;

    expect(executed.rowCount).toBe(0);
    expect(query).toHaveBeenCalledWith("delete from users where id = $1", [7]);
  });

  it("passes prepared query names to pg and avoids copying unparsed rows", async () => {
    const rows = [{ id: 1, name: "Ada" }];
    const query = vi.fn().mockResolvedValue(result(rows));
    const db = createQuerier({ query });
    const byId = sql.prepare<{ id: number; name: string }>("users.by-id");

    const users = await db.many(byId`select id, name from users where id = ${1}`);

    expect(users).toBe(rows);
    expect(query).toHaveBeenCalledWith({
      name: "users.by-id",
      text: "select id, name from users where id = $1",
      values: [1],
    });
  });

  it("uses prepared queries inside the contextual transaction client", async () => {
    const clientQuery = vi.fn(async (input: unknown) => {
      if (typeof input === "object") return result([{ value: 42 }]);
      return result([]);
    });
    const db = createDatabase({
      query: vi.fn().mockResolvedValue(result([])),
      connect: vi.fn().mockResolvedValue({ query: clientQuery, release: vi.fn() }),
    });
    const prepared = sql.prepare<{ value: number }>("answer");

    const answer = await db.transaction(() => db.one(prepared`select ${42}::int as value`));

    expect(answer).toEqual({ value: 42 });
    expect(clientQuery).toHaveBeenCalledWith({
      name: "answer",
      text: "select $1::int as value",
      values: [42],
    });
  });

  it("infers streamed rows from a type or parser", () => {
    const typecheck = () => {
      const db = createQuerier(new Pool());
      const accountRow = {
        parse(value: unknown): { id: bigint } {
          return { id: BigInt((value as { id: string }).id) };
        },
      };

      const parsed = db.stream(accountRow, { batchSize: 100 })`
        select id from accounts
      `;
      const typed = db.stream<{ id: number }>()`select id from accounts`;

      expectTypeOf(parsed).toEqualTypeOf<AsyncIterable<{ id: bigint }>>();
      expectTypeOf(typed).toEqualTypeOf<AsyncIterable<{ id: number }>>();
    };
    expect(typecheck).toBeInstanceOf(Function);
  });

  it("rejects an invalid stream batch size before executing", () => {
    const db = createQuerier({ query: vi.fn() });
    expect(() => db.stream<{ id: number }>({ batchSize: 0 })).toThrow(
      "stream batchSize must be a positive integer",
    );
  });

  it("requires a result type for row-returning methods", () => {
    const typecheck = () => {
      const db = createQuerier({ query: vi.fn() });
      // @ts-expect-error Untyped SQL statements are only accepted by execute().
      void db.one(sql`select id from users`);
      void db.execute(sql`delete from users`);
    };
    expect(typecheck).toBeInstanceOf(Function);
  });

  it("enforces one-row cardinality", async () => {
    const noRows = createQuerier({ query: vi.fn().mockResolvedValue(result([])) });
    await expect(noRows.one(sql<{ value: number }>`select 1`)).rejects.toBeInstanceOf(
      NoRowsError,
    );

    const twoRows = createQuerier({
      query: vi.fn().mockResolvedValue(result([{ id: 1 }, { id: 2 }])),
    });
    await expect(twoRows.maybeOne(sql<{ id: number }>`select id from users`)).rejects.toBeInstanceOf(
      TooManyRowsError,
    );
  });

  it("infers, validates, and transforms rows with an optional parser", async () => {
    const userRow = {
      parse(value: unknown): { id: bigint; name: string } {
        const row = value as { id: string; name: string };
        return { id: BigInt(row.id), name: row.name };
      },
    };
    const query = vi.fn().mockResolvedValue(result([{ id: "42", name: "Ada" }]));
    const db = createQuerier({ query });
    const userSql = sql.type(userRow);

    const user = await db.one(userSql`select id, name from users`);

    expectTypeOf(user).toEqualTypeOf<{ id: bigint; name: string }>();
    expect(user).toEqual({ id: 42n, name: "Ada" });
  });

  it("reports the index and cause of an invalid result row", async () => {
    const invalidRow = new Error("invalid row");
    const userRow = {
      parse(value: unknown): { id: number } {
        const row = value as { id: number };
        if (row.id === 2) throw invalidRow;
        return row;
      },
    };
    const db = createQuerier({
      query: vi.fn().mockResolvedValue(result([{ id: 1 }, { id: 2 }])),
    });

    await expect(db.many(sql.type(userRow)`select id from users`)).rejects.toMatchObject({
      name: "RowValidationError",
      rowIndex: 1,
      cause: invalidRow,
    } satisfies Partial<RowValidationError>);
  });
});

describe("repository transactions", () => {
  class UsersRepository extends Repository {
    find(id: number) {
      return this.maybeOne<{ id: number; name: string }>()`
        select id, name from users where id = ${id}
      `;
    }

    count() {
      return this.oneTuple<[count: number]>()`select count(*)::int from users`;
    }
  }

  it("creates and caches repositories only on first access", async () => {
    let constructions = 0;
    class LazyRepository extends Repository {
      readonly instance = ++constructions;
    }

    const clientQuery = vi.fn().mockResolvedValue(result([]));
    const db = createDatabase(
      {
        query: vi.fn().mockResolvedValue(result([])),
        connect: vi.fn().mockResolvedValue({ query: clientQuery, release: vi.fn() }),
      },
      { repositories: { lazy: LazyRepository } },
    );

    expect(constructions).toBe(0);
    expect(Object.keys(db)).toContain("lazy");
    expect(constructions).toBe(0);

    const rootRepository = db.lazy;
    expect(rootRepository.instance).toBe(1);
    expect(db.lazy).toBe(rootRepository);
    expect(constructions).toBe(1);

    await db.transaction(async (transaction) => {
      expect(constructions).toBe(1);
      const transactionRepository = transaction.lazy;
      expect(transactionRepository.instance).toBe(1);
      expect(transaction.lazy).toBe(transactionRepository);
      expect(transactionRepository).toBe(rootRepository);
    });
    expect(constructions).toBe(1);
  });

  it("rejects repository names that collide with database methods", () => {
    class ConflictingRepository extends Repository {}
    const pool = {
      query: vi.fn().mockResolvedValue(result([])),
      connect: vi.fn(),
    };

    expect(() =>
      createDatabase(pool, {
        repositories: { transaction: ConflictingRepository },
      }),
    ).toThrow("Repository name is reserved: transaction");
  });

  it("propagates the transaction client through services without passing tx", async () => {
    const clientQuery = vi
      .fn()
      .mockResolvedValueOnce(result([]))
      .mockResolvedValueOnce(result([{ id: 1, name: "Ada" }]))
      .mockResolvedValueOnce(result([]));
    const release = vi.fn();
    const pool = {
      query: vi.fn().mockResolvedValue(result([])),
      connect: vi.fn().mockResolvedValue({ query: clientQuery, release }),
    };
    const db = createDatabase(pool, { repositories: { users: UsersRepository } });
    const userService = {
      findUser: (id: number) => db.users.find(id),
    };

    const user = await db.transaction(async (transaction) => {
      expectTypeOf(transaction.users).toEqualTypeOf<UsersRepository>();
      expect(transaction.users).toBe(db.users);
      return userService.findUser(1);
    });

    expectTypeOf(user).toEqualTypeOf<{ id: number; name: string } | null>();
    expect(user).toEqual({ id: 1, name: "Ada" });
    expect(clientQuery.mock.calls.map(([text]) => text.trim())).toEqual([
      "BEGIN",
      "select id, name from users where id = $1",
      "COMMIT",
    ]);
    expect(clientQuery.mock.calls[1]?.[1]).toEqual([1]);
    expect(pool.query).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
  });

  it("joins nested transactions without checking out another client", async () => {
    const clientQuery = vi
      .fn()
      .mockResolvedValueOnce(result([]))
      .mockResolvedValueOnce(result([{ id: 1, name: "Ada" }]))
      .mockResolvedValueOnce(result([]));
    const connect = vi.fn().mockResolvedValue({ query: clientQuery, release: vi.fn() });
    const db = createDatabase(
      { query: vi.fn().mockResolvedValue(result([])), connect },
      { repositories: { users: UsersRepository } },
    );

    const user = await db.transaction(() =>
      db.transaction(() => db.users.find(1)),
    );

    expect(user).toEqual({ id: 1, name: "Ada" });
    expect(connect).toHaveBeenCalledOnce();
    expect(clientQuery.mock.calls.map(([text]) => text.trim())).toEqual([
      "BEGIN",
      "select id, name from users where id = $1",
      "COMMIT",
    ]);
  });

  it("rejects transaction options on a nested transaction", async () => {
    const clientQuery = vi.fn().mockResolvedValue(result([]));
    const db = createDatabase({
      query: vi.fn().mockResolvedValue(result([])),
      connect: vi.fn().mockResolvedValue({ query: clientQuery, release: vi.fn() }),
    });

    await expect(
      db.transaction(() =>
        db.transaction(async () => undefined, { isolationLevel: "serializable" }),
      ),
    ).rejects.toThrow("Nested transactions cannot change transaction options");
    expect(clientQuery.mock.calls.map(([text]) => text.trim())).toEqual(["BEGIN", "ROLLBACK"]);
  });

  it("isolates concurrent transaction contexts", async () => {
    const firstQuery = vi.fn(async (text: string, _values?: readonly unknown[]) =>
      result(text === "BEGIN" || text === "COMMIT" ? [] : [{ id: 1, name: "Ada" }]),
    );
    const secondQuery = vi.fn(async (text: string, _values?: readonly unknown[]) =>
      result(text === "BEGIN" || text === "COMMIT" ? [] : [{ id: 2, name: "Grace" }]),
    );
    const connect = vi
      .fn()
      .mockResolvedValueOnce({ query: firstQuery, release: vi.fn() })
      .mockResolvedValueOnce({ query: secondQuery, release: vi.fn() });
    const poolQuery = vi.fn().mockResolvedValue(result([]));
    const db = createDatabase(
      { query: poolQuery, connect },
      { repositories: { users: UsersRepository } },
    );

    const [first, second] = await Promise.all([
      db.transaction(async () => {
        await Promise.resolve();
        return db.users.find(1);
      }),
      db.transaction(async () => {
        await Promise.resolve();
        return db.users.find(2);
      }),
    ]);

    expect(first).toEqual({ id: 1, name: "Ada" });
    expect(second).toEqual({ id: 2, name: "Grace" });
    expect(firstQuery.mock.calls[1]?.[1]).toEqual([1]);
    expect(secondQuery.mock.calls[1]?.[1]).toEqual([2]);
    expect(poolQuery).not.toHaveBeenCalled();
  });

  it("rejects queries from async work that escapes the transaction callback", async () => {
    const clientQuery = vi.fn().mockResolvedValue(result([]));
    const db = createDatabase(
      {
        query: vi.fn().mockResolvedValue(result([])),
        connect: vi.fn().mockResolvedValue({ query: clientQuery, release: vi.fn() }),
      },
      { repositories: { users: UsersRepository } },
    );
    let resume!: () => void;
    let escapedQuery!: Promise<{ id: number; name: string } | null>;

    await db.transaction(async () => {
      const gate = new Promise<void>((resolve) => {
        resume = resolve;
      });
      escapedQuery = (async () => {
        await gate;
        return db.users.find(1);
      })();
    });

    resume();
    await expect(escapedQuery).rejects.toBeInstanceOf(TransactionClosedError);
    expect(clientQuery.mock.calls.map(([text]) => text.trim())).toEqual(["BEGIN", "COMMIT"]);
  });

  it("rolls back repository failures", async () => {
    const failure = new Error("insufficient funds");
    const clientQuery = vi
      .fn()
      .mockResolvedValueOnce(result([]))
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce(result([]));
    const release = vi.fn();
    const db = createDatabase(
      {
        query: vi.fn().mockResolvedValue(result([])),
        connect: vi.fn().mockResolvedValue({ query: clientQuery, release }),
      },
      { repositories: { users: UsersRepository } },
    );

    await expect(
      db.transaction((transaction) => transaction.users.find(1)),
    ).rejects.toBe(failure);
    expect(clientQuery.mock.calls.map(([text]) => text.trim())).toEqual([
      "BEGIN",
      "select id, name from users where id = $1",
      "ROLLBACK",
    ]);
    expect(release).toHaveBeenCalledOnce();
  });
});
