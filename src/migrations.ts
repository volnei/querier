import type { PgPoolLike } from "./client.js";
import {
  createSqlFileRunner,
  type ApplySqlFilesOptions,
  type SqlFileRunnerOptions,
  type SqlFileStatus,
} from "./sql-file-runner.js";

export interface MigratorOptions extends SqlFileRunnerOptions {
  /** Directory containing ordered `<id>.sql` migration files. */
  readonly directory: string | URL;
}

export type MigrationStatus = SqlFileStatus;

export interface MigrateUpOptions extends ApplySqlFilesOptions {
  /** Apply through this migration id, inclusive. Omit to apply everything pending. */
  readonly to?: string;
}

export interface Migrator {
  status(): Promise<MigrationStatus>;
  up(options?: MigrateUpOptions): Promise<readonly string[]>;
}

export function createMigrator(pool: PgPoolLike, options: MigratorOptions): Migrator {
  const runner = createSqlFileRunner(pool, options, {
    singular: "migration",
    plural: "migrations",
    defaultTable: "_querier_migrations",
  });

  return Object.freeze({
    status: () => runner.status(),
    up: (upOptions?: MigrateUpOptions) => runner.apply(upOptions),
  });
}
