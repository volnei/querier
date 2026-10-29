# querier

Uma camada mínima e tipada para executar SQL diretamente com o driver [`pg`](https://node-postgres.com/). Não é ORM, não mantém estado de entidades e não cria uma linguagem paralela ao SQL.

## Instalação

```sh
npm install querier pg
```

O pacote é ESM e requer Node.js 20 ou mais recente.

```ts
import { Pool } from "pg";
import { createDatabase, Repository, sql } from "querier";

const db = createDatabase(new Pool({ connectionString: process.env.DATABASE_URL }));

type User = {
  id: number;
  email: string;
};

const email = "ada@example.com";
const user = await db.maybeOne(sql<User>`
  select id, email
  from users
  where email = ${email}
`);
// User | null
```

Queries que retornam linhas exigem um tipo de resultado. SQL sem tipo é aceito por `execute`, mas é rejeitado por `one`, `maybeOne` e `many`:

```ts
const userSql = sql.type<User>();

const user = await db.maybeOne(userSql`
  select id, email
  from users
  where id = ${id}
`);

await db.execute(sql`delete from sessions where expires_at < now()`);
```

Toda interpolação normal vira parâmetro do PostgreSQL. Para trechos estruturais, use apenas os helpers explícitos:

```ts
const columns = [sql.identifier("id"), sql.identifier("email")];
const ids = [1, 2, 3];

const users = await db.many(sql<User>`
  select ${sql.join(columns)}
  from ${sql.identifier("users")}
  where id in (${sql.join(ids)})
`);
```

## API

- `db.many(query)` retorna `Row[]`.
- `db.one(query)` retorna `Row` e exige exatamente uma linha.
- `db.maybeOne(query)` retorna `Row | null` e rejeita mais de uma linha.
- `db.execute(query)` retorna o `QueryResult` original do `pg`.
- `db.transaction(callback, options?)` usa um `PoolClient`, com commit/rollback automático.
- `sql.fragment`, `sql.identifier`, `sql.join` e `sql.values` permitem composição segura.

## Repositories e transações

Repositories estendem a classe abstrata `Repository`. A biblioteca injeta o executor do pool ou da transação:

```ts
class AccountsRepository extends Repository {
  changeBalance(id: number, amount: number) {
    return this.one(sql<Account>`
      update accounts
      set balance = balance + ${amount}
      where id = ${id}
      returning id, balance
    `);
  }
}

const db = createDatabase(pool, {
  repositories: {
    accounts: AccountsRepository,
  },
  migrations: {
    directory: new URL("./migrations/", import.meta.url),
  },
});

// Fora de uma transação, o repository usa o pool.
const account = await db.accounts.changeBalance(accountId, 10);

// Dentro da transação, todos os repositories usam o mesmo PoolClient.
await db.transaction(async (tx) => {
  await tx.accounts.changeBalance(sourceId, -100);
  await tx.accounts.changeBalance(destinationId, 100);
});
```

Repositories são instanciados de forma lazy no primeiro acesso e reutilizados depois. Cada transação possui seu próprio cache lazy; todos os repositories acessados dentro dela compartilham exatamente o mesmo `PoolClient`.
Eles são expostos diretamente no database (`db.accounts`) e na transação (`tx.accounts`); não existe um namespace `db.repositories`.

## Schema e tipos gerados

O schema declarativo é opcional e não participa da execução das queries. Ele serve para inferir tipos, criar snapshots e gerar SQL de migrations para revisão:

```ts
import {
  defineSchema,
  generateMigration,
  type InferDatabase,
} from "querier";

export const schema = defineSchema({
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
      users_active_email_idx: {
        expression: "lower(email)",
        where: "deleted_at is null",
        include: ["tenant_id"],
      },
    },
  },
} as const);

type Database = InferDatabase<typeof schema>;
type User = Database["users"]["row"];
type NewUser = Database["users"]["insert"];
type UserPatch = Database["users"]["update"];
```

O gerador compara o snapshot anterior com o estado desejado:

```ts
const plan = generateMigration(previousSnapshot, schema);

console.log(plan.sql);
console.log(plan.destructiveChanges);
const nextSnapshot = plan.snapshot;
```

O plano suporta tabelas, colunas, defaults, nullability e índices. Mudanças ambíguas de primary key, identity ou `unique` de coluna são recusadas e devem ser escritas manualmente. O SQL gerado nunca é aplicado automaticamente.

## Migrations

Migrations são arquivos SQL comuns. Não existe modelo de schema, callback ou DSL de tabelas:

```text
migrations/
├── 001_create_users.sql
└── 002_create_posts.sql
```

```sql
-- migrations/001_create_users.sql
create table users (
  id bigint generated always as identity primary key,
  email text not null unique
);
```

```ts
await db.migrations.status(); // { applied, pending }
await db.migrations.up();     // aplica todas as pendentes
```

Os arquivos são ordenados lexicograficamente pelo nome e executados por inteiro. Não existem conceitos de `up`, `down`, comentários especiais ou uma linguagem própria dentro do SQL. Para corrigir ou reverter uma mudança, crie uma nova migration SQL.

Cada arquivo roda em sua própria transação. Um advisory lock do PostgreSQL impede execuções concorrentes, e `public._querier_migrations` registra o identificador e o SHA-256 de cada arquivo aplicado. Se um arquivo aplicado for editado, a execução é recusada. `up({ to: "..." })` aplica até um identificador específico.

## O que “typed” significa aqui

O tipo de retorno é declarado junto do SQL (`sql<User>`) e segue a query até o método de cardinalidade. O SQL e seus valores continuam sendo entregues diretamente ao `pg`.

Uma tag TypeScript isolada não consegue inferir as colunas retornadas por texto SQL. Inferência automática de resultado exige uma etapa adicional que leia o schema PostgreSQL e analise/valide a query. Isso pode ser adicionado depois como geração estática sem aumentar o runtime desta biblioteca.

## Desenvolvimento e distribuição

```sh
npm run check       # valida os tipos
npm test            # executa os testes
npm run build       # gera dist/
npm pack --dry-run  # mostra exatamente o que entrará no pacote
```

Para testar em outra aplicação antes de publicar, execute `npm pack` e instale o arquivo `.tgz` gerado nessa aplicação. O hook `prepack` sempre executa typecheck, testes e build antes de empacotar ou publicar.

Depois de escolher um nome disponível no registro e autenticar com `npm login`, a primeira publicação pública é feita com `npm publish`. Para pacotes com escopo, use um nome como `@sua-org/querier`; o `publishConfig` já está configurado para acesso público.
