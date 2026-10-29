import { Pool, type QueryResult, type QueryResultRow } from "pg";
import { describe, expect, expectTypeOf, it, vi } from "vitest";
import {
  createDatabase,
  createQuerier,
  NoRowsError,
  Repository,
  sql,
  TooManyRowsError,
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
    if (false) {
      createQuerier(new Pool());
      const db = createDatabase(new Pool(), {
        repositories: {},
        migrations: { directory: "./migrations" },
      });
      db.migrations.status();
    }
  });

  it("preserves the declared row type", async () => {
    const query = vi.fn().mockResolvedValue(result([{ id: 1, name: "Ada" }]));
    const db = createQuerier({ query });

    const user = await db.one(sql<{ id: number; name: string }>`select id, name from users`);

    expectTypeOf(user).toEqualTypeOf<{ id: number; name: string }>();
    expect(user).toEqual({ id: 1, name: "Ada" });
  });

  it("requires a result type for row-returning methods", () => {
    if (false) {
      const db = createQuerier({ query: vi.fn() });
      // @ts-expect-error Untyped SQL statements are only accepted by execute().
      db.one(sql`select id from users`);
      db.execute(sql`delete from users`);
    }
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
});

describe("repository transactions", () => {
  class UsersRepository extends Repository {
    find(id: number) {
      return this.maybeOne(sql<{ id: number; name: string }>`
        select id, name from users where id = ${id}
      `);
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
      expect(transactionRepository.instance).toBe(2);
      expect(transaction.lazy).toBe(transactionRepository);
      expect(transactionRepository).not.toBe(rootRepository);
    });
    expect(constructions).toBe(2);
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

  it("binds transaction repositories to the same checked-out client", async () => {
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

    const user = await db.transaction(async (transaction) => {
      expectTypeOf(transaction.users).toEqualTypeOf<UsersRepository>();
      return transaction.users.find(1);
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
