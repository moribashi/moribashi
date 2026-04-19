# @moribashi/pg

Postgres integration for Moribashi — Knex-backed `Db` query helper, SQL-file `Repo` pattern, and a `SqlMigrationSource` for versioned migrations.

## Install

```sh
pnpm add @moribashi/pg @moribashi/core knex pg
```

`knex` and `pg` are peer dependencies.

## Quickstart

```ts
import { createApp } from '@moribashi/core';
import { type Db, pgPlugin, Repo, RepoQuery } from '@moribashi/pg';

interface Book {
  id: number;
  title: string;
  authorId: number;
}

// ./sql/findAll.sql  →  SELECT id, title, author_id FROM books ORDER BY id
// ./sql/findById.sql →  SELECT id, title, author_id FROM books WHERE id = :id
class BooksRepo extends Repo {
  findAll = new RepoQuery<Book>();
  findById = new RepoQuery<Book>();

  constructor({ db }: { db: Db }) {
    super(import.meta.dirname, db);
    this._autowire();
  }
}

const app = createApp();
app.use(pgPlugin({ connectionString: process.env.DATABASE_URL }));
app.register({ booksRepo: BooksRepo });
await app.start();

const book = await app.cradle.booksRepo.findById.one({ id: 1 });
```

## Migrations

```ts
import { createKnex, SqlMigrationSource } from '@moribashi/pg';

const knex = createKnex({ connectionString: process.env.DATABASE_URL });
const source = new SqlMigrationSource('./data/migrations');
await knex.migrate.latest({ migrationSource: source });
```

Files in the migrations directory must match the Flyway-style
`V<semver>__<description>.sql` convention (e.g. `V1.0.0__create_books.sql`).
Migrations are forward-only.

You can also have `pgPlugin` run migrations on start by passing
`migrationsDir`:

```ts
app.use(pgPlugin({ connectionString, migrationsDir: './data/migrations' }));
```

## API

See inline JSDoc on `src/*.ts`.

Key exports:
- `pgPlugin(options)` — Moribashi plugin registering Knex + Db helper
- `Db` — thin query helper bound to a Knex connection
- `Repo` / `RepoQuery` — SQL-file-driven repository pattern
- `SqlMigrationSource` — knex migration source that loads `V*.sql` files

## Stability

`@public`: `pgPlugin`, `Db`, `SqlMigrationSource`.
`@experimental`: `Repo`, `RepoQuery` (pattern may evolve).
