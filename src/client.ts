import { AsyncLocalStorage } from "node:async_hooks";
import { finished } from "node:stream/promises";
import type { QueryResult, QueryResultRow } from "pg";
import QueryStream from "pg-query-stream";
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
import {
  isSqlQuery,
  sql,
  type ParserOutput,
  type RowParser,
  type SqlInterpolation,
  type SqlQuery,
  type SqlStatement,
} from "./query.js";
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

export interface ExecutableQueryTag<_Row extends object, Result> {
  (
    strings: TemplateStringsArray,
    ...interpolations: readonly SqlInterpolation[]
  ): Promise<Result>;
}

export interface ExecutableStreamTag<Row extends object> {
  (
    strings: TemplateStringsArray,
    ...interpolations: readonly SqlInterpolation[]
  ): AsyncIterable<Row>;
}

export interface StreamOptions {
  readonly batchSize?: number;
}

export interface Querier {
  many<Query extends SqlQuery>(query: Query): Promise<RowOf<Query>[]>;
  many<Row extends object>(): ExecutableQueryTag<Row, Row[]>;
  many<Parser extends RowParser<object>>(
    parser: Parser,
  ): ExecutableQueryTag<ParserOutput<Parser>, ParserOutput<Parser>[]>;

  one<Query extends SqlQuery>(query: Query): Promise<RowOf<Query>>;
  one<Row extends object>(): ExecutableQueryTag<Row, Row>;
  one<Parser extends RowParser<object>>(
    parser: Parser,
  ): ExecutableQueryTag<ParserOutput<Parser>, ParserOutput<Parser>>;

  maybeOne<Query extends SqlQuery>(query: Query): Promise<RowOf<Query> | null>;
  maybeOne<Row extends object>(): ExecutableQueryTag<Row, Row | null>;
  maybeOne<Parser extends RowParser<object>>(
    parser: Parser,
  ): ExecutableQueryTag<ParserOutput<Parser>, ParserOutput<Parser> | null>;

  tuples<Row extends readonly unknown[]>(): ExecutableQueryTag<Row, Row[]>;
  tuples<Parser extends RowParser<readonly unknown[]>>(
    parser: Parser,
  ): ExecutableQueryTag<ParserOutput<Parser>, ParserOutput<Parser>[]>;

  oneTuple<Row extends readonly unknown[]>(): ExecutableQueryTag<Row, Row>;
  oneTuple<Parser extends RowParser<readonly unknown[]>>(
    parser: Parser,
  ): ExecutableQueryTag<ParserOutput<Parser>, ParserOutput<Parser>>;

  maybeTuple<Row extends readonly unknown[]>(): ExecutableQueryTag<Row, Row | null>;
  maybeTuple<Parser extends RowParser<readonly unknown[]>>(
    parser: Parser,
  ): ExecutableQueryTag<ParserOutput<Parser>, ParserOutput<Parser> | null>;

  stream<Query extends SqlQuery>(
    query: Query,
    options?: StreamOptions,
  ): AsyncIterable<RowOf<Query>>;
  stream<Row extends object>(options?: StreamOptions): ExecutableStreamTag<Row>;
  stream<Parser extends RowParser<object>>(
    parser: Parser,
    options?: StreamOptions,
  ): ExecutableStreamTag<ParserOutput<Parser>>;

  execute<Query extends SqlStatement | SqlQuery>(
    query: Query,
  ): Promise<QueryResult<ExecutedRow<Query>>>;
  execute(
    strings: TemplateStringsArray,
    ...interpolations: readonly SqlInterpolation[]
  ): Promise<QueryResult<QueryResultRow>>;
}

interface PgStreamClient {
  query<Row extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<Row>>;
  query(stream: QueryStream): QueryStream;
}

interface PgArrayQueryable {
  query<Row extends readonly unknown[]>(config: {
    readonly text: string;
    readonly values: readonly unknown[];
    readonly rowMode: "array";
  }): Promise<{ readonly rows: Row[] }>;
}

interface StreamClientLease {
  readonly client: PgStreamClient;
  release(): void;
}

type AcquireStreamClient = () => Promise<StreamClientLease>;

function isPoolLike(client: PgQueryable): client is PgPoolLike {
  return "connect" in client && typeof client.connect === "function";
}

function isRowParser(value: unknown): value is RowParser<object> {
  return (
    typeof value === "object" &&
    value !== null &&
    "parse" in value &&
    typeof value.parse === "function"
  );
}

function defaultStreamClient(client: PgQueryable): AcquireStreamClient {
  return async () => {
    if (isPoolLike(client)) {
      const poolClient = await client.connect();
      return {
        client: poolClient as unknown as PgStreamClient,
        release: () => poolClient.release(),
      };
    }

    return {
      client: client as PgStreamClient,
      release() {},
    };
  };
}

export function createQuerier(client: PgQueryable): Querier {
  return createQuerierInternal(client, defaultStreamClient(client));
}

function createQuerierInternal(
  client: PgQueryable,
  acquireStreamClient: AcquireStreamClient,
): Querier {
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

  async function runMany<Query extends SqlQuery>(query: Query): Promise<RowOf<Query>[]> {
    const result = await executeRows(query);
    return result.rows.map((row, index) => parseRow(query, row, index));
  }

  async function runOne<Query extends SqlQuery>(query: Query): Promise<RowOf<Query>> {
    const result = await executeRows(query);
    if (result.rows.length === 0) throw new NoRowsError();
    if (result.rows.length > 1) throw new TooManyRowsError(result.rows.length);
    return parseRow(query, result.rows[0]!, 0);
  }

  async function runMaybeOne<Query extends SqlQuery>(
    query: Query,
  ): Promise<RowOf<Query> | null> {
    const result = await executeRows(query);
    if (result.rows.length > 1) throw new TooManyRowsError(result.rows.length);
    return result.rows[0] ? parseRow(query, result.rows[0], 0) : null;
  }

  const executableTag = <Row extends object, Result>(
    parser: RowParser<Row> | undefined,
    run: (query: SqlQuery<Row>) => Promise<Result>,
  ): ExecutableQueryTag<Row, Result> => {
    const typedSql = parser ? sql.type(parser) : sql.type<Row>();
    return (strings, ...interpolations) => run(typedSql(strings, ...interpolations));
  };

  function many<Query extends SqlQuery>(query: Query): Promise<RowOf<Query>[]>;
  function many<Row extends object>(): ExecutableQueryTag<Row, Row[]>;
  function many<Parser extends RowParser<object>>(
    parser: Parser,
  ): ExecutableQueryTag<ParserOutput<Parser>, ParserOutput<Parser>[]>;
  function many(
    input?: SqlQuery | RowParser<object>,
  ): Promise<object[]> | ExecutableQueryTag<object, object[]> {
    if (isSqlQuery(input)) return runMany(input as SqlQuery);
    return executableTag(input, runMany);
  }

  function one<Query extends SqlQuery>(query: Query): Promise<RowOf<Query>>;
  function one<Row extends object>(): ExecutableQueryTag<Row, Row>;
  function one<Parser extends RowParser<object>>(
    parser: Parser,
  ): ExecutableQueryTag<ParserOutput<Parser>, ParserOutput<Parser>>;
  function one(
    input?: SqlQuery | RowParser<object>,
  ): Promise<object> | ExecutableQueryTag<object, object> {
    if (isSqlQuery(input)) return runOne(input as SqlQuery);
    return executableTag(input, runOne);
  }

  function maybeOne<Query extends SqlQuery>(query: Query): Promise<RowOf<Query> | null>;
  function maybeOne<Row extends object>(): ExecutableQueryTag<Row, Row | null>;
  function maybeOne<Parser extends RowParser<object>>(
    parser: Parser,
  ): ExecutableQueryTag<ParserOutput<Parser>, ParserOutput<Parser> | null>;
  function maybeOne(
    input?: SqlQuery | RowParser<object>,
  ): Promise<object | null> | ExecutableQueryTag<object, object | null> {
    if (isSqlQuery(input)) return runMaybeOne(input as SqlQuery);
    return executableTag(input, runMaybeOne);
  }

  const arrayClient = client as unknown as PgArrayQueryable;

  function parseTuple<Row extends readonly unknown[]>(
    parser: RowParser<Row> | undefined,
    row: unknown,
    rowIndex: number,
  ): Row {
    if (!parser) return row as Row;
    try {
      return parser.parse(row);
    } catch (cause) {
      throw new RowValidationError(rowIndex, cause);
    }
  }

  async function executeTuples<Row extends readonly unknown[]>(
    query: SqlQuery<Row>,
  ): Promise<Row[]> {
    const result = await arrayClient.query<Row>({
      text: query.text,
      values: query.values,
      rowMode: "array",
    });
    return result.rows.map((row, index) => parseTuple(query.parser, row, index));
  }

  const executableTupleTag = <Row extends readonly unknown[], Result>(
    parser: RowParser<Row> | undefined,
    run: (query: SqlQuery<Row>) => Promise<Result>,
  ): ExecutableQueryTag<Row, Result> => {
    const typedSql = parser ? sql.type(parser) : sql.type<Row>();
    return (strings, ...interpolations) => run(typedSql(strings, ...interpolations));
  };

  function tuples<Row extends readonly unknown[]>(): ExecutableQueryTag<Row, Row[]>;
  function tuples<Parser extends RowParser<readonly unknown[]>>(
    parser: Parser,
  ): ExecutableQueryTag<ParserOutput<Parser>, ParserOutput<Parser>[]>;
  function tuples(
    parser?: RowParser<readonly unknown[]>,
  ): ExecutableQueryTag<readonly unknown[], Array<readonly unknown[]>> {
    return executableTupleTag(parser, executeTuples);
  }

  function oneTuple<Row extends readonly unknown[]>(): ExecutableQueryTag<Row, Row>;
  function oneTuple<Parser extends RowParser<readonly unknown[]>>(
    parser: Parser,
  ): ExecutableQueryTag<ParserOutput<Parser>, ParserOutput<Parser>>;
  function oneTuple(
    parser?: RowParser<readonly unknown[]>,
  ): ExecutableQueryTag<readonly unknown[], readonly unknown[]> {
    return executableTupleTag(parser, async (query) => {
      const rows = await executeTuples(query);
      if (rows.length === 0) throw new NoRowsError();
      if (rows.length > 1) throw new TooManyRowsError(rows.length);
      return rows[0]!;
    });
  }

  function maybeTuple<Row extends readonly unknown[]>(): ExecutableQueryTag<
    Row,
    Row | null
  >;
  function maybeTuple<Parser extends RowParser<readonly unknown[]>>(
    parser: Parser,
  ): ExecutableQueryTag<ParserOutput<Parser>, ParserOutput<Parser> | null>;
  function maybeTuple(
    parser?: RowParser<readonly unknown[]>,
  ): ExecutableQueryTag<readonly unknown[], readonly unknown[] | null> {
    return executableTupleTag(parser, async (query) => {
      const rows = await executeTuples(query);
      if (rows.length > 1) throw new TooManyRowsError(rows.length);
      return rows[0] ?? null;
    });
  }

  function validateStreamOptions(options: StreamOptions): void {
    if (
      options.batchSize !== undefined &&
      (!Number.isInteger(options.batchSize) || options.batchSize < 1)
    ) {
      throw new TypeError("stream batchSize must be a positive integer");
    }
  }

  async function* runStream<Query extends SqlQuery>(
    query: Query,
    options: StreamOptions,
  ): AsyncIterable<RowOf<Query>> {
    validateStreamOptions(options);
    const lease = await acquireStreamClient();
    const queryStream = new QueryStream(query.text, [...query.values], {
      ...(options.batchSize === undefined ? {} : { batchSize: options.batchSize }),
    });
    let rowIndex = 0;

    try {
      const rows = lease.client.query(queryStream) as AsyncIterable<PgRow<Query>>;
      for await (const row of rows) {
        yield parseRow(query, row, rowIndex);
        rowIndex += 1;
      }
    } finally {
      const closed = finished(queryStream, { cleanup: true });
      if (!queryStream.destroyed) queryStream.destroy();
      await closed.catch(() => undefined);
      lease.release();
    }
  }

  const executableStreamTag = <Row extends object>(
    parser: RowParser<Row> | undefined,
    options: StreamOptions,
  ): ExecutableStreamTag<Row> => {
    validateStreamOptions(options);
    const typedSql = parser ? sql.type(parser) : sql.type<Row>();
    return (strings, ...interpolations) =>
      runStream(typedSql(strings, ...interpolations), options);
  };

  function stream<Query extends SqlQuery>(
    query: Query,
    options?: StreamOptions,
  ): AsyncIterable<RowOf<Query>>;
  function stream<Row extends object>(options?: StreamOptions): ExecutableStreamTag<Row>;
  function stream<Parser extends RowParser<object>>(
    parser: Parser,
    options?: StreamOptions,
  ): ExecutableStreamTag<ParserOutput<Parser>>;
  function stream(
    input?: SqlQuery | RowParser<object> | StreamOptions,
    options: StreamOptions = {},
  ): AsyncIterable<object> | ExecutableStreamTag<object> {
    if (isSqlQuery(input)) return runStream(input as SqlQuery, options);
    if (isRowParser(input)) {
      return executableStreamTag(input, options);
    }
    return executableStreamTag(undefined, (input as StreamOptions | undefined) ?? {});
  }

  async function runExecute<Query extends SqlStatement | SqlQuery>(
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
  }

  function execute<Query extends SqlStatement | SqlQuery>(
    query: Query,
  ): Promise<QueryResult<ExecutedRow<Query>>>;
  function execute(
    strings: TemplateStringsArray,
    ...interpolations: readonly SqlInterpolation[]
  ): Promise<QueryResult<QueryResultRow>>;
  function execute(
    input: SqlStatement | SqlQuery | TemplateStringsArray,
    ...interpolations: readonly SqlInterpolation[]
  ): Promise<QueryResult<QueryResultRow>> {
    const query = isSqlQuery(input) ? input : sql(input, ...interpolations);
    return runExecute(query);
  }

  return Object.freeze({
    many,
    one,
    maybeOne,
    tuples,
    oneTuple,
    maybeTuple,
    stream,
    execute,
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
  "tuples",
  "oneTuple",
  "maybeTuple",
  "stream",
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
  const querier = createQuerierInternal(contextualClient, async () => {
    const context = transactionStorage.getStore();
    if (context && !context.active) throw new TransactionClosedError();
    if (context) {
      return {
        client: context.client as unknown as PgStreamClient,
        release() {},
      };
    }

    const client = await pool.connect();
    return {
      client: client as unknown as PgStreamClient,
      release: () => client.release(),
    };
  });
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
