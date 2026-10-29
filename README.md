# querier

A minimal, typed layer for executing SQL directly with the [`pg`](https://node-postgres.com/) driver. It is not an ORM, does not track entity state, and does not introduce a separate query language.

## Installation

```sh
bun add querier pg
```

The project uses Bun 1.4 or newer for development, tests, examples, and CI. The published package is ESM-only and remains compatible with Node.js 20 or newer.

```ts
import { Pool } from "pg";
import { createDatabase, sql } from "querier";

const db = createDatabase(new Pool({ connectionString: process.env.DATABASE_URL }));

type User = {
  id: number;
  email: string;
};

const email = "ada@example.com";
const user = await db.maybeOne<User>()`
  select id, email
  from users
  where email = ${email}
`;
// User | null
```

Queries that return rows require a result type. Untyped SQL is accepted by `execute`, but rejected by `one`, `maybeOne`, and `many`:

```ts
const user = await db.maybeOne<User>()`
  select id, email
  from users
  where id = ${id}
`;

await db.execute`delete from sessions where expires_at < now()`;

// Prebuilt queries remain useful for composition and reuse.
const activeUsers = sql<User>`select id, email from users where active`;
const users = await db.many(activeUsers);
```

Every regular interpolation becomes a PostgreSQL parameter. For structural SQL, use only the explicit helpers:

```ts
const columns = [sql.identifier("id"), sql.identifier("email")];
const ids = [1, 2, 3];

const users = await db.many<User>()`
  select ${sql.join(columns)}
  from ${sql.identifier("users")}
  where id in (${sql.join(ids)})
`;
```

## API

- `db.many<Row>()\`...\`` returns `Row[]`.
- `db.one<Row>()\`...\`` returns `Row` and requires exactly one row.
- `db.maybeOne<Row>()\`...\`` returns `Row | null` and rejects more than one row.
- `db.tuples<Tuple>()\`...\``, `db.oneTuple<Tuple>()\`...\``, and `db.maybeTuple<Tuple>()\`...\`` use PostgreSQL array row mode.
- `db.stream<Row>()\`...\`` returns an `AsyncIterable<Row>` backed by a PostgreSQL cursor.
- `db.execute\`...\`` returns the original `pg` `QueryResult`.
- Object-row methods also accept a prebuilt `sql` query when composition or reuse is useful.
- `db.transaction(callback, options?)` uses a `PoolClient` with automatic commit/rollback and async context propagation.
- `sql.fragment`, `sql.identifier`, `sql.join`, and `sql.values` enable safe composition.

## Optional runtime row validation

`sql.type<Row>()` provides compile-time types with no runtime cost. Passing any parser with a `parse(value)` method also validates and transforms every returned row. Zod works without an adapter and remains an optional application dependency:

```sh
bun add zod
```

```ts
import { z } from "zod";

const AccountRow = z.object({
  id: z.string().transform(BigInt),
  balance: z.string(),
}).strict();

const account = await db.one(AccountRow)`
  select id, balance
  from accounts
  where id = ${id}
`;

// Inferred as { id: bigint; balance: string }
```

Validation happens after cardinality checks. `many` reports the failing row through `RowValidationError.rowIndex`, preserving the parser error as `cause`. Queries without a parser behave exactly as before.

## Tuples

Tuple methods use the native `pg` array row mode. They avoid allocating row objects, preserve duplicate column names, and retain positional labels in TypeScript:

```ts
const account = await db.oneTuple<
  [id: bigint, balance: string]
>()`
  select id, balance
  from accounts
  where id = ${id}
`;

const [accountId, balance] = account;
```

`tuples` returns every row and `maybeTuple` preserves the same zero-or-one cardinality guarantee as `maybeOne`. A tuple parser such as a Zod tuple infers, validates, and transforms every position:

```ts
const AccountTuple = z.tuple([
  z.string().transform(BigInt),
  z.string(),
]);

const accounts = await db.tuples(AccountTuple)`
  select id, balance from accounts
`;
```

## JSON parameters

`sql.json` serializes a strict `JsonValue` explicitly. This distinguishes JSON values from PostgreSQL values without guessing:

```ts
await db.execute`
  insert into events (payload)
  values (${sql.json({ type: "account.created", tags: ["billing"] })})
`;

sql.json(null);       // JSON null
null;                 // SQL NULL
sql.json([1, 2, 3]);  // JSON array
[1, 2, 3];            // PostgreSQL array
```

Use an explicit cast when PostgreSQL cannot infer the parameter type:

```ts
const result = await db.one<{ payload: unknown }>()`
  select ${sql.json(value, "jsonb")} as payload
`;
```

`JsonValue` excludes `undefined`, `bigint`, dates, class instances, functions, and symbols. Runtime checks also reject circular structures and non-finite numbers instead of silently changing their meaning. JSON and JSONB results are decoded by `pg` and can be validated deeply with the same Zod row parsers.

## Streaming large results

`stream` reads rows in bounded batches and validates each row as it is yielded. It uses the same typed tag style as the cardinality methods:

```ts
for await (const account of db.stream(AccountRow, { batchSize: 500 })`
  select id, balance
  from accounts
  where active
  order by id
`) {
  await processAccount(account);
}
```

Repositories expose the same primitive:

```ts
class AccountsRepository extends Repository {
  active() {
    return this.stream(AccountRow, { batchSize: 500 })`
      select id, balance
      from accounts
      where active
    `;
  }
}
```

The stream owns one checked-out client until iteration finishes. Breaking, returning, or throwing from `for await` closes the server cursor and releases that client. Inside `db.transaction`, it uses the active transaction client; consume the iterable before the transaction callback completes and do not run concurrent queries on that same transaction while its cursor is open.

## Repositories and transactions

Repositories extend the abstract `Repository` class. The library injects either the pool or transaction executor:

```ts
class AccountsRepository extends Repository {
  changeBalance(id: number, amount: number) {
    return this.one<Account>()`
      update accounts
      set balance = balance + ${amount}
      where id = ${id}
      returning id, balance
    `;
  }
}

const db = createDatabase(pool, {
  repositories: {
    accounts: AccountsRepository,
  },
  migrations: {
    directory: new URL("./migrations/", import.meta.url),
  },
});

// Outside a transaction, the repository uses the pool.
const account = await db.accounts.changeBalance(accountId, 10);

class TransferService {
  constructor(private readonly accounts: AccountsRepository) {}

  async transfer(sourceId: number, destinationId: number, amount: number) {
    await this.accounts.changeBalance(sourceId, -amount);
    await this.accounts.changeBalance(destinationId, amount);
  }
}

const transfers = new TransferService(db.accounts);

// AsyncLocalStorage routes every service query to the same PoolClient.
await db.transaction(() =>
  transfers.transfer(sourceId, destinationId, 100),
);
```

Repositories are instantiated lazily on first access and reused afterward. They resolve their executor when each query runs: the current transaction client when one exists, or the pool otherwise. This lets services keep a repository reference without accepting or forwarding a `tx` parameter.

The callback still receives `tx` for explicit usage and backward compatibility. `tx.accounts` and `db.accounts` refer to the same lazy repository. Nested `db.transaction()` calls join the current transaction; nested calls cannot change its options. Async work that attempts a query after the transaction callback completes is rejected with `TransactionClosedError` instead of using a released client. Repositories are exposed directly on the database; there is no `db.repositories` namespace.

## Schema and inferred types

The declarative schema is optional and is not involved in query execution. It is used to infer types, create snapshots, and generate migration SQL for review:

```ts
import {
  defineSchema,
  generateMigration,
  type InferDatabase,
} from "querier";

export const schema = defineSchema({
  users: {
    columns: {
      id: { type: "bigint", identity: true, primaryKey: true },
      tenant_id: { type: "uuid" },
      email: { type: "text" },
      created_at: { type: "timestamptz", default: "now()" },
      deleted_at: { type: "timestamptz", nullable: true },
    },
    indexes: {
      users_tenant_email_unique: {
        columns: ["tenant_id", "email"],
        unique: true,
      },
      users_active_email_idx: {
        expression: "lower(email)",
        where: "deleted_at is null",
        include: ["tenant_id"],
      },
    },
  },
} as const);

type Database = InferDatabase<typeof schema>;
type User = Database["users"]["row"];
type NewUser = Database["users"]["insert"];
type UserPatch = Database["users"]["update"];
```

The generator compares the previous snapshot with the desired state:

```ts
const plan = generateMigration(previousSnapshot, schema);

console.log(plan.sql);
console.log(plan.destructiveChanges);
const nextSnapshot = plan.snapshot;
```

The plan supports tables, columns, defaults, nullability, and indexes. Ambiguous changes to primary keys, identity columns, or column-level `unique` constraints are rejected and must be written manually. Generated SQL is never applied automatically.

## Migrations

Migrations are regular SQL files. There is no schema model, callback, or table DSL:

```text
migrations/
├── 001_create_users.sql
└── 002_create_posts.sql
```

```sql
-- migrations/001_create_users.sql
create table users (
  id bigint generated always as identity primary key,
  email text not null unique
);
```

```ts
await db.migrations.status(); // { applied, pending }
await db.migrations.up();     // applies every pending migration
```

Files are sorted lexicographically by name and executed in full. There are no `up` or `down` concepts, special comments, or custom language inside the SQL. To fix or revert a change, create a new SQL migration.

Each file runs in its own transaction. A PostgreSQL advisory lock prevents concurrent runs, and `public._querier_migrations` records the identifier and SHA-256 checksum of every applied file. If an applied file is edited, execution is rejected. `up({ to: "..." })` applies migrations through a specific identifier.

## Backfills

Backfills are controlled separately from schema migrations and are never run automatically. They use the same forward-only SQL file guarantees: lexical ordering, checksums, an advisory lock, and one transaction per file.

```text
backfills/
├── 001_normalize_emails.sql
└── 002_populate_account_slugs.sql
```

```ts
const db = createDatabase(pool, {
  migrations: {
    directory: new URL("./migrations/", import.meta.url),
  },
  backfills: {
    directory: new URL("./backfills/", import.meta.url),
    schema: "public",
    table: "_querier_backfills",
  },
});

await db.backfills.status();
await db.backfills.run();
await db.backfills.run({ to: "002_populate_account_slugs" });
```

`run()` executes every pending backfill exactly once and records it in `public._querier_backfills` by default. A changed checksum, an unknown database record, or a non-linear history stops execution. To correct a completed backfill, add a new SQL file instead of editing the original.

## Example

The [`example`](./example) directory contains a complete application with a SQL migration, a lazy repository, a transaction, and typed queries. Start PostgreSQL, then run:

```sh
export DATABASE_URL=postgres://postgres:postgres@localhost:5432/querier
bun run example
```

The example applies pending migrations and backfills, inserts a user inside a transaction, reads it through the repository, and verifies the result. The CI workflow runs this same example against the official minimal PostgreSQL Alpine image.

## What “typed” means here

The result type is declared alongside the SQL (`sql<User>`) and follows the query into the cardinality method. The SQL and its values are still passed directly to `pg`.

A standalone TypeScript tag cannot infer the columns returned by SQL text. Automatic result inference requires an additional step that reads the PostgreSQL schema and parses or validates the query. This can be added later as static generation without increasing the library's runtime footprint.

## Development and distribution

```sh
bun run check          # validates types
bun run lint           # runs Bun's native linter with zero warnings allowed
bun test               # runs the test suite
bun run test:integration # runs PostgreSQL integration tests (requires DATABASE_URL)
bun run build          # generates dist/
bun pm pack --dry-run  # shows exactly what will be included in the package
```

To test in another application before publishing, run `bun pm pack` and install the generated `.tgz` file in that application. The `prepack` hook always runs type checking, tests, and the build before packaging or publishing.

After choosing an available registry name and authenticating with the registry, make the first public release with `bun publish --access public`. For scoped packages, use a name such as `@your-org/querier`; `publishConfig` is already configured for public access.
