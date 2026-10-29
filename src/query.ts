const queryBrand: unique symbol = Symbol("querier.query");
const fragmentBrand: unique symbol = Symbol("querier.fragment");

export type SqlValue =
  | string
  | number
  | boolean
  | bigint
  | Date
  | Buffer
  | Uint8Array
  | null
  | readonly SqlValue[]
  | { readonly [key: string]: unknown };

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export type JsonType = "json" | "jsonb";

interface SqlSource {
  readonly text: string;
  readonly values: readonly unknown[];
}

export interface RowParser<Output extends object> {
  parse(value: unknown): Output;
}

export type ParserOutput<Parser extends RowParser<object>> =
  Parser extends RowParser<infer Output> ? Output : never;

export interface SqlStatement extends SqlSource {
  readonly [queryBrand]: { readonly typed: false };
}

export interface SqlQuery<Row extends object = object> extends SqlSource {
  readonly [queryBrand]: { readonly typed: true; readonly row: Row };
  readonly parser?: RowParser<Row>;
  /** Stable per-connection prepared statement name understood by `pg`. */
  readonly name?: string;
}

export type AnySqlQuery = SqlStatement | SqlQuery;

export interface SqlFragment {
  readonly text: string;
  readonly values: readonly unknown[];
  readonly [fragmentBrand]: true;
}

export type SqlInterpolation = SqlValue | SqlFragment;

export interface TypedSqlTag<Row extends object> {
  (
    strings: TemplateStringsArray,
    ...interpolations: readonly SqlInterpolation[]
  ): SqlQuery<Row>;
}

function isFragment(value: SqlInterpolation): value is SqlFragment {
  return typeof value === "object" && value !== null && fragmentBrand in value;
}

function compile(
  strings: TemplateStringsArray,
  interpolations: readonly SqlInterpolation[],
): { text: string; values: readonly unknown[] } {
  let text = strings[0] ?? "";
  const values: unknown[] = [];

  for (let index = 0; index < interpolations.length; index += 1) {
    const interpolation = interpolations[index];

    if (interpolation !== undefined && isFragment(interpolation)) {
      const offset = values.length;
      text += interpolation.text.replace(/\$(\d+)/g, (_, position: string) =>
        `$${Number(position) + offset}`,
      );
      values.push(...interpolation.values);
    } else {
      values.push(interpolation);
      text += `$${values.length}`;
    }

    text += strings[index + 1] ?? "";
  }

  return { text, values };
}

function makeFragment(text: string, values: readonly unknown[] = []): SqlFragment {
  return Object.freeze({ text, values: Object.freeze([...values]), [fragmentBrand]: true as const });
}

function assertJsonValue(
  value: unknown,
  path = "$",
  seen = new WeakSet<object>(),
): asserts value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError(`sql.json does not support non-finite numbers at ${path}`);
    }
    return;
  }
  if (typeof value !== "object") {
    throw new TypeError(`sql.json does not support ${typeof value} at ${path}`);
  }
  if (seen.has(value)) {
    throw new TypeError(`sql.json does not support circular values at ${path}`);
  }
  seen.add(value);

  if (Array.isArray(value)) {
    value.forEach((item, index) => assertJsonValue(item, `${path}[${index}]`, seen));
    seen.delete(value);
    return;
  }

  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    const name = (value as { constructor?: { name?: string } }).constructor?.name;
    throw new TypeError(
      `sql.json only supports plain objects, received ${name ?? "object"} at ${path}`,
    );
  }
  for (const [key, item] of Object.entries(value)) {
    assertJsonValue(item, `${path}.${key}`, seen);
  }
  seen.delete(value);
}

function json(value: JsonValue, type?: JsonType): SqlFragment {
  assertJsonValue(value);
  const encoded = JSON.stringify(value);
  return makeFragment(`$1${type ? `::${type}` : ""}`, [encoded]);
}

export interface SqlTag {
  (
    strings: TemplateStringsArray,
    ...interpolations: readonly SqlInterpolation[]
  ): SqlStatement;

  <Row extends object>(
    strings: TemplateStringsArray,
    ...interpolations: readonly SqlInterpolation[]
  ): SqlQuery<Row>;

  type<Row extends object>(): TypedSqlTag<Row>;
  type<Parser extends RowParser<object>>(
    parser: Parser,
  ): TypedSqlTag<ParserOutput<Parser>>;

  prepare<Row extends object>(name: string): TypedSqlTag<Row>;
  prepare<Parser extends RowParser<object>>(
    name: string,
    parser: Parser,
  ): TypedSqlTag<ParserOutput<Parser>>;

  fragment(
    strings: TemplateStringsArray,
    ...interpolations: readonly SqlInterpolation[]
  ): SqlFragment;

  identifier(...parts: readonly [string, ...string[]]): SqlFragment;
  join(items: readonly SqlInterpolation[], separator?: SqlFragment): SqlFragment;
  values(rows: readonly (readonly SqlValue[])[]): SqlFragment;
  json(value: JsonValue, type?: JsonType): SqlFragment;
  empty: SqlFragment;
}

const tag = (
  strings: TemplateStringsArray,
  ...interpolations: readonly SqlInterpolation[]
): SqlStatement => {
  const compiled = compile(strings, interpolations);
  return Object.freeze({
    ...compiled,
    [queryBrand]: undefined,
  }) as unknown as SqlStatement;
};

function createTypedTag<Row extends object>(
  parser?: RowParser<Row>,
  name?: string,
): TypedSqlTag<Row> {
  return (
    strings: TemplateStringsArray,
    ...interpolations: readonly SqlInterpolation[]
  ): SqlQuery<Row> => {
    const compiled = compile(strings, interpolations);
    return Object.freeze({
      ...compiled,
      ...(parser ? { parser } : {}),
      ...(name ? { name } : {}),
      [queryBrand]: undefined,
    }) as unknown as SqlQuery<Row>;
  };
}

function typedSql<Row extends object>(): TypedSqlTag<Row>;
function typedSql<Parser extends RowParser<object>>(
  parser: Parser,
): TypedSqlTag<ParserOutput<Parser>>;
function typedSql(parser?: RowParser<object>): TypedSqlTag<object> {
  return createTypedTag(parser);
}

function preparedSql<Row extends object>(name: string): TypedSqlTag<Row>;
function preparedSql<Parser extends RowParser<object>>(
  name: string,
  parser: Parser,
): TypedSqlTag<ParserOutput<Parser>>;
function preparedSql(name: string, parser?: RowParser<object>): TypedSqlTag<object> {
  if (name.trim() === "") throw new TypeError("sql.prepare requires a non-empty name");
  return createTypedTag(parser, name);
}

export const sql = Object.assign(tag, {
  type: typedSql,
  prepare: preparedSql,

  fragment(
    strings: TemplateStringsArray,
    ...interpolations: readonly SqlInterpolation[]
  ): SqlFragment {
    const compiled = compile(strings, interpolations);
    return makeFragment(compiled.text, compiled.values);
  },

  identifier(...parts: readonly [string, ...string[]]): SqlFragment {
    if (parts.length === 0) {
      throw new TypeError("sql.identifier requires at least one identifier");
    }

    return makeFragment(parts.map((part) => `"${part.replaceAll('"', '""')}"`).join("."));
  },

  join(items: readonly SqlInterpolation[], separator = makeFragment(", ")): SqlFragment {
    if (items.length === 0) return makeFragment("");

    let text = "";
    const values: unknown[] = [];

    items.forEach((item, index) => {
      if (index > 0) {
        const separatorOffset = values.length;
        text += separator.text.replace(/\$(\d+)/g, (_, position: string) =>
          `$${Number(position) + separatorOffset}`,
        );
        values.push(...separator.values);
      }

      if (isFragment(item)) {
        const offset = values.length;
        text += item.text.replace(/\$(\d+)/g, (_, position: string) =>
          `$${Number(position) + offset}`,
        );
        values.push(...item.values);
      } else {
        values.push(item);
        text += `$${values.length}`;
      }
    });

    return makeFragment(text, values);
  },

  values(rows: readonly (readonly SqlValue[])[]): SqlFragment {
    if (rows.length === 0) {
      throw new TypeError("sql.values requires at least one row");
    }

    const width = rows[0]?.length ?? 0;
    if (width === 0 || rows.some((row) => row.length !== width)) {
      throw new TypeError("sql.values rows must be non-empty and have equal lengths");
    }

    const values: SqlValue[] = [];
    const tuples = rows.map((row) => {
      const placeholders = row.map((value) => {
        values.push(value);
        return `$${values.length}`;
      });
      return `(${placeholders.join(", ")})`;
    });

    return makeFragment(tuples.join(", "), values);
  },

  json,

  empty: makeFragment(""),
}) as SqlTag;

export function isSqlQuery(value: unknown): value is AnySqlQuery {
  return typeof value === "object" && value !== null && queryBrand in value;
}
