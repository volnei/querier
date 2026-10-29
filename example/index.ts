import { deepStrictEqual } from "node:assert/strict";
import { Pool } from "pg";
import { createDatabase, Repository, sql } from "querier";
import { z } from "zod";

const UserRow = z.object({
  id: z.string().transform(BigInt),
  email: z.string().email(),
  created_at: z.date(),
}).strict();

type User = z.output<typeof UserRow>;
const UserTuple = z.tuple([
  z.string().transform(BigInt),
  z.string().email(),
]);

const EventRow = z.object({
  payload: z.object({
    type: z.literal("user.created"),
    userId: z.string(),
    metadata: z.null(),
    tags: z.array(z.string()),
  }),
}).strict();

class UsersRepository extends Repository {
  create(email: string): Promise<User> {
    return this.one(UserRow)`
      insert into users (email)
      values (${email})
      returning id, email, created_at
    `;
  }

  findByEmail(email: string): Promise<User | null> {
    return this.maybeOne(UserRow)`
      select id, email, created_at
      from users
      where email = ${email}
    `;
  }

  streamByEmail(email: string): AsyncIterable<User> {
    return this.stream(UserRow, { batchSize: 1 })`
      select u.id, u.email, u.created_at
      from users as u
      cross join generate_series(1, 2)
      where u.email = ${email}
      order by u.id
    `;
  }

  tupleByEmail(email: string) {
    return this.oneTuple(UserTuple)`
      select id, email
      from users
      where email = ${email}
    `;
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
  max: 1,
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
  const { streamed, found, tuple } = await db.transaction(async () => {
    const streamed: User[] = [];
    for await (const user of db.users.streamByEmail(email)) {
      streamed.push(user);
      break;
    }
    return {
      streamed,
      found: await db.users.findByEmail(email),
      tuple: await db.users.tupleByEmail(email),
    };
  });

  const event = await db.one(EventRow)`
    insert into events (payload)
    values (${sql.json({
      type: "user.created",
      userId: created.id.toString(),
      metadata: null,
      tags: ["example", "json"],
    })})
    returning payload
  `;

  deepStrictEqual(found, created);
  deepStrictEqual(streamed, [created]);
  deepStrictEqual(tuple, [created.id, created.email]);
  deepStrictEqual(event.payload.userId, created.id.toString());
  console.log({ applied, backfilled, user: found, event });
} finally {
  await pool.end();
}
