import { AsyncLocalStorage } from "node:async_hooks";
import type { QueryResult, QueryResultRow } from "pg";
import {
  createBackfillManager,
  type BackfillManager,
  type BackfillOptions,
} from "./backfills.js";
import {
  NoRowsError,
  RowValidationError,
  TooManyRowsError,
  TransactionClosedError,
} from "./errors.js";
import { createMigrator, type Migrator, type MigratorOptions } from "./migrations.js";
import type { SqlQuery, SqlStatement } from "./query.js";
import {
  createLazyRepositories,
  type RepositoryInstances,
  type RepositoryRegistry,
} from "./repository.js";

export interface PgQueryable {
  query<Row extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<Row>>;
}

type RowOf<Query> = Query extends SqlQuery<infer Row> ? Row : never;
type PgRow<Query extends SqlQuery> = RowOf<Query> & QueryResultRow;
type ExecutedRow<Query extends SqlStatement | SqlQuery> = Query extends SqlQuery
  ? PgRow<Query>
  : QueryResultRow;

export interface Querier {
  many<Query extends SqlQuery>(query: Query): Promise<RowOf<Query>[]>;
  one<Query extends SqlQuery>(query: Query): Promise<RowOf<Query>>;
  maybeOne<Query extends SqlQuery>(query: Query): Promise<RowOf<Query> | null>;
  execute<Query extends SqlStatement | SqlQuery>(
    query: Query,
  ): Promise<QueryResult<ExecutedRow<Query>>>;
}

export function createQuerier(client: PgQueryable): Querier {
  const executeRows = <Query extends SqlQuery>(query: Query) =>
    client.query<PgRow<Query>>(query.text, query.values);

  function parseRow<Query extends SqlQuery>(
    query: Query,
    row: PgRow<Query>,
    rowIndex: number,
  ): RowOf<Query> {
    if (!query.parser) return row as RowOf<Query>;
    try {
      return query.parser.parse(row) as RowOf<Query>;
    } catch (cause) {
      throw new RowValidationError(rowIndex, cause);
    }
  }

  return Object.freeze({
    async many<Query extends SqlQuery>(query: Query): Promise<RowOf<Query>[]> {
      const result = await executeRows(query);
      return result.rows.map((row, index) => parseRow(query, row, index));
    },

    async one<Query extends SqlQuery>(query: Query): Promise<RowOf<Query>> {
      const result = await executeRows(query);
      if (result.rows.length === 0) throw new NoRowsError();
      if (result.rows.length > 1) throw new TooManyRowsError(result.rows.length);
      return parseRow(query, result.rows[0]!, 0);
    },

    async maybeOne<Query extends SqlQuery>(query: Query): Promise<RowOf<Query> | null> {
      const result = await executeRows(query);
      if (result.rows.length > 1) throw new TooManyRowsError(result.rows.length);
      return result.rows[0] ? parseRow(query, result.rows[0], 0) : null;
    },

    async execute<Query extends SqlStatement | SqlQuery>(
      query: Query,
    ): Promise<QueryResult<ExecutedRow<Query>>> {
      const result = await client.query<ExecutedRow<Query>>(query.text, query.values);
      if (!("parser" in query) || !query.parser) return result;
      return {
        ...result,
        rows: result.rows.map((row, index) =>
          parseRow(query, row as PgRow<Query & SqlQuery>, index),
        ) as ExecutedRow<Query>[],
      };
    },
  });
}

export interface TransactionOptions {
  readonly isolationLevel?:
    | "read uncommitted"
    | "read committed"
    | "repeatable read"
    | "serializable";
  readonly readOnly?: boolean;
  readonly deferrable?: boolean;
}

export interface PgPoolLike extends PgQueryable {
  connect(): Promise<PgTransactionClient>;
}

export interface PgTransactionClient extends PgQueryable {
  release(): void;
}

export type RepositoryTransaction<Repositories> = Querier & Repositories;

export interface Database extends Querier {
  transaction<T>(
    callback: (transaction: Querier) => Promise<T>,
    options?: TransactionOptions,
  ): Promise<T>;
}

export type RepositoryDatabase<Repositories> = Querier & Repositories & {
  transaction<T>(
    callback: (transaction: RepositoryTransaction<Repositories>) => Promise<T>,
    options?: TransactionOptions,
  ): Promise<T>;
};

export interface DatabaseWithMigrations {
  readonly migrations: Migrator;
}

export interface DatabaseWithBackfills {
  readonly backfills: BackfillManager;
}

export interface DatabaseConfig<Registry extends RepositoryRegistry = RepositoryRegistry> {
  readonly repositories?: Registry;
  readonly migrations?: MigratorOptions;
  readonly backfills?: BackfillOptions;
}

export type ConfiguredDatabase<Config extends DatabaseConfig> =
  (Config extends { readonly repositories: infer Registry extends RepositoryRegistry }
    ? RepositoryDatabase<RepositoryInstances<Registry>>
    : Database) &
  (Config extends { readonly migrations: MigratorOptions }
    ? DatabaseWithMigrations
    : object) &
  (Config extends { readonly backfills: BackfillOptions }
    ? DatabaseWithBackfills
    : object);

function beginStatement(options: TransactionOptions): string {
  const clauses = ["BEGIN"];
  if (options.isolationLevel) {
    clauses.push(`ISOLATION LEVEL ${options.isolationLevel.toUpperCase()}`);
  }
  if (options.readOnly !== undefined) clauses.push(options.readOnly ? "READ ONLY" : "READ WRITE");
  if (options.deferrable !== undefined) clauses.push(options.deferrable ? "DEFERRABLE" : "NOT DEFERRABLE");
  return clauses.join(" ");
}

const reservedRepositoryNames = new Set([
  "many",
  "one",
  "maybeOne",
  "execute",
  "transaction",
  "migrations",
  "backfills",
]);

function assertRepositoryNames(registry: RepositoryRegistry | undefined): void {
  if (!registry) return;
  for (const name of Object.keys(registry)) {
    if (reservedRepositoryNames.has(name)) {
      throw new TypeError(`Repository name is reserved: ${name}`);
    }
  }
}

function attachRepositories<Target extends object, Repositories extends object>(
  target: Target,
  repositories: Repositories,
): Target & Repositories {
  Object.defineProperties(target, Object.getOwnPropertyDescriptors(repositories));
  return target as Target & Repositories;
}

interface TransactionContext {
  readonly client: PgTransactionClient;
  active: boolean;
}

function hasTransactionOptions(options: TransactionOptions): boolean {
  return Object.keys(options).length > 0;
}

export function createDatabase(pool: PgPoolLike): Database;
export function createDatabase<const Config extends DatabaseConfig>(
  pool: PgPoolLike,
  config: Config,
): ConfiguredDatabase<Config>;
export function createDatabase<Registry extends RepositoryRegistry>(
  pool: PgPoolLike,
  config?: DatabaseConfig<Registry>,
): object {
  const transactionStorage = new AsyncLocalStorage<TransactionContext>();
  const contextualClient: PgQueryable = {
    query<Row extends QueryResultRow = QueryResultRow>(
      text: string,
      values?: readonly unknown[],
    ): Promise<QueryResult<Row>> {
      const context = transactionStorage.getStore();
      if (context && !context.active) throw new TransactionClosedError();
      return (context?.client ?? pool).query<Row>(text, values);
    },
  };
  const querier = createQuerier(contextualClient);
  const registry = config?.repositories;
  assertRepositoryNames(registry);
  const repositories = registry ? createLazyRepositories(registry, querier) : undefined;
  const transactionView = Object.freeze(
    repositories
      ? attachRepositories({ ...querier }, repositories)
      : querier,
  );

  const database = {
    ...querier,
    async transaction<T>(
      callback: (
        transaction:
          | Querier
          | RepositoryTransaction<RepositoryInstances<Registry>>
      ) => Promise<T>,
      options: TransactionOptions = {},
    ): Promise<T> {
      const existingContext = transactionStorage.getStore();
      if (existingContext) {
        if (!existingContext.active) throw new TransactionClosedError();
        if (hasTransactionOptions(options)) {
          throw new TypeError("Nested transactions cannot change transaction options");
        }
        return callback(transactionView);
      }

      const client = await pool.connect();
      const context: TransactionContext = { client, active: true };
      try {
        await client.query(beginStatement(options));
        const value = await transactionStorage.run(context, () => callback(transactionView));
        context.active = false;
        await client.query("COMMIT");
        return value;
      } catch (error) {
        context.active = false;
        await client.query("ROLLBACK");
        throw error;
      } finally {
        context.active = false;
        client.release();
      }
    },
  };

  const result = {
    ...database,
    ...(config?.migrations
      ? { migrations: createMigrator(pool, config.migrations) }
      : {}),
    ...(config?.backfills
      ? { backfills: createBackfillManager(pool, config.backfills) }
      : {}),
  };

  return Object.freeze(
    repositories ? attachRepositories(result, repositories) : result,
  );
}
