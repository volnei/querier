import { deepStrictEqual } from "node:assert/strict";
import { Pool } from "pg";
import { createDatabase, Repository, sql } from "querier";

type User = {
  id: string;
  email: string;
  created_at: Date;
};

class UsersRepository extends Repository {
  create(email: string): Promise<User> {
    return this.one(sql<User>`
      insert into users (email)
      values (${email})
      returning id, email, created_at
    `);
  }

  findByEmail(email: string): Promise<User | null> {
    return this.maybeOne(sql<User>`
      select id, email, created_at
      from users
      where email = ${email}
    `);
  }
}

class UsersService {
  constructor(private readonly users: UsersRepository) {}

  create(email: string): Promise<User> {
    return this.users.create(email);
  }
}

const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/querier",
});

const db = createDatabase(pool, {
  repositories: {
    users: UsersRepository,
  },
  migrations: {
    directory: new URL("./migrations/", import.meta.url),
    schema: "public",
    table: "querier_migrations",
  },
  backfills: {
    directory: new URL("./backfills/", import.meta.url),
    schema: "public",
    table: "querier_backfills",
  },
});

try {
  const applied = await db.migrations.up();
  const backfilled = await db.backfills.run();
  const email = `ada-${Date.now()}@example.com`;
  const users = new UsersService(db.users);

  const created = await db.transaction(() => users.create(email));
  const found = await db.users.findByEmail(email);

  deepStrictEqual(found, created);
  console.log({ applied, backfilled, user: found });
} finally {
  await pool.end();
}
