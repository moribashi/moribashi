# Namespaced Domain Pattern for GraphQL

A convention for organizing large GraphQL schemas in Moribashi applications so that queries and mutations are grouped under domain-level namespaces instead of accumulating as flat fields on the root `Query` and `Mutation` types. This pattern works with any Moribashi GraphQL app and also maps naturally to Apollo Federation subgraphs if you adopt federation later.

---

## Why

As a GraphQL API grows, flat root fields create problems:

- **No grouping** — clients see a wall of unrelated fields at the query root
- **Hard to navigate** — new developers struggle to find operations in a large schema
- **Naming pressure** — generic names like `search` or `create` must be made unique (e.g. `searchUsers`, `createOrder`)

The namespaced domain pattern solves these by giving each domain area a single root entry point (e.g. `Query.iam`, `Mutation.iam`) and nesting resource operations underneath. If you later adopt federation, each namespace maps cleanly to a subgraph, avoiding cross-subgraph name collisions.

```graphql
# instead of this
query {
  users {
    id
  }
}
query {
  organizations {
    id
  }
}

# you get this
query {
  iam {
    identities {
      search(input: { labelLike: "alice" }) {
        results {
          id
          label
        }
      }
    }
    orgs {
      search(input: {}) {
        results {
          id
          name
        }
      }
    }
  }
}
```

---

## Naming Conventions

All namespace types are prefixed with the domain name to keep type names unique within the schema. Use PascalCase.

| Purpose                       | Pattern                          | Example                    |
| ----------------------------- | -------------------------------- | -------------------------- |
| Service namespace (query)     | `{Service}`                      | `Iam`                      |
| Resource namespace (query)    | `{Service}{Resources}`           | `IamIdentities`            |
| Search result wrapper         | `{Service}{Resource}Search`      | `IamIdentitySearch`        |
| Search input                  | `{Service}{Resource}SearchInput` | `IamIdentitySearchInput`   |
| Service namespace (mutation)  | `{Service}Ops`                   | `IamOps`                   |
| Resource namespace (mutation) | `{Service}{Resources}Ops`        | `IamIdentitiesOps`         |
| Domain entities               | Unprefixed                       | `Identity`, `Organization` |

Entities themselves are **not** prefixed — they represent domain concepts and don't need a namespace prefix.

---

## Schema Structure

### 1. Domain entities

Define your domain types. These are the real data types that resolvers return.

```graphql
enum IdentityType {
  USER
}

type Identity {
  id: Int!
  type: IdentityType!
  label: String!
  email: String!
  organizationId: Int
}

type Organization {
  id: Int!
  key: String!
  name: String!
}
```

> If using Apollo Federation, add `@key(fields: "id")` to entity types that need to be referenced from other subgraphs. See [Federation Considerations](#federation-considerations) below.

### 2. Search types

Each resource gets a search result wrapper and a search input. The wrapper exists so you can add pagination metadata later (`total`, `cursor`, `hasMore`) without breaking clients.

```graphql
type IamIdentitySearch {
  results: [Identity!]!
}

input IamIdentitySearchInput {
  idIn: [Int!]
  labelLike: String
}

type IamOrganizationSearch {
  results: [Organization!]!
}

input IamOrganizationSearchInput {
  idIn: [Int!]
  keyLike: String
  nameLike: String
}
```

### 3. Query namespace chain

Build the namespace chain from the resource level up to the root. Each level is a type whose fields are either nested namespaces or actual operations (like `search`).

```graphql
# Resource namespaces — contain the actual operations
type IamIdentities {
  search(input: IamIdentitySearchInput!): IamIdentitySearch!
}

type IamOrganizations {
  search(input: IamOrganizationSearchInput!): IamOrganizationSearch!
}

# Service namespace — groups resources
type Iam {
  identities: IamIdentities!
  orgs: IamOrganizations!
}

# Root entry point (use `extend type Query` if using federation — see below)
type Query {
  iam: Iam!
}
```

### 4. Mutation namespace chain

Mirror the query structure. Use `Ops` suffix to distinguish mutation namespaces from query namespaces.

```graphql
type IamIdentitiesOps {
  create(input: CreateIdentityInput!): Identity!
}

type IamOrganizationsOps {
  create(input: CreateOrganizationInput!): Organization!
}

type IamOps {
  identities: IamIdentitiesOps!
  orgs: IamOrganizationsOps!
}

# Root entry point (use `extend type Mutation` if using federation — see below)
type Mutation {
  iam: IamOps!
}
```

---

## Resolver Structure

Namespace types are pass-through — their resolvers return `{}` so GraphQL continues resolving down the chain. Only the leaf resolvers (the actual operations) do real work.

### Manual (without `@moribashi/graphql`)

```ts
import type { FastifyReply } from "fastify";

export const resolvers = {
  // ── Namespace pass-throughs ──
  Query: { iam: () => ({}) },
  Iam: { identities: () => ({}), orgs: () => ({}) },
  Mutation: { iam: () => ({}) },
  IamOps: { identities: () => ({}), orgs: () => ({}) },

  // ── Leaf resolvers (queries) ──
  IamIdentities: {
    search: async (
      _: unknown,
      args: { input: unknown },
      ctx: { reply: FastifyReply },
    ) => {
      const svc = ctx.reply.request.scope.resolve("identitiesService");
      return svc.search(args.input);
    },
  },
  IamOrganizations: {
    search: async (
      _: unknown,
      args: { input: unknown },
      ctx: { reply: FastifyReply },
    ) => {
      const svc = ctx.reply.request.scope.resolve("organizationsService");
      return svc.search(args.input);
    },
  },

  // ── Leaf resolvers (mutations) ──
  IamIdentitiesOps: {
    create: async (
      _: unknown,
      args: { input: unknown },
      ctx: { reply: FastifyReply },
    ) => {
      const svc = ctx.reply.request.scope.resolve("identitiesService");
      return svc.create(args.input);
    },
  },
};
```

### With `@moribashi/graphql`

When using the `graphqlPlugin`, resolvers get the scope cradle bound as `this`. Namespace pass-throughs stay the same but leaf resolvers become cleaner:

```ts
import type { ResolverMap } from "@moribashi/graphql";
import type IdentitiesService from "./identities/identities.svc.js";
import type OrganizationsService from "./organizations/organizations.svc.js";

export interface RequestCradle {
  identitiesService: IdentitiesService;
  organizationsService: OrganizationsService;
}

export const resolvers: ResolverMap<RequestCradle> = {
  // ── Namespace pass-throughs ──
  Query: { iam: () => ({}) },
  Iam: { identities: () => ({}), orgs: () => ({}) },
  Mutation: { iam: () => ({}) },
  IamOps: { identities: () => ({}), orgs: () => ({}) },

  // ── Leaf resolvers (queries) ──
  IamIdentities: {
    async search(this: RequestCradle, _parent, args) {
      return this.identitiesService.search(args.input);
    },
  },
  IamOrganizations: {
    async search(this: RequestCradle, _parent, args) {
      return this.organizationsService.search(args.input);
    },
  },

  // ── Leaf resolvers (mutations) ──
  IamIdentitiesOps: {
    async create(this: RequestCradle, _parent, args) {
      return this.identitiesService.create(args.input);
    },
  },
};
```

---

## Federation Considerations

If you compose your Moribashi app into an Apollo Federation subgraph, apply these additional conventions on top of the base pattern above.

### Use `extend type Query` / `extend type Mutation`

When running as a federation subgraph, you **must** use `extend type Query` and `extend type Mutation`, not `type Query`. When the gateway composes multiple subgraph SDLs that each declare `type Query { ... }`, only the last one wins — earlier subgraphs' query fields get silently dropped.

```graphql
# WRONG — will break composition
type Query {
  iam: Iam!
}

# CORRECT for federation subgraphs
extend type Query {
  iam: Iam!
}
```

### `@key` directives stay on entities, not namespace types

Add `@key` to actual domain entities (e.g. `type Identity @key(fields: "id")`). Namespace types (`Iam`, `IamIdentities`, etc.) are never referenced across subgraphs — they're purely structural. In the base (non-federated) pattern, `@key` is not needed.

### `__resolveReference` on entities only

Implement `__resolveReference` on entity types (`Identity`, `Organization`) so other subgraphs can reference them by key. Namespace types never need reference resolvers.

**Manual resolver example (federation):**

```ts
Identity: {
  __resolveReference: async (
    ref: { id: number },
    ctx: { reply: FastifyReply },
  ) => {
    const svc = ctx.reply.request.scope.resolve("identitiesService");
    return svc.findById(ref.id);
  },
},
```

**With `@moribashi/graphql`:**

```ts
Identity: {
  async __resolveReference(this: RequestCradle, ref: { id: number }) {
    return this.identitiesService.findById(ref.id);
  },
},
```

---

## Adding a New Domain Namespace

To add a new domain namespace (e.g. `billing`) following this pattern:

1. **Pick a domain prefix**: `Billing`
2. **Define entities**: `Invoice`, `PaymentMethod`
3. **Build the namespace chain**:
   ```graphql
   type BillingInvoices {
     search(input: BillingInvoiceSearchInput!): BillingInvoiceSearch!
   }
   type BillingPaymentMethods {
     search(
       input: BillingPaymentMethodSearchInput!
     ): BillingPaymentMethodSearch!
   }
   type Billing {
     invoices: BillingInvoices!
     paymentMethods: BillingPaymentMethods!
   }

   # Add the billing field to your root Query alongside other namespaces
   type Query {
     billing: Billing!
   }
   ```
4. **Mirror for mutations**:
   ```graphql
   type BillingInvoicesOps {
     create(input: CreateInvoiceInput!): Invoice!
   }
   type BillingOps {
     invoices: BillingInvoicesOps!
   }

   type Mutation {
     billing: BillingOps!
   }
   ```
5. **Wire resolvers**: namespace pass-throughs return `{}`, leaf resolvers delegate to services

> When your app has multiple namespace modules, combine their root fields into a single `type Query` / `type Mutation` definition in your schema SDL.

The client query reads naturally:

```graphql
query {
  billing {
    invoices {
      search(input: { statusIn: [UNPAID] }) {
        results {
          id
          amount
          dueDate
        }
      }
    }
  }
}

mutation {
  billing {
    invoices {
      create(input: { amount: 100, customerId: 1 }) {
        id
      }
    }
  }
}
```

---

## File Layout

Following Moribashi conventions, a project using this pattern looks like:

```
src/
  iam/
    identities/
      identities.svc.ts       # → identitiesService (search, create, findById)
      identities.domain.ts     # Identity types (not registered)
    organizations/
      organizations.svc.ts     # → organizationsService
      organizations.domain.ts
  graphql/
    schema.ts                  # Full SDL with namespace chain
    resolvers.ts               # Nested resolver tree + RequestCradle
  main.ts                      # createApp() + webPlugin/graphqlPlugin + scan
```
