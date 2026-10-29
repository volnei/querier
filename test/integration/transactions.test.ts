import { afterAll, beforeAll, beforeEach, expect, it } from "bun:test";
import { z } from "zod";
import {
  createDatabase,
  Repository,
  RowValidationError,
  sql,
  TransactionClosedError,
} from "../../src/index.js";
import {
  createIntegrationPool,
  createSchema,
  describePostgres,
  dropSchema,
} from "./support.js";

const pool = createIntegrationPool(6);
let schema = "";
let repositoryConstructions = 0;
const accountsTable = () => sql.identifier(schema, "accounts");
const preparedAccountById = sql.prepare<{
  id: number;
  owner: string;
  balance: number;
}>("integration.accounts.by-id");

class AccountsRepository extends Repository {
  readonly instance = ++repositoryConstructions;

  create(owner: string, balance: number) {
    return this.one<{ id: number; owner: string; balance: number }>()`
      insert into ${accountsTable()} (owner, balance)
      values (${owner}, ${balance})
      returning id, owner, balance
    `;
  }

  changeBalance(id: number, amount: number) {
    return this.one<{ id: number; balance: number }>()`
      update ${accountsTable()}
      set balance = balance + ${amount}
      where id = ${id}
      returning id, balance
    `;
  }

  find(id: number) {
    return this.maybeOne<{ id: number; owner: string; balance: number }>()`
      select id, owner, balance from ${accountsTable()} where id = ${id}
    `;
  }

  findPrepared(id: number) {
    return this.one(preparedAccountById`
      select id, owner, balance from ${accountsTable()} where id = ${id}
    `);
  }

  streamAll(batchSize = 10) {
    return this.stream<{ id: number; owner: string; balance: number }>({ batchSize })`
      select id, owner, balance from ${accountsTable()} order by id
    `;
  }
}

const db = createDatabase(pool, { repositories: { accounts: AccountsRepository } });

class TransferService {
  constructor(private readonly accounts: AccountsRepository) {}

  async transfer(source: number, destination: number, amount: number): Promise<void> {
    await this.accounts.changeBalance(source, -amount);
    await this.accounts.changeBalance(destination, amount);
  }
}

describePostgres("PostgreSQL repository and transaction integration", () => {
  beforeAll(async () => {
    schema = await createSchema(pool, "querier_transactions");
    await db.execute(sql`
      create table ${accountsTable()} (
        id integer generated always as identity primary key,
        owner text not null unique,
        balance integer not null check (balance >= 0)
      )
    `);
  });

  beforeEach(async () => {
    await db.execute(sql`truncate ${accountsTable()} restart identity`);
  });

  afterAll(async () => {
    if (schema) await dropSchema(pool, schema);
    await pool.end();
  });

  it("constructs a repository lazily and reuses the same instance", () => {
    expect(repositoryConstructions).toBe(0);
    const first = db.accounts;
    expect(repositoryConstructions).toBe(1);
    expect(db.accounts).toBe(first);
    expect(db.accounts.instance).toBe(1);
  });

  it("commits service work through AsyncLocalStorage without passing tx", async () => {
    const source = await db.accounts.create("source", 100);
    const destination = await db.accounts.create("destination", 25);
    const service = new TransferService(db.accounts);

    await db.transaction(() => service.transfer(source.id, destination.id, 40));

    await expect(db.accounts.find(source.id)).resolves.toMatchObject({ balance: 60 });
    await expect(db.accounts.find(destination.id)).resolves.toMatchObject({ balance: 65 });
  });

  it("reuses prepared repository queries on the active transaction client", async () => {
    const account = await db.accounts.create("prepared", 50);

    const rows = await db.transaction(async () => [
      await db.accounts.findPrepared(account.id),
      await db.accounts.findPrepared(account.id),
    ]);

    expect(rows).toEqual([account, account]);
  });

  it("rolls back every repository write when later work fails", async () => {
    const source = await db.accounts.create("source", 100);
    const destination = await db.accounts.create("destination", 0);
    const service = new TransferService(db.accounts);

    await expect(
      db.transaction(() => service.transfer(source.id, destination.id, 150)),
    ).rejects.toThrow();

    await expect(db.accounts.find(source.id)).resolves.toMatchObject({ balance: 100 });
    await expect(db.accounts.find(destination.id)).resolves.toMatchObject({ balance: 0 });
  });

  it("joins nested transactions and commits them as one unit", async () => {
    await db.transaction(async (outer) => {
      await db.accounts.create("outer", 10);
      await db.transaction(async (inner) => {
        expect(inner.accounts).toBe(outer.accounts);
        await inner.accounts.create("inner", 20);
      });
    });

    await expect(db.many<{ owner: string }>()`
      select owner from ${accountsTable()} order by id
    `).resolves.toEqual([{ owner: "outer" }, { owner: "inner" }]);
  });

  it("rolls back outer work when a joined nested transaction fails", async () => {
    await expect(db.transaction(async () => {
      await db.accounts.create("outer", 10);
      await db.transaction(async () => {
        await db.accounts.create("inner", 20);
        throw new Error("abort all");
      });
    })).rejects.toThrow("abort all");

    await expect(db.one<{ count: number }>()`
      select count(*)::int as count from ${accountsTable()}
    `).resolves.toEqual({ count: 0 });
  });

  it("keeps concurrent transaction contexts isolated", async () => {
    await Promise.all([
      db.transaction(async () => {
        await db.accounts.create("first-a", 1);
        await Bun.sleep(25);
        await db.accounts.create("first-b", 2);
      }),
      db.transaction(async () => {
        await db.accounts.create("second-a", 3);
        await Bun.sleep(10);
        await db.accounts.create("second-b", 4);
      }),
    ]);

    const owners = await db.many<{ owner: string }>()`
      select owner from ${accountsTable()} order by owner
    `;
    expect(owners.map(({ owner }) => owner)).toEqual([
      "first-a",
      "first-b",
      "second-a",
      "second-b",
    ]);
  });

  it("applies isolation, read-only, and deferrable transaction options", async () => {
    const settings = await db.transaction(
      () => db.one<{ isolation: string; read_only: string; deferrable: string }>()`
        select
          current_setting('transaction_isolation') as isolation,
          current_setting('transaction_read_only') as read_only,
          current_setting('transaction_deferrable') as deferrable
      `,
      { isolationLevel: "serializable", readOnly: true, deferrable: true },
    );

    expect(settings).toEqual({
      isolation: "serializable",
      read_only: "on",
      deferrable: "on",
    });
  });

  it("rejects writes in a read-only transaction and remains usable afterward", async () => {
    await expect(db.transaction(
      () => db.accounts.create("forbidden", 1),
      { readOnly: true },
    )).rejects.toThrow(/read-only transaction/i);

    await expect(db.accounts.create("allowed", 1)).resolves.toMatchObject({ owner: "allowed" });
  });

  it("rejects async work that escapes its transaction callback", async () => {
    let escaped!: Promise<unknown>;
    await db.transaction(async () => {
      escaped = new Promise((resolve, reject) => {
        setTimeout(() => {
          db.one<{ value: number }>()`select 1 as value`.then(resolve, reject);
        }, 20);
      });
    });

    await expect(escaped).rejects.toBeInstanceOf(TransactionClosedError);
  });

  it("streams all rows in bounded batches", async () => {
    await db.execute(sql`
      insert into ${accountsTable()} (owner, balance)
      select 'account-' || value, value
      from generate_series(1, 75) as value
    `);
    const rows: Array<{ id: number; owner: string; balance: number }> = [];

    for await (const row of db.accounts.streamAll(7)) rows.push(row);

    expect(rows).toHaveLength(75);
    expect(rows[0]).toMatchObject({ owner: "account-1", balance: 1 });
    expect(rows.at(-1)).toMatchObject({ owner: "account-75", balance: 75 });
  });

  it("releases a cursor after an early stream break", async () => {
    await db.execute(sql`
      insert into ${accountsTable()} (owner, balance)
      select 'account-' || value, value
      from generate_series(1, 20) as value
    `);
    const seen: number[] = [];

    for await (const row of db.accounts.streamAll(2)) {
      seen.push(row.id);
      if (seen.length === 3) break;
    }

    expect(seen).toEqual([1, 2, 3]);
    await expect(db.one<{ value: number }>()`select 1 as value`).resolves.toEqual({ value: 1 });
  });

  it("streams on the active transaction and rolls all work back", async () => {
    await db.execute(sql`
      insert into ${accountsTable()} (owner, balance)
      select 'existing-' || value, value
      from generate_series(1, 3) as value
    `);

    await expect(db.transaction(async () => {
      await db.accounts.create("temporary", 99);
      const owners: string[] = [];
      for await (const row of db.accounts.streamAll(2)) owners.push(row.owner);
      expect(owners).toContain("temporary");
      throw new Error("rollback after stream");
    })).rejects.toThrow("rollback after stream");

    await expect(db.maybeOne<{ id: number }>()`
      select id from ${accountsTable()} where owner = ${"temporary"}
    `).resolves.toBeNull();
  });

  it("validates streamed rows and reports their position", async () => {
    await db.execute(sql`
      insert into ${accountsTable()} (owner, balance)
      values (${"valid"}, ${1}), (${"x"}, ${2})
    `);
    const Account = z.object({ owner: z.string().min(2), balance: z.number() });

    const consume = async () => {
      for await (const _row of db.stream(Account, { batchSize: 1 })`
        select owner, balance from ${accountsTable()} order by id
      `) {
        // Consume the complete cursor so validation reaches the invalid row.
      }
    };

    await expect(consume()).rejects.toMatchObject({
      rowIndex: 1,
    } satisfies Partial<RowValidationError>);
  });
});
