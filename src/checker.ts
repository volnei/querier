import { readdir, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { Pool, type FieldDef } from "pg";
import * as ts from "typescript";
import type { SchemaDefinition } from "./schema.js";

export type CheckSeverity = "error" | "warning";

export interface QueryCheckDiagnostic {
  readonly severity: CheckSeverity;
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly message: string;
}

export interface QueryCheckResult {
  readonly checked: number;
  readonly skipped: number;
  readonly diagnostics: readonly QueryCheckDiagnostic[];
}

export interface QueryCheckOptions {
  readonly paths?: readonly string[];
  readonly cwd?: string;
  readonly databaseUrl?: string;
  readonly schema?: SchemaDefinition;
  readonly searchPath?: string;
}

interface ExpectedShape {
  readonly kind: "object" | "tuple";
  readonly columns: readonly string[];
}

interface ExtractedQuery {
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly text: string;
  readonly parameterCount: number;
  readonly expected?: ExpectedShape;
}

interface CompileState {
  parameterCount: number;
  readonly bindings: ReadonlyMap<string, ts.Expression>;
}

const queryMethods = new Set([
  "many",
  "one",
  "maybeOne",
  "tuples",
  "oneTuple",
  "maybeTuple",
  "stream",
]);

const ignoredDirectories = new Set(["node_modules", "dist", ".git", "coverage"]);

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function propertyName(expression: ts.Expression): string | undefined {
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  if (
    ts.isElementAccessExpression(expression) &&
    expression.argumentExpression &&
    ts.isStringLiteral(expression.argumentExpression)
  ) {
    return expression.argumentExpression.text;
  }
  return undefined;
}

function isSqlProperty(expression: ts.Expression, name: string): boolean {
  return (
    ts.isPropertyAccessExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    expression.expression.text === "sql" &&
    expression.name.text === name
  );
}

function stringLiteral(expression: ts.Expression): string | undefined {
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
    return expression.text;
  }
  return undefined;
}

function parameter(state: CompileState, cast?: string): string {
  state.parameterCount += 1;
  return `$${state.parameterCount}${cast ? `::${cast}` : ""}`;
}

function compileSqlExpression(expression: ts.Expression, state: CompileState): string {
  if (ts.isIdentifier(expression)) {
    const binding = state.bindings.get(expression.text);
    if (binding) return compileSqlExpression(binding, state);
  }
  if (isSqlProperty(expression, "empty")) return "";

  if (ts.isCallExpression(expression) && isSqlProperty(expression.expression, "identifier")) {
    const parts = expression.arguments.map(stringLiteral);
    if (parts.length > 0 && parts.every((part) => part !== undefined)) {
      return (parts as string[]).map(quoteIdentifier).join(".");
    }
  }

  if (ts.isCallExpression(expression) && isSqlProperty(expression.expression, "json")) {
    const type = expression.arguments[1] && stringLiteral(expression.arguments[1]);
    return parameter(state, type === "json" || type === "jsonb" ? type : undefined);
  }

  if (
    ts.isTaggedTemplateExpression(expression) &&
    isSqlProperty(expression.tag, "fragment")
  ) {
    return compileTemplate(expression.template, state);
  }

  if (ts.isCallExpression(expression) && isSqlProperty(expression.expression, "join")) {
    const items = expression.arguments[0];
    const separatorExpression = expression.arguments[1];
    if (items && ts.isArrayLiteralExpression(items)) {
      let separator = ", ";
      if (
        separatorExpression &&
        ts.isTaggedTemplateExpression(separatorExpression) &&
        isSqlProperty(separatorExpression.tag, "fragment")
      ) {
        const separatorState: CompileState = {
          parameterCount: 0,
          bindings: state.bindings,
        };
        const compiled = compileTemplate(separatorExpression.template, separatorState);
        if (separatorState.parameterCount === 0) separator = compiled;
      }
      return items.elements
        .map((item) => compileSqlExpression(item as ts.Expression, state))
        .join(separator);
    }
  }

  if (ts.isCallExpression(expression) && isSqlProperty(expression.expression, "values")) {
    const rows = expression.arguments[0];
    if (rows && ts.isArrayLiteralExpression(rows)) {
      const tuples: string[] = [];
      for (const row of rows.elements) {
        if (!ts.isArrayLiteralExpression(row)) return parameter(state);
        tuples.push(`(${row.elements.map(() => parameter(state)).join(", ")})`);
      }
      if (tuples.length > 0) return tuples.join(", ");
    }
  }

  return parameter(state);
}

function compileTemplate(template: ts.TemplateLiteral, state: CompileState): string {
  if (ts.isNoSubstitutionTemplateLiteral(template)) return template.text;

  let text = template.head.text;
  for (const span of template.templateSpans) {
    text += compileSqlExpression(span.expression, state);
    text += span.literal.text;
  }
  return text;
}

function explicitTypeNode(
  node: ts.TaggedTemplateExpression,
  preparedTags: ReadonlyMap<string, ts.CallExpression>,
): ts.TypeNode | undefined {
  if (node.typeArguments?.[0]) return node.typeArguments[0];
  if (ts.isCallExpression(node.tag)) return node.tag.typeArguments?.[0];
  if (ts.isIdentifier(node.tag)) return preparedTags.get(node.tag.text)?.typeArguments?.[0];
  return undefined;
}

function isQueryTag(
  node: ts.TaggedTemplateExpression,
  preparedTags: ReadonlyMap<string, ts.CallExpression>,
): boolean {
  if (ts.isIdentifier(node.tag)) {
    return node.tag.text === "sql" || preparedTags.has(node.tag.text);
  }
  if (isSqlProperty(node.tag, "fragment")) return false;
  if (ts.isPropertyAccessExpression(node.tag)) {
    return node.tag.name.text === "execute";
  }
  if (!ts.isCallExpression(node.tag)) return false;
  const name = propertyName(node.tag.expression);
  if (name && queryMethods.has(name)) return true;
  return (
    isSqlProperty(node.tag.expression, "type") ||
    isSqlProperty(node.tag.expression, "prepare")
  );
}

function expectedShape(
  node: ts.TypeNode | undefined,
  checker: ts.TypeChecker,
): ExpectedShape | undefined {
  if (!node) return undefined;
  const type = checker.getTypeFromTypeNode(node);
  if (checker.isTupleType(type)) {
    const tuple = type as ts.TupleType;
    return { kind: "tuple", columns: checker.getTypeArguments(tuple).map((_, index) => String(index)) };
  }
  const columns = checker
    .getPropertiesOfType(type)
    .filter((property) => !property.name.startsWith("__@"))
    .map((property) => property.name);
  return columns.length > 0 ? { kind: "object", columns } : undefined;
}

function isStructuralExpression(expression: ts.Expression): boolean {
  if (isSqlProperty(expression, "empty")) return true;
  if (ts.isTaggedTemplateExpression(expression)) {
    return isSqlProperty(expression.tag, "fragment");
  }
  if (!ts.isCallExpression(expression)) return false;
  return ["identifier", "join", "values", "json"].some((name) =>
    isSqlProperty(expression.expression, name)
  );
}

function structuralBindings(source: ts.SourceFile): ReadonlyMap<string, ts.Expression> {
  const bindings = new Map<string, ts.Expression>();
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      isStructuralExpression(node.initializer)
    ) {
      bindings.set(node.name.text, node.initializer);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return bindings;
}

function preparedTagBindings(
  source: ts.SourceFile,
): ReadonlyMap<string, ts.CallExpression> {
  const bindings = new Map<string, ts.CallExpression>();
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isCallExpression(node.initializer) &&
      isSqlProperty(node.initializer.expression, "prepare")
    ) {
      bindings.set(node.name.text, node.initializer);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return bindings;
}

function extractQueries(files: readonly string[]): readonly ExtractedQuery[] {
  const program = ts.createProgram({
    rootNames: [...files],
    options: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      strict: true,
      skipLibCheck: true,
    },
  });
  const checker = program.getTypeChecker();
  const queries: ExtractedQuery[] = [];

  for (const file of files) {
    const source = program.getSourceFile(file);
    if (!source) continue;
    const bindings = structuralBindings(source);
    const preparedTags = preparedTagBindings(source);

    const visit = (node: ts.Node): void => {
      if (ts.isTaggedTemplateExpression(node) && isQueryTag(node, preparedTags)) {
        const state: CompileState = { parameterCount: 0, bindings };
        const location = source.getLineAndCharacterOfPosition(node.getStart(source));
        const expected = expectedShape(explicitTypeNode(node, preparedTags), checker);
        queries.push({
          file,
          line: location.line + 1,
          column: location.character + 1,
          text: compileTemplate(node.template, state),
          parameterCount: state.parameterCount,
          ...(expected ? { expected } : {}),
        });
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return queries;
}

async function sourceFiles(path: string): Promise<readonly string[]> {
  const info = await stat(path);
  if (info.isFile()) return /\.[cm]?[jt]sx?$/.test(path) ? [path] : [];
  if (!info.isDirectory()) return [];

  const files: string[] = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const child = resolve(path, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(child));
    else if (/\.[cm]?[jt]sx?$/.test(entry.name) && !entry.name.endsWith(".d.ts")) files.push(child);
  }
  return files;
}

async function collectFiles(paths: readonly string[], cwd: string): Promise<readonly string[]> {
  const files = await Promise.all(paths.map((path) => sourceFiles(resolve(cwd, path))));
  return [...new Set(files.flat())].sort();
}

function diagnostic(
  query: ExtractedQuery,
  severity: CheckSeverity,
  message: string,
): QueryCheckDiagnostic {
  return {
    severity,
    file: query.file,
    line: query.line,
    column: query.column,
    message,
  };
}

function statementKind(text: string): string | undefined {
  return text.match(/^\s*(?:\/\*[\s\S]*?\*\/\s*|--[^\n]*\n\s*)*([a-z]+)/i)?.[1]?.toLowerCase();
}

function compareColumns(
  query: ExtractedQuery,
  fields: readonly FieldDef[],
): readonly QueryCheckDiagnostic[] {
  if (!query.expected) return [];
  if (query.expected.kind === "tuple") {
    return fields.length === query.expected.columns.length
      ? []
      : [diagnostic(
          query,
          "error",
          `Tuple declares ${query.expected.columns.length} positions, but PostgreSQL returns ${fields.length}`,
        )];
  }

  const actual = fields.map(({ name }) => name);
  const expected = new Set(query.expected.columns);
  const actualSet = new Set(actual);
  const missing = query.expected.columns.filter((name) => !actualSet.has(name));
  const extra = actual.filter((name) => !expected.has(name));
  const diagnostics: QueryCheckDiagnostic[] = [];
  if (missing.length > 0) {
    diagnostics.push(diagnostic(query, "error", `PostgreSQL does not return typed column(s): ${missing.join(", ")}`));
  }
  if (extra.length > 0) {
    diagnostics.push(diagnostic(query, "error", `PostgreSQL returns undeclared column(s): ${extra.join(", ")}`));
  }
  return diagnostics;
}

function postgresMessage(error: unknown): string {
  if (typeof error === "object" && error !== null && "message" in error) {
    return String(error.message);
  }
  return String(error);
}

async function checkWithPostgres(
  queries: readonly ExtractedQuery[],
  databaseUrl: string,
  searchPath: string | undefined,
): Promise<QueryCheckResult> {
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  const client = await pool.connect();
  const diagnostics: QueryCheckDiagnostic[] = [];
  let checked = 0;
  let skipped = 0;

  try {
    if (searchPath) await client.query(`set search_path to ${quoteIdentifier(searchPath)}, public`);
    for (const [index, query] of queries.entries()) {
      const kind = statementKind(query.text);
      if (!kind || !new Set(["select", "insert", "update", "delete", "merge", "values"]).has(kind)) {
        skipped += 1;
        diagnostics.push(diagnostic(query, "warning", "Statement cannot be checked with PostgreSQL PREPARE"));
        continue;
      }

      const name = `querier_check_${index}`;
      let prepared = false;
      try {
        await client.query(`prepare ${quoteIdentifier(name)} as ${query.text}`);
        prepared = true;
        checked += 1;

        if ((kind === "select" || kind === "values") && query.expected) {
          const text = query.text.trim().replace(/;\s*$/, "");
          const result = await client.query({
            text: `select * from (${text}) as ${quoteIdentifier("__querier_check")} limit 0`,
            values: Array.from({ length: query.parameterCount }, () => null),
          });
          diagnostics.push(...compareColumns(query, result.fields));
        }
      } catch (error) {
        diagnostics.push(diagnostic(query, "error", postgresMessage(error)));
      } finally {
        if (prepared) await client.query(`deallocate ${quoteIdentifier(name)}`);
      }
    }
  } finally {
    client.release();
    await pool.end();
  }

  return { checked, skipped, diagnostics };
}

function referencedTables(text: string): readonly string[] {
  const tables: string[] = [];
  const pattern = /\b(?:from|join|into|update)\s+(?:"([^"]+)"|([a-z_][\w$]*))(?:\s*\.\s*(?:"([^"]+)"|([a-z_][\w$]*)))?/gi;
  for (const match of text.matchAll(pattern)) {
    tables.push(match[3] ?? match[4] ?? match[1] ?? match[2] ?? "");
  }
  return tables.filter(Boolean);
}

function selectedColumns(text: string): readonly string[] | undefined {
  const match = text.match(/^\s*select\s+([\s\S]+?)\s+from\s/i);
  if (!match?.[1] || match[1].includes("*")) return undefined;
  return match[1].split(",").map((part) => {
    const alias = part.match(/\bas\s+"?([a-z_][\w$]*)"?\s*$/i)?.[1];
    if (alias) return alias;
    return part.trim().match(/(?:^|\.)"?([a-z_][\w$]*)"?\s*$/i)?.[1] ?? "";
  }).filter(Boolean);
}

function checkWithSchema(
  queries: readonly ExtractedQuery[],
  schema: SchemaDefinition,
): QueryCheckResult {
  const diagnostics: QueryCheckDiagnostic[] = [];
  let checked = 0;
  let skipped = 0;

  for (const query of queries) {
    const tables = referencedTables(query.text);
    if (tables.length === 0) {
      skipped += 1;
      diagnostics.push(diagnostic(query, "warning", "Offline schema checker could not determine the referenced table"));
      continue;
    }
    checked += 1;
    for (const table of tables) {
      if (!(table in schema)) diagnostics.push(diagnostic(query, "error", `Unknown table in schema: ${table}`));
    }

    const columns = selectedColumns(query.text);
    const firstTable = schema[tables[0] ?? ""];
    if (columns && firstTable) {
      for (const column of columns) {
        if (!(column in firstTable.columns) && !query.expected?.columns.includes(column)) {
          diagnostics.push(diagnostic(query, "error", `Unknown column ${column} on table ${tables[0]}`));
        }
      }
      if (query.expected) {
        const syntheticFields = columns.map((name) => ({ name })) as FieldDef[];
        diagnostics.push(...compareColumns(query, syntheticFields));
      }
    }
  }
  return { checked, skipped, diagnostics };
}

export async function checkQueries(options: QueryCheckOptions = {}): Promise<QueryCheckResult> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const files = await collectFiles(options.paths ?? ["src"], cwd);
  const queries = extractQueries(files);
  if (options.databaseUrl) {
    return checkWithPostgres(queries, options.databaseUrl, options.searchPath);
  }
  if (options.schema) return checkWithSchema(queries, options.schema);
  throw new TypeError("Query checker requires databaseUrl or schema");
}
