# Federation-first design

**Status:** draft — a statement of the ideal pattern, for review and iteration.

**Scope:** this document describes federation-first GraphQL platform design as an architectural
ideal — the topology, the ownership model, the technical wiring, and what a framework should make the
path of least resistance. It doesn't evaluate any specific codebase against it; it's the target shape
itself.

---

## 1. The core idea

Every GraphQL service a platform runs should be built, from the moment it's created, as a piece of a
larger graph rather than a graph unto itself. Concretely: **a new service defaults to being a
federation subgraph — a bounded slice of schema, owned end-to-end by one team, composed with every
other team's slice into a single public graph by a dedicated gateway.** A service that stands alone,
answering its own queries with no composition into anything larger, is the exception that needs
justifying — not the default shape every service starts from.

This is a stronger claim than "support federation when you need it." Federation support that only
activates when a team consciously reaches for it tends not to get reached for — the path of least
resistance wins, and the path of least resistance is whatever the framework hands you when you call the
obvious function with no extra arguments. If that obvious path produces a monolithic schema, monolithic
schemas are what you get, by default, everywhere, and each one becomes something to retrofit later. If
the obvious path produces a subgraph, composition is what you get for free, and a genuinely standalone
service becomes a deliberate, visible opt-out instead of the invisible default.

The rest of this document lays out why that default is the right one and what has to be true around it
for it to actually hold.

---

## 2. The topology

Three roles, three ownership models, one graph:

```
                         ┌────────────────────────────────────┐
                         │        The gateway                   │
                         │        (platform-owned)               │
                         │   composes subgraphs into one         │
                         │   public supergraph                   │
                         └──────────────┬───────────────────────┘
                                        │ service discovery (subgraph name → URL)
                    ┌───────────────────┼───────────────────────┐
                    ▼                                           ▼
        ┌───────────────────────┐                   ┌───────────────────────┐
        │  Team subgraph A         │   ...more team    │  Core platform monorepo │
        │  one repo, one team,     │    subgraphs        │  (may host a few tightly│
        │  owns its own schema     │    onboard here     │  coupled services)      │
        │  slice end-to-end        │                     │                        │
        └───────────────────────┘                   └───────────────────────┘
```

**The gateway** is platform-owned infrastructure. It has exactly one job: compose whatever subgraphs
are registered into one public schema, stay resilient when a subgraph isn't reachable yet, and pick up
schema changes without requiring a restart. It should be boring, small, and rarely touched by any team
other than the platform team — its whole value is that nobody has to think about it.

**Team subgraphs** are owned end-to-end by the team that builds them: one repo (or a clearly bounded
slice of one), their own CI, their own deploy path, their own slice of the schema. The ideal is that
onboarding a new subgraph touches the platform once — a single gated registration step — and after that
a team never needs a platform PR again to ship a change.

**A core platform monorepo** is a legitimate, different shape: a small number of tightly-coupled
services that share code and deploy together (a control-plane service and a worker that calls it
directly, say). This isn't in tension with federation — it's a service-boundary decision, orthogonal to
repo topology. What matters is whether the services it hosts need to expose GraphQL to the outside
world; if they do, each of those still wants to be its own subgraph rather than merge into one
monolithic schema, even while sharing a repo with its siblings.

**A naming trap worth designing against:** whatever convention you use to *name* services should never
be the thing that determines who deploys them or whether they're federated. If a name pattern and a
deployment reality can drift apart, someone will eventually read the name, assume the reality, and be
wrong. The thing that should determine ownership and federation status is where a service is registered
in the platform's provisioning system — an explicit, checked fact — not a naming convention, which is
just a hint.

---

## 3. The registry pattern that makes this safe to default to

Defaulting every service to "composed into a shared public graph" is only a good idea if the blast
radius of a team's mistake is contained by something other than good intentions. The pattern that
contains it is a **split between provisioning and deploy**:

```
PROVISION  (gated, platform-owned)              DEPLOY  (self-service, team-owned)
─────────────────────────────────────          ────────────────────────────────────────────────
A gated PR/request creates:                     Team copies a paved-path template into their
 - the repo (with delete protection)              own deploy-registry entry
 - a registry entry (image repo, etc.)                   │
 - a scoped CI identity                                  ▼
       │                                        Binds to the ONE shared, platform-owned
       ▼                                        security boundary — defined by the platform,
Team now owns the repo, but deployment          un-editable by teams, enforced by CI (namespace/
is not yet wired up                             project checks on every PR)
                                                         │
                                                         ▼
                                                 Deploy pipeline auto-syncs on merge.
                                                 Team iterates forever after with zero
                                                 further platform-repo PRs.
```

The security boundary is a single, shared, platform-owned policy object — however your deploy tooling
expresses that (an ArgoCD `AppProject`, an admission policy, an IAM boundary policy) — and the boundary,
not "who's allowed to deploy," is what does the actual work. A team can self-serve deploys freely
precisely because that boundary already constrains what namespace, what resources, what blast radius
they can touch. A team PR can never widen the platform; it can only be rejected by CI if it tries. This
is a **trusted-tenant** model: it assumes teams are cooperating, not adversarial, and it should be
revisited before extending it to a less-trusted or external tenant.

This is why "federate by default" doesn't need to invent new safety machinery at the code layer — the
registry pattern already provides it at the infrastructure layer. The framework's job is narrower than
it sounds: stop making every team reinvent the *code-level* half of a pattern the *infrastructure-level*
half already assumes is happening.

One piece of that loop deserves deliberate design, not an assumption that it falls out for free: getting
a subgraph from *deployed* to *actually composed into the public graph* is a distinct step from
deploying it. A gateway needs some mechanism — static config, live service discovery, a control-plane
API — for picking up a newly deployed subgraph, and that discovery mechanism is exactly the kind of
integration point that's easy to underbuild early and expensive to retrofit once several teams depend on
it. Treat "how does the gateway find out about a new subgraph" as a first-class design question from the
start, not an afterthought once composition is already needed.

---

## 4. The technical wiring pattern

The mechanical difference between a plain GraphQL service and a federation subgraph is small — smaller
than "federation" tends to sound. (Mercurius' federation tooling is the concrete example here, since
it's the ecosystem this pattern is being designed for; Apollo's tooling follows the same shape.)

**Plain service → federation subgraph, the whole diff, for the common case:**

1. Dependency: the plain GraphQL server plugin → its federation-aware equivalent
2. Registration: same call shape (`schema`, `resolvers`, `graphiql`/equivalent options) — just a
   different plugin registered
3. SDL: `type Query { ... }` → `extend type Query { ... }` — so a field composes into the supergraph's
   `Query` instead of declaring a standalone root type

That's the entire delta for a service contributing standalone fields with no shared entities. The
federation plugin auto-injects the schema-introspection machinery the gateway needs to discover and
compose the service; there's no manual schema-stitching call and no hand-written entity-resolution code
required for this case:

```graphql
extend type Query {
  """A field composed into the supergraph by the gateway."""
  greet(name: String): String!
}
```

**The gateway side** is symmetric: depend on a federation-aware gateway library instead of a plain
GraphQL server, register it with a list of subgraph endpoints, and build in resilience to subgraphs
coming up in an unpredictable order — retry discovery rather than crash-looping while dependencies boot,
and re-poll periodically so schema changes on an already-known subgraph propagate without a gateway
restart.

**What this simple pattern doesn't cover**, and shouldn't be assumed to generalize into automatically:
the shared-entity case, where two subgraphs both contribute fields to the *same* logical type — a `User`
owned by one service and extended by another, via a `@key` directive and reference-resolution logic.
That's a materially different, materially trickier problem than field-only extension. It's worth
designing deliberately, as its own piece of work, once a real cross-service entity need exists — not
something to bolt on under pressure the first time two teams discover they both want a piece of the same
type.

---

## 5. What a framework should make the default

If the goal is for "build a subgraph" to be the path of least resistance rather than a deliberate,
informed choice, the framework — not documentation, not tribal knowledge — has to carry that weight:

- **The default plugin path builds a federation-ready subgraph.** The obvious call, with no extra
  configuration, should produce something a gateway can compose. The plain, non-federated,
  answer-your-own-queries shape becomes the explicit opt-out, reserved for services that genuinely have
  no business being part of a larger graph (a local dev tool, an internal one-off).
- **Schema convention defaults to `extend type Query` / `extend type Mutation`**, not standalone root
  types — and the standalone-development case (running a service with no gateway present) needs a
  concrete, documented answer, since `extend type X` isn't valid SDL on its own. Either the framework
  auto-detects "no gateway configured, serve as a standalone root type," or the convention is that local
  development always runs against a local gateway. Whichever it is, it should be a stated design
  decision, not something a team discovers by accident the first time they try to run a service alone.
- **Boilerplate that every federated service ends up writing anyway gets absorbed by the framework, not
  copy-pasted per service.** Things like a reverse-proxy-safe GraphiQL path, a health-check route,
  graceful shutdown wiring aren't federation-specific, but they're exactly the kind of
  repeated-across-every-service code a framework exists to own once instead of N times.
- **The shared-entity pattern is a deliberate second layer, not part of the initial default.** Ship the
  simple field-extension default first; treat cross-service shared entities as their own design problem,
  informed by a real need, rather than speculatively building for it up front.
- **The escape hatches stay legible and distinct.** "I want a standalone, non-federated service" and "I
  want to build the gateway itself" are two different, rarer roles from "I want to build a subgraph" —
  each should have its own clearly-named path rather than collapsing into one generic manual-wiring
  mode that requires understanding the whole federation stack to use correctly.

---

## 6. Summary

Federation-first isn't a claim that every service needs to be federated on day one out of some
architectural purity — it's a claim about which failure mode is cheaper. A framework that defaults to
monolithic schemas is betting that most services will stay standalone, and paying a retrofit cost on
every one that doesn't. A framework that defaults to subgraphs is betting the opposite, and paying a
small, one-time design cost (schema convention, local-dev story, gateway discovery) to make composition
free for every service, forever, from the moment it's created. For any platform whose services are
likely to end up presented as one product surface — which is most of them, past a small handful of
services — that's the better bet.
