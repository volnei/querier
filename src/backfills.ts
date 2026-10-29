import type { PgPoolLike } from "./client.js";
import {
  createSqlFileRunner,
  type ApplySqlFilesOptions,
  type SqlFileRunnerOptions,
  type SqlFileStatus,
} from "./sql-file-runner.js";

export interface BackfillOptions extends SqlFileRunnerOptions {
  /** Directory containing ordered `<id>.sql` backfill files. */
  readonly directory: string | URL;
}

export type BackfillStatus = SqlFileStatus;

export interface RunBackfillsOptions extends ApplySqlFilesOptions {
  /** Run through this backfill id, inclusive. Omit to run everything pending. */
  readonly to?: string;
}

export interface BackfillManager {
  status(): Promise<BackfillStatus>;
  run(options?: RunBackfillsOptions): Promise<readonly string[]>;
}

export function createBackfillManager(
  pool: PgPoolLike,
  options: BackfillOptions,
): BackfillManager {
  const runner = createSqlFileRunner(pool, options, {
    singular: "backfill",
    plural: "backfills",
    defaultTable: "_querier_backfills",
  });

  return Object.freeze({
    status: () => runner.status(),
    run: (runOptions?: RunBackfillsOptions) => runner.apply(runOptions),
  });
}
