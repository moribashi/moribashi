# Moribashi — DI Framework Reference

Moribashi is a lightweight TypeScript dependency injection framework built on [Awilix](https://github.com/jeffijoe/awilix). It provides composable scopes, lifecycle hooks, and a plugin system. All packages are published to GitHub Packages under the `@moribashi` scope.

This guide is organized into phases. If your app already uses the packages from an earlier phase, skip ahead to the next one.

---

## Phase 1 — Core + Web + Postgres

### Installation

Configure `.npmrc` to pull from GitHub Packages:

```
@moribashi:registry=https://npm.pkg.github.com
```

Install the packages you need:

```sh
npm install @moribashi/core @moribashi/common
npm install @moribashi/web    # Fastify web server with per-request DI scopes
npm install @moribashi/pg     # PostgreSQL via Knex with migrations and camelCase queries
```

### App Lifecycle

```ts
import { createApp } from '@moribashi/core';

const app = createApp();

// 1. Register plugins
app.use(somePlugin());

// 2. Auto-discover services by file convention
await app.scan(['**/*.svc.ts', '**/*.repo.ts'], { cwd: __dirname });

// 3. Start — registers plugins, eagerly resolves all singletons, calls onInit()
await app.start();

// 4. Stop — calls onDestroy() in reverse init order, disposes scopes, cleans up
await app.stop();
```

### File Naming Conventions

Services are auto-discovered and registered based on filename suffix:

| File pattern | Registered as | Example |
|---|---|---|
| `books.svc.ts` | `booksService` | `app.resolve('booksService')` |
| `books.repo.ts` | `booksRepo` | `app.resolve('booksRepo')` |
| `books.domain.ts` | (types only — not registered) | N/A |

### Constructor Injection

All services use **destructured object injection**. Awilix resolves dependencies by parameter name from the container:

```ts
import type { Db } from '@moribashi/pg';

export default class UsersRepo {
  private db: Db;

  constructor({ db }: { db: Db }) {
    this.db = db;
  }

  async findAll() {
    return this.db.query<User>('SELECT id, name, created_at FROM users');
  }
}
```

- The class must be the **default export** of the file for `app.scan()` to pick it up.
- Dependencies are matched by destructured key name (e.g., `db` resolves the `db` registration, `authorsService` resolves `authorsService`).

### Lifecycle Hooks

Implement `onInit()` and/or `onDestroy()` methods on any service. They're duck-typed — no need to explicitly implement an interface, though you can import `OnInit` / `OnDestroy` from `@moribashi/common` for type safety:

```ts
import type { OnInit, OnDestroy } from '@moribashi/common';

export default class CacheService implements OnInit, OnDestroy {
  async onInit() {
    // Called during app.start() after all singletons are resolved
    await this.warmCache();
  }

  async onDestroy() {
    // Called during app.stop() in reverse init order
    await this.flushCache();
  }
}
```

### Lifetimes

- **SINGLETON** (default): One instance for the app's lifetime. Resolved eagerly during `app.start()`.
- **SCOPED**: One instance per scope (e.g., per HTTP request). Use `app.registerInScope()` to set this up.

### Plugins

Plugins are objects with `{ name, register(app) }`. The `register` function can be sync or async:

```ts
import type { MoribashiPlugin, MoribashiApp } from '@moribashi/core';

export function myPlugin(config: MyConfig): MoribashiPlugin {
  return {
    name: 'my-plugin',
    async register(app: MoribashiApp) {
      // Register services into the container
      app.container.register({
        myThing: asValue(createMyThing(config)),
      });
    },
  };
}
```

### `@moribashi/web` — Fastify Integration

Wraps Fastify with per-request DI scopes. Every incoming request gets an isolated scope with `request` and `reply` available for injection:

```ts
import { createApp } from '@moribashi/core';
import { webPlugin } from '@moribashi/web';
import type { FastifyInstance } from '@moribashi/web';

const app = createApp();
app.use(webPlugin({ port: 3000 }));
await app.scan(['**/*.svc.ts', '**/*.repo.ts'], { cwd: __dirname });

const fastify = app.resolve<FastifyInstance>('fastify');

fastify.get('/books', async (request) => {
  // Each request gets its own scope — resolve scoped or singleton services
  const booksService = request.scope.resolve<BooksService>('booksService');
  return booksService.findAll();
});

await app.start(); // Starts Fastify listening on port 3000
```

To register request-scoped services (one instance per request):

```ts
import { WEB_REQUEST_SCOPE } from '@moribashi/web';

app.registerInScope(WEB_REQUEST_SCOPE, {
  requestLogger: RequestLogger,  // New instance per request
});
```

### `@moribashi/pg` — PostgreSQL Integration

Registers two singletons on the container:
- `knex` — Raw Knex instance for query builder / schema operations
- `db` — `Db` wrapper with `query<T>()` that auto-converts snake_case columns to camelCase

```ts
import { createApp } from '@moribashi/core';
import { pgPlugin, type Db } from '@moribashi/pg';

const app = createApp();
app.use(pgPlugin({
  host: 'localhost',
  user: 'postgres',
  password: 'secret',
  database: 'mydb',
  migrationsDir: './data/migrations', // optional: runs on startup
}));
```

#### Connection Config

`pgPlugin()` accepts either individual params or a connection string:

```ts
// Individual params
pgPlugin({ host: 'localhost', port: 5432, user: 'postgres', password: 'pw', database: 'mydb' })

// Connection string
pgPlugin({ connectionString: 'postgres://user:pass@localhost:5432/mydb' })
```

#### Db Queries

`db.query<T>()` executes raw SQL with optional named params. Rows are auto-camelCased:

```ts
export default class UsersRepo {
  private db: Db;
  constructor({ db }: { db: Db }) { this.db = db; }

  async findAll() {
    // created_at → createdAt, full_name → fullName
    return this.db.query<User>('SELECT id, full_name, created_at FROM users ORDER BY id');
  }

  async findByEmail(email: string) {
    const rows = await this.db.query<User>(
      'SELECT id, full_name FROM users WHERE email = :email',
      { email },
    );
    return rows[0];
  }
}
```

#### SQL Migrations

Migrations use Flyway naming: `V<semver>__<description>.sql`. They run forward-only in version order:

```
data/migrations/
  V1.0.0__create_users.sql
  V1.1.0__add_email_column.sql
  V2.0.0__create_orders.sql
```

Each migration runs inside a transaction. Set `migrationsDir` on `pgPlugin()` to auto-run them during `app.start()`.

#### SQL-file Repositories (`Repo` + `RepoQuery`)

For repositories with many queries, keep SQL in separate `.sql` files instead of inline strings. The `Repo` base class and `RepoQuery` helper wire everything together automatically.

**1. Define the repo class** — each `RepoQuery<E>` property maps to a `.sql` file:

```ts
// src/users/users.repo.ts
import { Repo, RepoQuery, type Db } from '@moribashi/pg';
import type { User } from './users.domain.js';

export default class UsersRepo extends Repo {
  findAll  = new RepoQuery<User>();
  findById = new RepoQuery<User>();
  search   = new RepoQuery<User>();

  constructor({ db }: { db: Db }) {
    super(import.meta.dirname, db);
    this._autowire();  // must be called after class fields are initialized
  }
}
```

**2. Create SQL files** in a `sql/` directory next to the repo (configurable via the third `Repo` constructor arg):

```
src/users/
  users.repo.ts
  users.domain.ts
  sql/
    findAll.sql       # SELECT id, full_name FROM users ORDER BY id
    findById.sql      # SELECT id, full_name FROM users WHERE id = :id
    search.sql        # SELECT id, full_name FROM users WHERE name ILIKE :term
```

`_autowire()` reads each `.sql` file whose name matches a `RepoQuery` property and injects the `Db` instance. SQL files use Knex named params (`:paramName`).

**3. Use bounds-checked query methods** — `RepoQuery` provides four methods that delegate to `Db.query()` and enforce row-count expectations:

| Method | Returns | Throws when |
|--------|---------|-------------|
| `one(params?)` | `E` (single row) | 0 rows or >1 rows |
| `any(params?)` | `E[]` | never (0+ is fine) |
| `many(params?)` | `E[]` | 0 rows |
| `none(params?)` | `void` | any rows returned |

```ts
const users = await usersRepo.findAll.any();           // 0+ rows
const user  = await usersRepo.findById.one({ id: 1 }); // exactly 1 (throws otherwise)
const hits  = await usersRepo.search.many({ term: '%alice%' }); // 1+ (throws if empty)
```

**Important:** `_autowire()` must be called at the end of the subclass constructor, **not** in `super()`. JavaScript class field initializers (`findAll = new RepoQuery()`) run after `super()` returns, so the fields don't exist yet when the `Repo` base constructor runs.

### Typical Project Structure (Phase 1)

```
src/
  users/
    users.domain.ts       # Interfaces/types (not registered)
    users.repo.ts          # Data access (→ usersRepo)
    users.svc.ts           # Business logic (→ usersService)
    sql/
      findAll.sql          # SQL per RepoQuery property
      findById.sql
  orders/
    orders.domain.ts
    orders.repo.ts
    orders.svc.ts
    sql/
      findAll.sql
      findById.sql
  main.ts                  # App setup, routes, start/stop
data/
  migrations/
    V1.0.0__create_tables.sql
```

---

## Phase 2 — Typed Scopes + GraphQL

**Prerequisites:** Phase 1 complete (core, web, and pg working).

Phase 2 adds two things:
1. **Typed scopes** — `MoribashiScope<Cradle>` lets you declare what services are in a scope and get type-safe access via `.cradle`
2. **`@moribashi/graphql`** — Mercurius-based GraphQL plugin where resolvers get the typed scope as `this`

### Install

```sh
npm install @moribashi/graphql
```

### Typed Scopes

`MoribashiScope` now accepts an optional `Cradle` type parameter describing what services the scope contains. The `cradle` property is an Awilix proxy that lazily resolves services on property access:

```ts
interface RequestCradle {
  booksService: BooksService;
  authorsService: AuthorsService;
  request: FastifyRequest;
  reply: FastifyReply;
}

// Create a typed scope
const scope = app.createScope<RequestCradle>(WEB_REQUEST_SCOPE);

// Typed access via cradle (lazy — resolves on property access)
const books = await scope.cradle.booksService.findAll();

// Typed resolve (infers return type from key)
const svc = scope.resolve('booksService'); // BooksService

// Untyped resolve still works (fallback overload)
const svc2 = scope.resolve<BooksService>('booksService');
```

All existing unparameterized usage (`MoribashiScope` without a type arg) continues to work — it defaults to `MoribashiScope<object>`.

### `@moribashi/graphql` — GraphQL Integration

Wraps [Mercurius](https://mercurius.dev/) with per-request scope injection. Resolvers receive the scope's `cradle` as `this`, so `this.booksService` lazily resolves from the per-request scoped container.

**Requires `@moribashi/web`** — the web plugin must be registered first since the graphql plugin relies on per-request scopes from `request.scope`.

#### 1. Define the scope cradle type

Declare what services your resolvers can access:

```ts
// src/graphql/resolvers.ts
import type { ResolverMap } from '@moribashi/graphql';
import type BooksService from '../books/books.svc.js';
import type AuthorsService from '../authors/authors.svc.js';

export interface RequestCradle {
  booksService: BooksService;
  authorsService: AuthorsService;
}
```

#### 2. Write resolvers with typed `this`

Each resolver function receives `this` bound to the scope cradle. Services resolve lazily on access:

```ts
export const resolvers: ResolverMap<RequestCradle> = {
  Query: {
    async books(this: RequestCradle) {
      return this.booksService.findAllWithAuthors();
    },
    async authors(this: RequestCradle) {
      return this.authorsService.findAll();
    },
  },
};
```

Resolvers also receive the standard GraphQL positional args `(parent, args, context, info)` if needed.

#### 3. Define the schema

```ts
// src/graphql/schema.ts
export const schema = `
  type Author {
    id: Int!
    name: String!
  }

  type Book {
    id: Int!
    title: String!
    authorId: Int!
    author: Author
  }

  type Query {
    books: [Book!]!
    authors: [Author!]!
  }
`;
```

#### 4. Wire up the plugin

```ts
import { graphqlPlugin } from '@moribashi/graphql';
import { schema } from './graphql/schema.js';
import { resolvers } from './graphql/resolvers.js';

app.use(webPlugin({ port: 3000 }));
app.use(graphqlPlugin({ schema, resolvers, graphiql: true }));
```

Options:
- `schema` — GraphQL SDL string
- `resolvers` — `ResolverMap<Cradle>` with `this`-bound resolvers
- `graphiql` — Serve GraphiQL IDE (default: `false`). When enabled, browser requests to `GET /graphql` redirect to `/graphiql`.

#### Federation

To make this schema a federation subgraph — composable by a gateway alongside other services' schemas —
pass `federated: true`:

```ts
app.use(graphqlPlugin({ schema, resolvers, graphiql: true, federated: true }));
```

Same options, same `this`-bound resolvers; the only other change is your SDL's root types switch from
`type Query` / `type Mutation` to `extend type Query` / `extend type Mutation`. See
[Phase 3 — Federation](#phase-3--federation) below for the full picture, including building the gateway
itself and adding new subgraphs.

`federated` defaults to `false` for now (see [issue #4](https://github.com/moribashi/moribashi/issues/4)
for the plan to flip that default).

**Manual wiring escape hatch:** if you need a Mercurius variant `graphqlPlugin()` doesn't cover (e.g.
you're hand-rolling something `federated: true` / `gatewayPlugin()` don't fit), the exported
`bindResolvers` and `scopeContext` helpers give you the same `this`-binding behavior directly:

```ts
import { bindResolvers, scopeContext } from '@moribashi/graphql';
import someMercuriusVariant from 'some-mercurius-variant';

fastify.register(someMercuriusVariant, {
  schema: typeDefs,
  resolvers: bindResolvers(resolvers),
  context: scopeContext,
  graphiql: true,
});
```

Your resolvers and `RequestCradle` interface are written the same way regardless of which of these three
paths you use.

### Typical Project Structure (Phase 2)

Adds a `graphql/` directory alongside existing domain modules:

```
src/
  users/
    users.domain.ts
    users.repo.ts
    users.svc.ts
  orders/
    orders.domain.ts
    orders.repo.ts
    orders.svc.ts
  graphql/
    schema.ts              # GraphQL SDL
    resolvers.ts           # ResolverMap<Cradle> + cradle interface
  main.ts
data/
  migrations/
    V1.0.0__create_tables.sql
```

### Scaling to Larger APIs

The flat schema shown above works well for small-to-medium APIs. For larger applications with many domain areas, consider the **namespaced domain pattern** — a convention where each domain gets its own namespace type (e.g. `Query.iam`, `Query.billing`) and operations nest underneath. This keeps the root query/mutation types clean and makes the schema self-documenting.

See [Namespaced Domain Pattern for GraphQL](./graphql-namespace-pattern.md) for the full convention, naming rules, and resolver structure.

---

## Phase 3 — Federation

**Prerequisites:** Phase 2 complete (typed scopes and `@moribashi/graphql` working).

By default, a Moribashi GraphQL app is a standalone schema. Phase 3 turns it into a **federation
subgraph** — one team's slice of schema, composed with every other team's slice into a single public
graph by a **gateway**. This is the recommended shape for any service that might eventually need to
share a graph with others, which in practice is most of them — see
[`federation-first-design.md`](./federation-first-design.md) for the full rationale.

`examples/platform` (at the repo root) is a complete, runnable reference: a gateway composing two
subgraphs. Read it alongside this section.

### Making a subgraph

Add `federated: true` to `graphqlPlugin()` and switch your root types from `type` to `extend type`:

```ts
app.use(graphqlPlugin({ schema, resolvers, graphiql: true, federated: true }));
```

```graphql
# before (standalone)
type Query {
  users: [User!]!
}

# after (federated subgraph)
extend type Query {
  users: [User!]!
}
```

That's the entire delta — same `schema` / `resolvers` / `graphiql` options, same `this`-bound resolvers
via the scope cradle. A federated subgraph is still a fully valid, independently queryable GraphQL
server on its own; the only difference is it also exposes a `_service { sdl }` field a gateway uses to
discover and compose it. Running it standalone (no gateway present — e.g. local dev) works exactly like
before.

### Building the gateway

`gatewayPlugin()` composes a list of subgraphs into one public schema. Like `graphqlPlugin()`, it's an
ordinary Moribashi app — DI, lifecycle, and the plugin system all apply to it too, not just to
subgraphs:

```ts
import { createApp } from '@moribashi/core';
import { gatewayPlugin } from '@moribashi/graphql';
import { webPlugin } from '@moribashi/web';

const app = createApp();

app.use(webPlugin({ port: 4000 }));
app.use(gatewayPlugin({
  graphiql: true,
  subgraphs: [
    { name: 'identity', url: 'http://localhost:4001/graphql' },
    { name: 'catalog', url: 'http://localhost:4002/graphql' },
  ],
}));

await app.start();
```

Subgraphs are non-mandatory by default (`mandatory: false`) — the gateway starts even if one isn't
reachable yet, and re-polls (`pollingInterval`, default 10s) to pick it up later. If literally none of
the subgraphs are reachable at boot, registration fails and the process exits; recovering from that is
left to your process supervisor (e.g. Kubernetes restarting the pod) rather than an in-process retry
loop, since retrying a Fastify instance whose boot has already failed isn't a safe operation.

### The recommended shape: a core platform monorepo

Put your gateway and your team's own "backbone" subgraphs in one pnpm monorepo — that's exactly what
`examples/platform` demonstrates (`gateway/`, plus a subgraph per core domain). As more domains come
online, each new one gets its own repo instead (below), so no single repo grows without bound.

### Adding a new team-owned subgraph

Once a gateway and at least one subgraph exist, adding another domain is meant to be routine:

1. **New repo, new Moribashi app.** Scaffold it the same way as any Phase 1/2 app —
   `webPlugin()` + `graphqlPlugin({ ..., federated: true })`. It doesn't need to know about the gateway
   or any other subgraph; it only owns its own slice of schema.
2. **Deploy it however your platform deploys services.** This is deliberately outside Moribashi's scope
   — see [issue #3](https://github.com/moribashi/moribashi/issues/3) for the open question of whether
   deploy/discovery conventions get standardized later.
3. **Register it with the gateway.** Add `{ name, url }` to the gateway's `subgraphs` list (wherever
   that config lives in your deployment) and let it restart or pick it up on its next poll. Today this
   is a manual step — there's no automatic discovery yet.

No changes to the gateway's code, no changes to any other subgraph, no shared schema file to merge —
each subgraph's SDL and resolvers stay entirely within its own repo.

### Shared entities across subgraphs

Two subgraphs contributing fields to the *same* logical type (a `User` owned by one service and
extended by another) needs `@key` directives and `__resolveReference` resolvers — see
[Federation Considerations](./graphql-namespace-pattern.md#federation-considerations) in the namespace
pattern doc. This is a materially harder problem than the field-only case above; reach for it once a
real cross-service entity need exists, not speculatively.

---

## Key Patterns

- **No decorators** — everything is convention-based (file names, constructor param names)
- **Default export** — each `.svc.ts` / `.repo.ts` file must default-export a class
- **Destructured constructor** — `constructor({ dep }: { dep: Dep })` — Awilix matches keys to container registrations
- **Singletons by default** — use scopes only where needed (per-request isolation)
- **`app.container`** — escape hatch to the underlying Awilix container for advanced registrations (`asValue`, `asFunction`, `asClass` with custom lifetimes)
- **`scope.cradle`** — typed Awilix proxy for lazy service access in scoped contexts (GraphQL resolvers, request handlers)
