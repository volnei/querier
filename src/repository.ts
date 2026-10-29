import type { Querier } from "./client.js";

/**
 * Base class for application repositories.
 *
 * The database creates repository instances and supplies either the pool-backed
 * querier or the querier for the current transaction.
 */
export abstract class Repository {
  constructor(private readonly querier: Querier) {}

  protected many<Query extends Parameters<Querier["many"]>[0]>(query: Query) {
    return this.querier.many(query);
  }

  protected one<Query extends Parameters<Querier["one"]>[0]>(query: Query) {
    return this.querier.one(query);
  }

  protected maybeOne<Query extends Parameters<Querier["maybeOne"]>[0]>(query: Query) {
    return this.querier.maybeOne(query);
  }

  protected execute<Query extends Parameters<Querier["execute"]>[0]>(query: Query) {
    return this.querier.execute(query);
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
