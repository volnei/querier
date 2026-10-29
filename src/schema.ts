export type PgType =
  | "smallint"
  | "integer"
  | "bigint"
  | "real"
  | "double precision"
  | "numeric"
  | "boolean"
  | "text"
  | "varchar"
  | "uuid"
  | "date"
  | "timestamp"
  | "timestamptz"
  | "time"
  | "timetz"
  | "json"
  | "jsonb"
  | "bytea"
  | "inet"
  | "cidr"
  | "macaddr";

export type PgColumnType = PgType | `${PgType}[]`;

export interface ColumnDefinition {
  readonly type: PgColumnType;
  readonly nullable?: boolean;
  readonly primaryKey?: boolean;
  readonly identity?: boolean | "always" | "by default";
  readonly unique?: boolean;
  /** Trusted PostgreSQL expression, such as `now()` or `'active'`. */
  readonly default?: string;
}

export interface IndexColumn<ColumnName extends string = string> {
  readonly column: ColumnName;
  readonly order?: "asc" | "desc";
  readonly nulls?: "first" | "last";
  readonly opclass?: string;
}

interface IndexOptions<ColumnName extends string> {
  readonly unique?: boolean;
  readonly method?: "btree" | "hash" | "gin" | "gist" | "spgist" | "brin";
  readonly include?: readonly ColumnName[];
  /** Trusted PostgreSQL predicate for a partial index. */
  readonly where?: string;
}

export type IndexDefinition<ColumnName extends string = string> = IndexOptions<ColumnName> &
  (
    | {
        readonly columns: readonly (ColumnName | IndexColumn<ColumnName>)[];
        readonly expression?: never;
      }
    | {
        /** Trusted PostgreSQL index expression, such as `lower(email)`. */
        readonly expression: string;
        readonly columns?: never;
      }
  );

export interface TableDefinition {
  readonly columns: Readonly<Record<string, ColumnDefinition>>;
  readonly indexes?: Readonly<Record<string, IndexDefinition>>;
}

export type SchemaDefinition = Readonly<Record<string, TableDefinition>>;

type ValidateInclude<Index, ColumnName extends string> = Index extends {
  readonly include: infer Include;
}
  ? Include extends readonly ColumnName[]
    ? Index
    : never
  : Index;

type ValidateIndex<Index, ColumnName extends string> = ValidateInclude<
  Index,
  ColumnName
> extends never
  ? never
  : Index extends { readonly columns: infer Columns }
    ? Columns extends readonly (ColumnName | IndexColumn<ColumnName>)[]
      ? Index
      : never
    : Index extends { readonly expression: string }
      ? Index
      : never;

type ValidateTable<Table> = Table extends {
  readonly columns: infer Columns extends Readonly<Record<string, ColumnDefinition>>;
}
  ? Table & {
      readonly indexes?: Table extends { readonly indexes: infer Indexes }
        ? {
            readonly [Name in keyof Indexes]: ValidateIndex<
              Indexes[Name],
              Extract<keyof Columns, string>
            >;
          }
        : Readonly<Record<string, IndexDefinition<Extract<keyof Columns, string>>>>;
    }
  : never;

type ValidateSchema<Schema> = {
  readonly [Table in keyof Schema]: ValidateTable<Schema[Table]>;
};

export function defineSchema<const Schema extends SchemaDefinition>(
  schema: Schema & ValidateSchema<Schema>,
): Schema {
  validateSchema(schema);
  return schema;
}

type ScalarFor<Type extends PgColumnType> = Type extends `${infer Element extends PgType}[]`
  ? ScalarFor<Element>[]
  : Type extends "smallint" | "integer" | "real" | "double precision"
    ? number
    : Type extends "bigint" | "numeric"
      ? string
      : Type extends "boolean"
        ? boolean
        : Type extends "timestamp" | "timestamptz"
          ? Date
          : Type extends "json" | "jsonb"
            ? unknown
            : Type extends "bytea"
              ? Buffer
              : string;

type ColumnValue<Column extends ColumnDefinition> = Column["nullable"] extends true
  ? ScalarFor<Column["type"]> | null
  : ScalarFor<Column["type"]>;

export type InferRow<Table extends TableDefinition> = {
  -readonly [Column in keyof Table["columns"]]: ColumnValue<Table["columns"][Column]>;
};

type OptionalInsertColumn<Column extends ColumnDefinition> =
  Column["identity"] extends false | undefined
    ? Column["default"] extends string
      ? true
      : Column["nullable"] extends true
        ? true
        : false
    : true;

export type InferInsert<Table extends TableDefinition> = {
  -readonly [Column in keyof Table["columns"] as OptionalInsertColumn<
    Table["columns"][Column]
  > extends true
    ? never
    : Column]: ColumnValue<Table["columns"][Column]>;
} & {
  -readonly [Column in keyof Table["columns"] as OptionalInsertColumn<
    Table["columns"][Column]
  > extends true
    ? Column
    : never]?: ColumnValue<Table["columns"][Column]>;
};

export type InferUpdate<Table extends TableDefinition> = Partial<InferRow<Table>>;

export type InferDatabase<Schema extends SchemaDefinition> = {
  readonly [Table in keyof Schema]: {
    readonly row: InferRow<Schema[Table]>;
    readonly insert: InferInsert<Schema[Table]>;
    readonly update: InferUpdate<Schema[Table]>;
  };
};

export interface SchemaSnapshot {
  readonly version: 1;
  readonly tables: SchemaDefinition;
}

export interface MigrationPlan {
  readonly sql: string;
  readonly destructiveChanges: readonly string[];
  readonly snapshot: SchemaSnapshot;
}

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function columnType(type: PgColumnType): string {
  return type;
}

function identitySql(identity: ColumnDefinition["identity"]): string {
  if (!identity) return "";
  if (identity === "by default") return " generated by default as identity";
  return " generated always as identity";
}

function columnSql(name: string, column: ColumnDefinition): string {
  let value = `${quoteIdentifier(name)} ${columnType(column.type)}`;
  value += identitySql(column.identity);
  if (column.default !== undefined) value += ` default ${column.default}`;
  if (!column.nullable) value += " not null";
  if (column.primaryKey) value += " primary key";
  if (column.unique) value += " unique";
  return value;
}

function indexSql(table: string, name: string, index: IndexDefinition): string {
  const unique = index.unique ? "unique " : "";
  const method = index.method ? ` using ${index.method}` : "";
  const target = index.expression !== undefined
    ? index.expression
    : index.columns!
        .map((entry) => {
          if (typeof entry === "string") return quoteIdentifier(entry);
          let value = quoteIdentifier(entry.column);
          if (entry.opclass) value += ` ${entry.opclass}`;
          if (entry.order) value += ` ${entry.order}`;
          if (entry.nulls) value += ` nulls ${entry.nulls}`;
          return value;
        })
        .join(", ");
  const include = index.include?.length
    ? ` include (${index.include.map(quoteIdentifier).join(", ")})`
    : "";
  const where = index.where ? ` where ${index.where}` : "";
  return `create ${unique}index ${quoteIdentifier(name)} on ${quoteIdentifier(table)}${method} (${target})${include}${where};`;
}

function stableObject<T>(value: T): T {
  if (Array.isArray(value)) return value.map(stableObject) as T;
  if (typeof value !== "object" || value === null) return value;

  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => [key, stableObject(entry)]),
  ) as T;
}

export function createSchemaSnapshot<Schema extends SchemaDefinition>(
  schema: Schema,
): SchemaSnapshot {
  validateSchema(schema);
  return Object.freeze({ version: 1 as const, tables: stableObject(schema) });
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(stableObject(left)) === JSON.stringify(stableObject(right));
}

export function generateMigration(
  previous: SchemaSnapshot | null,
  target: SchemaDefinition,
): MigrationPlan {
  validateSchema(target);
  if (previous && previous.version !== 1) {
    throw new Error(`Unsupported schema snapshot version: ${String(previous.version)}`);
  }

  const current = previous?.tables ?? {};
  const statements: string[] = [];
  const destructive: string[] = [];

  for (const [tableName, currentTable] of Object.entries(current)) {
    const targetTable = target[tableName];
    if (!targetTable) {
      statements.push(`drop table ${quoteIdentifier(tableName)};`);
      destructive.push(`Drops table ${tableName}`);
      continue;
    }

    for (const [indexName, currentIndex] of Object.entries(currentTable.indexes ?? {})) {
      const targetIndex = targetTable.indexes?.[indexName];
      if (!targetIndex || !same(currentIndex, targetIndex)) {
        statements.push(`drop index ${quoteIdentifier(indexName)};`);
      }
    }

    for (const [columnName, currentColumn] of Object.entries(currentTable.columns)) {
      const targetColumn = targetTable.columns[columnName];
      if (!targetColumn) {
        statements.push(
          `alter table ${quoteIdentifier(tableName)} drop column ${quoteIdentifier(columnName)};`,
        );
        destructive.push(`Drops column ${tableName}.${columnName}`);
        continue;
      }

      if (
        currentColumn.primaryKey !== targetColumn.primaryKey ||
        currentColumn.identity !== targetColumn.identity ||
        currentColumn.unique !== targetColumn.unique
      ) {
        throw new Error(
          `Cannot automatically change key, identity, or unique attributes for ${tableName}.${columnName}`,
        );
      }
      if (currentColumn.type !== targetColumn.type) {
        statements.push(
          `alter table ${quoteIdentifier(tableName)} alter column ${quoteIdentifier(columnName)} type ${columnType(targetColumn.type)};`,
        );
        destructive.push(`Changes type of ${tableName}.${columnName}`);
      }
      if (currentColumn.default !== targetColumn.default) {
        statements.push(
          targetColumn.default === undefined
            ? `alter table ${quoteIdentifier(tableName)} alter column ${quoteIdentifier(columnName)} drop default;`
            : `alter table ${quoteIdentifier(tableName)} alter column ${quoteIdentifier(columnName)} set default ${targetColumn.default};`,
        );
      }
      if (Boolean(currentColumn.nullable) !== Boolean(targetColumn.nullable)) {
        statements.push(
          `alter table ${quoteIdentifier(tableName)} alter column ${quoteIdentifier(columnName)} ${targetColumn.nullable ? "drop" : "set"} not null;`,
        );
        if (!targetColumn.nullable) {
          destructive.push(`Makes ${tableName}.${columnName} required`);
        }
      }
    }
  }

  for (const [tableName, targetTable] of Object.entries(target)) {
    const currentTable = current[tableName];
    if (!currentTable) {
      const columns = Object.entries(targetTable.columns)
        .map(([name, column]) => `  ${columnSql(name, column)}`)
        .join(",\n");
      statements.push(`create table ${quoteIdentifier(tableName)} (\n${columns}\n);`);
    } else {
      for (const [columnName, targetColumn] of Object.entries(targetTable.columns)) {
        if (currentTable.columns[columnName]) continue;
        statements.push(
          `alter table ${quoteIdentifier(tableName)} add column ${columnSql(columnName, targetColumn)};`,
        );
        if (!targetColumn.nullable && targetColumn.default === undefined && !targetColumn.identity) {
          destructive.push(`Adds required column ${tableName}.${columnName} without a default`);
        }
      }
    }

    for (const [indexName, targetIndex] of Object.entries(targetTable.indexes ?? {})) {
      const currentIndex = currentTable?.indexes?.[indexName];
      if (!currentIndex || !same(currentIndex, targetIndex)) {
        statements.push(indexSql(tableName, indexName, targetIndex));
      }
    }
  }

  return Object.freeze({
    sql: statements.join("\n\n"),
    destructiveChanges: Object.freeze(destructive),
    snapshot: createSchemaSnapshot(target),
  });
}

function validateSchema(schema: SchemaDefinition): void {
  for (const [tableName, table] of Object.entries(schema)) {
    if (tableName.trim() === "") throw new Error("Table names cannot be empty");
    const columnNames = new Set(Object.keys(table.columns));
    if (columnNames.size === 0) throw new Error(`Table ${tableName} has no columns`);

    for (const [columnName, column] of Object.entries(table.columns)) {
      if (columnName.trim() === "") throw new Error(`Table ${tableName} has an empty column name`);
      if (column.identity && column.default !== undefined) {
        throw new Error(`Column ${tableName}.${columnName} cannot have identity and default`);
      }
    }

    for (const [indexName, index] of Object.entries(table.indexes ?? {})) {
      if (indexName.trim() === "") throw new Error(`Table ${tableName} has an empty index name`);
      if ((index.columns === undefined) === (index.expression === undefined)) {
        throw new Error(`Index ${indexName} must define exactly one of columns or expression`);
      }
      if (index.expression !== undefined && index.expression.trim() === "") {
        throw new Error(`Index ${indexName} has an empty expression`);
      }
      const referenced = [
        ...(index.columns?.map((entry) =>
          typeof entry === "string" ? entry : entry.column,
        ) ?? []),
        ...(index.include ?? []),
      ];
      if (index.columns && index.columns.length === 0) {
        throw new Error(`Index ${indexName} has no columns`);
      }
      for (const columnName of referenced) {
        if (!columnNames.has(columnName)) {
          throw new Error(`Index ${indexName} references unknown column ${tableName}.${columnName}`);
        }
      }
    }
  }
}
