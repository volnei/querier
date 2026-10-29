import { describe, expect, expectTypeOf, it } from "bun:test";
import {
  createSchemaSnapshot,
  defineSchema,
  generateMigration,
  type InferDatabase,
} from "../src/index.js";

const schema = defineSchema({
  users: {
    columns: {
      id: { type: "bigint", identity: true, primaryKey: true },
      tenant_id: { type: "uuid" },
      email: { type: "text" },
      created_at: { type: "timestamptz", default: "now()" },
      deleted_at: { type: "timestamptz", nullable: true },
    },
    indexes: {
      users_tenant_email_unique: {
        columns: ["tenant_id", "email"],
        unique: true,
      },
      users_created_at_idx: {
        columns: [{ column: "created_at", order: "desc", nulls: "last" }],
      },
      users_active_email_idx: {
        expression: "lower(email)",
        where: "deleted_at is null",
        include: ["tenant_id"],
      },
    },
  },
} as const);

describe("schema types", () => {
  it("infers row, insert, and update shapes", () => {
    type Database = InferDatabase<typeof schema>;

    expectTypeOf<Database["users"]["row"]>().toEqualTypeOf<{
      id: string;
      tenant_id: string;
      email: string;
      created_at: Date;
      deleted_at: Date | null;
    }>();
    const insert: Database["users"]["insert"] = {
      tenant_id: "tenant",
      email: "ada@example.com",
    };
    expectTypeOf(insert.id).toEqualTypeOf<string | undefined>();
    expectTypeOf(insert.created_at).toEqualTypeOf<Date | undefined>();
    expectTypeOf(insert.deleted_at).toEqualTypeOf<Date | null | undefined>();
    expectTypeOf<Database["users"]["update"]>().toMatchTypeOf<{
      email?: string;
    }>();
  });

  it("rejects index columns that do not exist", () => {
    if (false) {
      defineSchema({
        users: {
          columns: { id: { type: "uuid" } },
          indexes: {
            // @ts-expect-error Index columns are restricted to keys of columns.
            invalid: {
              columns: ["missing"],
            },
          },
        },
      } as const);
    }
  });
});

describe("schema migrations", () => {
  it("generates tables and advanced indexes", () => {
    const plan = generateMigration(null, schema);

    expect(plan.sql).toContain('create table "users"');
    expect(plan.sql).toContain(
      'create unique index "users_tenant_email_unique" on "users" ("tenant_id", "email");',
    );
    expect(plan.sql).toContain(
      'create index "users_created_at_idx" on "users" ("created_at" desc nulls last);',
    );
    expect(plan.sql).toContain(
      'create index "users_active_email_idx" on "users" (lower(email)) include ("tenant_id") where deleted_at is null;',
    );
    expect(plan.destructiveChanges).toEqual([]);
  });

  it("diffs columns and indexes from a snapshot", () => {
    const before = defineSchema({
      users: {
        columns: {
          id: { type: "uuid", primaryKey: true },
          email: { type: "text" },
        },
        indexes: {
          users_email_idx: { columns: ["email"] },
        },
      },
    } as const);
    const after = defineSchema({
      users: {
        columns: {
          id: { type: "uuid", primaryKey: true },
          email: { type: "text" },
          display_name: { type: "text", nullable: true },
        },
        indexes: {
          users_email_idx: { columns: ["email"], unique: true },
          users_display_name_idx: { expression: "lower(display_name)" },
        },
      },
    } as const);

    const plan = generateMigration(createSchemaSnapshot(before), after);
    expect(plan.sql).toContain('drop index "users_email_idx";');
    expect(plan.sql).toContain(
      'alter table "users" add column "display_name" text;',
    );
    expect(plan.sql).toContain(
      'create unique index "users_email_idx" on "users" ("email");',
    );
    expect(plan.sql).toContain(
      'create index "users_display_name_idx" on "users" (lower(display_name));',
    );
  });

  it("reports destructive changes and refuses ambiguous key changes", () => {
    const before = defineSchema({
      users: {
        columns: {
          id: { type: "uuid" },
          legacy: { type: "text" },
        },
      },
    } as const);
    const withoutLegacy = defineSchema({
      users: { columns: { id: { type: "uuid" } } },
    } as const);
    const destructive = generateMigration(createSchemaSnapshot(before), withoutLegacy);
    expect(destructive.destructiveChanges).toEqual(["Drops column users.legacy"]);

    const withPrimaryKey = defineSchema({
      users: { columns: { id: { type: "uuid", primaryKey: true } } },
    } as const);
    expect(() =>
      generateMigration(createSchemaSnapshot(withoutLegacy), withPrimaryKey),
    ).toThrow("Cannot automatically change key, identity, or unique attributes");
  });
});
