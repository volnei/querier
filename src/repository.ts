import type { QueryResult, QueryResultRow } from "pg";
import type { ExecutableQueryTag, Querier } from "./client.js";
import {
  isSqlQuery,
  type ParserOutput,
  type RowParser,
  type SqlInterpolation,
  type SqlQuery,
  type SqlStatement,
} from "./query.js";

type RowOf<Query> = Query extends SqlQuery<infer Row> ? Row : never;
type ExecutedRow<Query extends SqlStatement | SqlQuery> = Query extends SqlQuery<infer Row>
  ? Row & QueryResultRow
  : QueryResultRow;

/**
 * Base class for application repositories.
 *
 * The database creates repository instances and supplies either the pool-backed
 * querier or the querier for the current transaction.
 */
export abstract class Repository {
  constructor(private readonly querier: Querier) {}

  protected many<Query extends SqlQuery>(query: Query): Promise<RowOf<Query>[]>;
  protected many<Row extends object>(): ExecutableQueryTag<Row, Row[]>;
  protected many<Parser extends RowParser<object>>(
    parser: Parser,
  ): ExecutableQueryTag<ParserOutput<Parser>, ParserOutput<Parser>[]>;
  protected many(input?: SqlQuery | RowParser<object>) {
    if (isSqlQuery(input)) return this.querier.many(input as SqlQuery);
    if (input) return this.querier.many(input);
    return this.querier.many<object>();
  }

  protected one<Query extends SqlQuery>(query: Query): Promise<RowOf<Query>>;
  protected one<Row extends object>(): ExecutableQueryTag<Row, Row>;
  protected one<Parser extends RowParser<object>>(
    parser: Parser,
  ): ExecutableQueryTag<ParserOutput<Parser>, ParserOutput<Parser>>;
  protected one(input?: SqlQuery | RowParser<object>) {
    if (isSqlQuery(input)) return this.querier.one(input as SqlQuery);
    if (input) return this.querier.one(input);
    return this.querier.one<object>();
  }

  protected maybeOne<Query extends SqlQuery>(query: Query): Promise<RowOf<Query> | null>;
  protected maybeOne<Row extends object>(): ExecutableQueryTag<Row, Row | null>;
  protected maybeOne<Parser extends RowParser<object>>(
    parser: Parser,
  ): ExecutableQueryTag<ParserOutput<Parser>, ParserOutput<Parser> | null>;
  protected maybeOne(input?: SqlQuery | RowParser<object>) {
    if (isSqlQuery(input)) return this.querier.maybeOne(input as SqlQuery);
    if (input) return this.querier.maybeOne(input);
    return this.querier.maybeOne<object>();
  }

  protected execute<Query extends SqlStatement | SqlQuery>(
    query: Query,
  ): Promise<QueryResult<ExecutedRow<Query>>>;
  protected execute(
    strings: TemplateStringsArray,
    ...interpolations: readonly SqlInterpolation[]
  ): Promise<QueryResult<QueryResultRow>>;
  protected execute(
    input: SqlStatement | SqlQuery | TemplateStringsArray,
    ...interpolations: readonly SqlInterpolation[]
  ) {
    if (isSqlQuery(input)) return this.querier.execute(input);
    return this.querier.execute(input, ...interpolations);
  }
}

export type RepositoryClass<Instance extends Repository = Repository> = new (
  querier: Querier,
) => Instance;

export type RepositoryRegistry = Readonly<Record<string, RepositoryClass>>;

export type RepositoryInstances<Registry extends RepositoryRegistry> = {
  readonly [Name in keyof Registry]: InstanceType<Registry[Name]>;
};

export function createLazyRepositories<Registry extends RepositoryRegistry>(
  registry: Registry,
  querier: Querier,
): RepositoryInstances<Registry> {
  const instances = new Map<keyof Registry, Repository>();
  const repositories = {} as RepositoryInstances<Registry>;

  for (const name of Object.keys(registry) as Array<keyof Registry>) {
    Object.defineProperty(repositories, name, {
      enumerable: true,
      configurable: false,
      get() {
        const existing = instances.get(name);
        if (existing) return existing;

        const RepositoryType = registry[name];
        if (!RepositoryType) {
          throw new TypeError(`Unknown repository: ${String(name)}`);
        }

        const repository = new RepositoryType(querier);
        instances.set(name, repository);
        return repository;
      },
    });
  }

  return Object.freeze(repositories);
}
