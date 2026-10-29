#!/usr/bin/env bun
import { relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { checkQueries } from "./checker.js";
import type { SchemaDefinition } from "./schema.js";

interface CliOptions {
  readonly paths: string[];
  readonly databaseUrl?: string;
  readonly schemaFile?: string;
  readonly searchPath?: string;
  readonly json: boolean;
}

function usage(): string {
  return `Usage: querier check [paths...] [options]

Checks tagged SQL without executing mutations. PostgreSQL is the source of truth.

Options:
  --database-url <url>  PostgreSQL connection URL (defaults to DATABASE_URL)
  --schema <file>       Limited offline check using an exported Querier schema
  --search-path <name>  PostgreSQL schema placed first in search_path
  --json                Print machine-readable output
  --help                Show this help
`;
}

function valueAfter(args: readonly string[], index: number, option: string): string {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new TypeError(`${option} requires a value`);
  return value;
}

function parseArgs(args: readonly string[]): CliOptions {
  if (args[0] !== "check") throw new TypeError(usage());
  const paths: string[] = [];
  let databaseUrl: string | undefined;
  let schemaFile: string | undefined;
  let searchPath: string | undefined;
  let json = false;

  for (let index = 1; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--help") {
      console.log(usage());
      process.exit(0);
    }
    if (argument === "--json") {
      json = true;
      continue;
    }
    if (argument === "--database-url") {
      databaseUrl = valueAfter(args, index, argument);
      index += 1;
      continue;
    }
    if (argument === "--schema") {
      schemaFile = valueAfter(args, index, argument);
      index += 1;
      continue;
    }
    if (argument === "--search-path") {
      searchPath = valueAfter(args, index, argument);
      index += 1;
      continue;
    }
    if (argument.startsWith("--")) throw new TypeError(`Unknown option: ${argument}`);
    paths.push(argument);
  }
  return {
    paths: paths.length > 0 ? paths : ["src"],
    ...(databaseUrl ? { databaseUrl } : {}),
    ...(schemaFile ? { schemaFile } : {}),
    ...(searchPath ? { searchPath } : {}),
    json,
  };
}

async function loadSchema(file: string): Promise<SchemaDefinition> {
  const module = await import(pathToFileURL(resolve(file)).href) as {
    readonly default?: SchemaDefinition;
    readonly schema?: SchemaDefinition;
  };
  const schema = module.default ?? module.schema;
  if (!schema) throw new TypeError(`${file} must export default or a named export called schema`);
  return schema;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const databaseUrl = options.databaseUrl ?? process.env.DATABASE_URL;
  const schema = !databaseUrl && options.schemaFile
    ? await loadSchema(options.schemaFile)
    : undefined;
  if (!databaseUrl && !schema) {
    throw new TypeError("Set DATABASE_URL, pass --database-url, or pass --schema for limited offline checks");
  }

  const result = await checkQueries({
    paths: options.paths,
    ...(databaseUrl ? { databaseUrl } : {}),
    ...(schema ? { schema } : {}),
    ...(options.searchPath ? { searchPath: options.searchPath } : {}),
  });

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    for (const item of result.diagnostics) {
      const file = relative(process.cwd(), item.file) || item.file;
      console.error(`${file}:${item.line}:${item.column} ${item.severity} ${item.message}`);
    }
    const errors = result.diagnostics.filter(({ severity }) => severity === "error").length;
    const warnings = result.diagnostics.length - errors;
    console.log(`Checked ${result.checked} queries (${errors} errors, ${warnings} warnings, ${result.skipped} skipped)`);
  }

  if (result.diagnostics.some(({ severity }) => severity === "error")) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
