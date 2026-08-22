# CodeGraph Fork Roadmap

Working roadmap for the `jdanilov/codegraph` fork. Tracks what we plan to build,
why, and what is deliberately deferred.

**Fork policy.** Keep the delta to upstream thin and rebase-able. Every item below is
designed to be *generic and upstreamable* — no customer, product, or repo name appears
in source, config keys, plugin names, tests, or fixtures. Project-specific behavior is
expressed entirely through per-project `codegraph.json`, never through code.

Version scheme: `<upstream>-jdanilov.<n>` (e.g. `1.5.0-jdanilov.1`). Bump `<n>` on every
meaningful build — the MCP proxy compares daemon version strings with exact equality, so
a bump is what evicts stale daemons still serving old code.

---

## Status

| # | Item | State |
|---|---|---|
| P0 | Plugin architecture (config-selected resolver plugins) | Done |
| 1a | Namespace-proxy resolution | Done |
| 1b | Layer-chain edges (same-stem siblings) | Done |
| 1c | Event-bus edge detection | Done — recall limited, see 1g |
| 1d | Per-project `exclude` config | Done |
| 1e | Cross-stem `extends` via registry map | Done |
| 1f | Validation pass on the reference project | Done — measured below |
| 1g | Event-bus recall: deep receiver chains | Done — precision correction, see below |
| 1i | Object-literal member extraction (plugin) | Done |
| 1j | Reference re-attribution into extractor spans | Done |
| 1h | Resolver-supplied edge provenance | Done |
| 1k | Call-wrapper unwrapping (JSX components) | Done |
| 2 | Graph visualizer | Deferred |
| 3 | Meaning layer | Deferred |

### Plugin ownership boundaries

Three plugins can see the same dynamic references, so ownership is split by
reference kind and by target shape. This is a correctness contract, not a
preference — two plugins resolving the same reference means the registry order
silently decides the answer.

| Reference | Owner |
|---|---|
| non-`extends` refs on a configured namespace object | `namespace-proxy` |
| `extends` where the target is a same-stem layer sibling | `layer-chain` |
| `extends` where the target is a **different** stem (framework base classes) | `namespace-proxy`, registry-backed only — **see 1e** |
| dispatch/subscribe verbs on a configured bus object | `event-bus` |

A project delegates its bus objects to `event-bus` by simply not listing them in
`namespace-proxy`'s config. No runtime coordination between plugins.

### 1e — Cross-stem `extends` via the registry map (done)

A gap created by the ownership split above, found when `layer-chain` landed.
Implemented as described; measured impact in 1f.

`layer-chain` resolves only **same-stem** siblings and correctly abstains when a
class extends a framework base living in another module (`widget.bg.ts extends
$.Unit<T>` → `unit/unit.ts`). `namespace-proxy` was originally scoped to skip
**all** `extends` refs. Net effect: cross-stem `extends` is currently owned by
nobody, and it is the single most common dead `extends` reference in the
reference project (~120 occurrences of one base class alone, plus ~63 more that
`layer-chain` explicitly abstains on).

Fix: let `namespace-proxy` claim `extends` refs under three conditions —
(1) **registry-backed strategy only**, never assignment-scan or name-match, since
a wrong inheritance edge corrupts type-hierarchy queries far worse than a missing
one; (2) **cross-stem only** — abstain when the resolved target shares the
referring file's stem, leaving that to `layer-chain`; (3) non-`extends` behavior
unchanged. Note `namespace-proxy` is registered *before* `layer-chain`, so
without condition (2) it would silently pre-empt it.

---

## P0 — Plugin architecture

**Goal.** Enable/disable graph-enrichment plugins per project, with per-project options,
via `codegraph.json`. No forking of core logic to support one project's conventions.

### Feasibility: confirmed

Upstream already has almost everything needed. The `FrameworkResolver` interface
(`src/resolution/types.ts`) exposes exactly the hooks required:

| Hook | Purpose |
|---|---|
| `detect(context)` | project-level opt-in — can read `codegraph.json` |
| `claimsReference(name)` | **critical** — opts a reference name past the "no node has this name" pre-filter, which is what currently drops every dynamic reference |
| `resolve(ref, context)` | turn an unresolved reference into an edge |
| `extract(filePath, content)` | emit synthetic nodes + references per file |
| `postExtract(context)` | cross-file finalization after full extraction |

`registerFrameworkResolver()` already exists as a public registration entry point, and
there are only three call sites to touch: `getAllFrameworkResolvers`, `detectFrameworks`,
`getApplicableFrameworks` (`src/resolution/frameworks/index.ts`).

### Design decision: in-tree, config-selected plugins — NOT dynamic module loading

Plugins ship in the repo under `src/resolution/plugins/` and are *selected and configured*
by `codegraph.json`. We do not load arbitrary JS paths. Three reasons:

1. **Worker threads.** `src/extraction/parse-worker.ts` statically imports the resolver
   registry and filters it by name. Dynamically-loaded modules would not exist in worker
   threads; statically-imported ones populate the registry on module load automatically,
   and the config-driven enable list travels as plain names.
2. **Security.** The repo carries a security test suite and an explicit path-refusal model.
   Executing arbitrary user JS during indexing would never be upstreamable.
3. **Reviewability.** In-tree plugins get tests and are readable by upstream.

Per-project options reach worker threads by having each plugin lazily read
`codegraph.json` from the project root (cached per process), reusing the existing
`src/project-config.ts` loader. No new plumbing.

### Config schema

Extends `ProjectConfig` in `src/project-config.ts`:

```jsonc
{
  "plugins": {
    // Built-ins can be turned off per project.
    "disable": ["react", "vue"],

    // Opt-in plugins with per-project options.
    "namespace-proxy": { /* … */ },
    "layer-chain":     { /* … */ },
    "event-bus":       { /* … */ }
  }
}
```

Rules:
- Absent `plugins` key ⇒ today's behavior exactly. Zero-config projects are unaffected.
- A plugin with no config entry stays off. Opt-in only.
- `disable` filters built-in resolvers by name.
- Unknown keys are ignored, never fatal.

### Deliverables

- `plugins` section in `ProjectConfig` + loader + validation (warn, never throw).
- Registry honors the enable/disable list.
- Plugin scaffold + shared option-loading helper under `src/resolution/plugins/`.
- Tests: config parsing, enable/disable, absent-config no-op, malformed-config tolerance.

---

## 1a — Namespace-proxy resolution

**Problem.** Codebases that expose modules through a sigil namespace object (an
auto-vivifying proxy, a codegen'd registry, a service locator) are invisible to AST
extraction: `$utils.sleep()` parses as a member access on a symbol that is never declared
anywhere. Every such call becomes a dead reference.

Measured on the test project: **1,568 failed references** across `$ui.component` (221),
`$s.transaction` (146), `$.Unit` (120), `$bus.send` (89), `$bus.on` (63), and a long tail.

**Two resolution strategies, both generic:**

1. **Registry-backed (exact).** A generated or hand-written barrel file whose imports
   *are* the namespace map. Config points at it; the plugin reads its import statements
   and gets an authoritative `name → defining file` mapping. Zero guessing.
   This shape is common in codegen'd frameworks.
2. **Assignment-scan (mechanical).** `$ns.member = …` assignments within a directory
   convention establish the namespace member; references named `$ns.member` resolve to it.

**Hooks used:** `detect` (config present), `claimsReference` (`$`-prefixed names),
`resolve`. No core changes.

**Note.** Generated registry directories must NOT be excluded from the index — they are
the resolution source of truth.

---

## 1b — Layer-chain edges + layer metadata

**Problem.** Projects that split one logical class across sibling files by filename
suffix (`x.ts` / `x.bg.ts` / `x.pp.tsx`) have no edges between those files. The
specialization chain — often the central architectural fact of the codebase — does not
exist in the graph.

Measured on the test project: **18 `extends` edges in a 19,358-node graph**, and 237
failed `extends` references. Three same-named classes forming one unit had **zero**
outgoing structural edges of any kind.

**Approach.** Config declares the suffix vocabulary and the base-namespace sigil. The
plugin resolves `extends <sigil>.<Name>` to the same-named class in the layer-stripped
sibling file. The `extends` references already exist in `unresolved_refs`, so this is a
pure `resolve()` implementation — no extraction change.

**Secondary goal — layer as node metadata.** Recording which runtime context a symbol
belongs to would make "what runs in the background worker" answerable. This is the one
item that may need a core change: `nodes` has no generic metadata column (`edges` does).

Options, in preference order:
1. Add `metadata TEXT` to `nodes` via a migration — small, symmetric with `edges`,
   unblocks every future plugin. Cleanest and plausibly upstreamable on its own merits.
2. Encode into the existing `decorators` JSON array — zero schema change, but a misuse
   of the field.
3. Defer.

**Decision: ship edges first (option 3), then evaluate option 1 separately.** The edges
carry the retrieval value; metadata is an enhancement, and the schema change deserves its
own PR rather than riding along.

---

## 1c — Event-bus edge detection

**Problem.** String-keyed message buses (`bus.send('a.b', …)` dispatched to
`bus.on('a.b', handler)`) are pure dynamic dispatch. Upstream's event-emitter synthesizer
covers `.emit`/`.fire`/`.dispatchEvent` paired with `.on`/`.once`/`.addListener`, via
hardcoded regexes.

Measured on the test project: 89 `send` + 63 `on` + 7 `emit` call sites produced **12**
synthesized edges — the bus is effectively unmapped, because `send` is the dominant
dispatch verb here and is absent from the upstream pattern.

**Approach — a standalone plugin, not a patch to the upstream regex.** Widening a
hardcoded upstream constant is not independently reviewable and raises false-positive risk
for every other project. Instead the plugin owns its own detection with a
config-declared verb vocabulary:

```jsonc
"event-bus": {
  "objects":    ["$bus", "$iframeBus"],
  "dispatch":   ["send", "emit"],
  "subscribe":  ["on", "once"]
}
```

The `$bus.send` references already exist in `unresolved_refs` with correct source nodes
and line numbers, so `resolve()` can read the call line, extract the event-name literal,
and target the matching subscriber. Fan-out caps mirror the upstream synthesizer's
precision discipline.

All edges are tagged `provenance: 'heuristic'` with `metadata.synthesizedBy`, so they
render as dashed/labeled wherever synthesized edges are surfaced.

---

## 1d — Per-project exclude config — DONE

Third-party UI component reference libraries vendored into a docs directory contributed
**330 files / 6,307 nodes (~33% of all non-file nodes)** in the test project while being
entirely irrelevant to any query. They competed with first-party code in explore's
ranking on every call.

Resolved via `exclude` in the project's own `codegraph.json`. No code change.

**Rejected: per-package indexes.** Splitting the monorepo into several `.codegraph/`
directories would sharpen per-package ranking but destroy cross-package edges. Those
edges (client call → server endpoint) are a deliberate future target, so the monorepo
stays a single index.

---

## 2 — Graph visualizer (deferred)

Local web UI over the existing index: `codegraph serve --web` attaching to the running
daemon, serving a small JSON API plus a static SPA.

Core principle: **never render the whole graph.** Three views — focus+expand from a
search hit; flow view between two symbols as a layered DAG; roll-up view aggregating to
file/directory/package. Colour edges by provenance so heuristic hops are visually
distinct from static ones. Optional `git diff` overlay to show changed nodes and their
blast radius.

Renderer: Cytoscape.js + dagre. Layered layouts, not force-directed — call flows are
directional and force-directed layouts destroy that.

---

## 3 — Meaning layer (deferred)

Two tiers:

**Tier A — declared taxonomy (deterministic).** Config maps path patterns to
module/actor/layer groupings, and edges roll up to them. Yields group-level dependency
graphs, group-granularity blast radius, and grouped explore output. No LLM, no staleness.
This is the majority of the value.

**Tier B — LLM-generated purpose descriptions.** Only for what AST cannot yield: what a
group is *for*, concept→location mapping, entity semantics, cross-cutting concerns.
Scoped at group level (hundreds of calls), never per-file (thousands, least useful,
worst staleness).

Non-negotiables for Tier B: content-hash keyed with per-group invalidation on sync;
never served without a freshness marker; stored in its own table; always additive and
clearly marked as generated, never mixed into or substituted for source. Surfaced inside
`codegraph_explore`'s existing output rather than behind a new tool — upstream's own A/B
work shows new tools get under-picked.

---

## Upstream contribution notes

Items designed to be upstreamable as-is: P0, 1a, 1b (edges), 1c. Bar to clear per repo
convention: tests alongside the change, a `## [Unreleased]` CHANGELOG entry written in
user-facing prose (no internal paths or symbol names), and — for new dynamic-dispatch
coverage — validation on small/medium/large real repos with ≥3 flow prompts each, per
`docs/design/dynamic-dispatch-coverage-playbook.md`. Never bump `package.json` in an
upstream PR.

---

## 1f — Measured validation (reference project, 1,461 files)

Full reindex, all three plugins enabled. Baseline is the same project with
`exclude` already applied and plugins OFF, so these deltas isolate the plugins.

| Metric | Before | After | Δ |
|---|---|---|---|
| `extends` edges | 18 | **248** | **+230** |
| Namespace refs unresolved | 1,605 | **1,046** | **−559** |
| Total unresolved refs | 34,817 | 34,320 | −497 |
| Edges (total) | 36,024 | 36,547 | +523 |
| Edges tagged `provenance:'heuristic'` | 361 | 373 | +12 (event-bus) |

Index time 2.0s for 1,461 files — no measurable cost from the plugin passes.

**Precision spot-check** — every high-count `extends` target lands on a plausible
base class in the right file, and the two namespace registries correctly route to
DIFFERENT files for the same member name (a base class ×120 via one layer's
registry, its system-layer counterpart ×37 via the other). The multi-tag sibling
case resolves too.

The three-file specialization chain that previously had **zero** structural edges
now resolves end to end: both specializations point at the shared base file, and
the base points at the framework base class in another module. That is
layer-chain (same-stem) and namespace-proxy (cross-stem, item 1e) composing
exactly as the ownership table specifies.

### 1g — Event-bus recall (open)

The bus plugin is correct but low-recall here: 12 edges against ~89 dispatch
sites. Cause is handler *shape*, measured over 64 subscription sites:

| Shape | Supported |
|---|---|
| `bus.on('e', handler)` / `this.handler` / `this.handler.bind(this)` | yes |
| `bus.on('e', receiver.method)` (one level) | yes |
| `bus.on('e', this.$.ns.method)` (deep chain) | **no** |
| `bus.on('e', arg => {…})` (inline) | no — correctly out of scope |

Only 18 of 64 sites use the plain named form. Extending receiver resolution to
multi-segment chains is the next increment; inline handlers stay out of scope
(anonymous, nothing to point at).

### 1h — Resolver-supplied edge provenance (done)

`ResolvedRef` gained an optional `edge: { provenance?, metadata? }`. Previously
only whole-graph synthesizer passes could write `provenance:'heuristic'` /
`metadata.synthesizedBy`, so a resolver bridging DYNAMIC dispatch had no way to
admit its edge was an inference — it rendered identically to a parsed call.
Resolver-supplied metadata merges *under* the resolver's own keys, so it can
annotate but never overwrite `confidence` / `resolvedBy` / `refName`.

Small and generic; upstreamable on its own merits, independent of any plugin.

---

## 1g — Deep receiver chains (done) — and a precision correction

Event-bus edges went **12 → 3**. That is not a recall regression: reading all 12
baseline edges against source showed **9 were fabricated**. All nine were
`this.X` or bare-local handler expressions falling through to the project-wide
"exactly one candidate" tier and landing on a same-named symbol elsewhere —
in one case in a different application of the monorepo entirely, in another on a
wrapper that merely *calls* the real handler.

Two abstentions now prevent that class of error:
- a `this`-qualified handler may never be answered project-wide (`this` names the
  enclosing object; a same-named function elsewhere is a coincidence)
- a bare name bound as a local `const`/`let`/`var` with no extracted node is not
  chased project-wide either

Deep chains themselves work — verified on verbatim real source in a scratch
project, 4/4 correct where the old regex could not match a 3-segment chain at
all. They contribute zero edges in the reference project only because those
events are dispatched exclusively from *inside their own handler* (the
cross-context fallback idiom), and the plugin correctly refuses a self-edge.

New knob `maxHandlerChainDepth` (default 5, hard cap 8); setting it to `2`
restores the pre-change shape coverage exactly.

### 1i — Object-literal member extraction in JS/JSX (open, top priority)

1g's real finding. Of 64 subscription sites, **38 have no handler node in the
graph at all** — every one an object-literal method in a `.js` file:

```js
$ns.controller = { async init () { … }, async refresh () { … } }
```

That file indexes to a *file node and nothing else*. The identical pattern in
`.ts` extracts fine. Measured across the reference project:

| Language | Files | Nodes | Nodes per KB |
|---|---|---|---|
| typescript | 297 | 4,157 | **4.65** |
| tsx | 237 | 3,049 | 2.95 |
| javascript | 694 | 5,440 | **1.45** |
| jsx | 219 | 714 | **0.74** |

**172 JS/JSX files extract ≤1 node**, including a 35 KB controller that yields
exactly one. JS/JSX is 62% of the project's files and is extracting at roughly a
third to a sixth of the TypeScript rate.

This is an *extractor* gap, not a resolver gap, and it is the ceiling under
1g, under `namespace-proxy`'s assignment scan, and under any flow question that
crosses legacy code. Closing it would put ~38 bus subscriptions in reach
immediately, and the receiver-path machinery from 1g is what will then aim them
correctly. Everything else in this roadmap is downstream of it.

---

## 1i / 1j — Object-literal members + reference re-attribution (done)

Two halves of one fix, shipped together.

**1i — `object-literal-members` plugin.** Config-gated, off by default. Mints
nodes for members of an object literal assigned onto a configured namespace
(`$ns.controller = { init () {…} }`) — a module shape core extracts in neither
JS nor TS. Builds a real AST via the already-loaded grammar (`getParser`), never
regex, since this mints NODES and a false positive would be inherited by every
downstream edge. Reuses core's `generateNodeId` and `::` qualified-name
convention so `namespace-proxy` resolves members without special-casing.

**1j — `FrameworkExtractionResult.reattributeFileScopeRefs`.** Opt-in flag plus a
pass in `tree-sitter.ts`. Reference attribution is a stack walked during
extraction with the file node as its floor; a construct core doesn't extract
opens no frame, so calls inside it are attributed to the FILE. A resolver minting
nodes afterwards can't join that stack, so it asks for correction instead. Refs
are MOVED onto the innermost containing span — never copied — so no edge is
duplicated and the reference count is conserved. Opt-in because it would
otherwise silently retarget references for all 26 existing framework resolvers.

### Measured (reference project, 1,461 files)

| Metric | Before | After | Δ |
|---|---|---|---|
| nodes | 13,276 | 13,915 | +639 |
| edges | 36,538 | 37,424 | +886 |
| JS/JSX files with ≤1 node | 172 | 122 | **−50** |
| event-bus edges | 3 | **54** | **+51** |
| `extends` edges | 248 | 248 | 0 (unchanged, as required) |
| index time | 1.8s | 1.8–2.0s | none |

Worked example — a controller that previously extracted 2 nodes and attributed
all 40 of its references to the file node:

```
nodes:  container `controller` (8-122) + init, getLsConfig, checkNewVersion, …
refs:   checkNewVersion 16 · init 6 · saveNewConfigAndReload 3 · … · file 2
```

Precision: all 639 emitted nodes bulk-checked against source — 69 containers,
570 members, 0 mismatches, 0 duplicate ids, 0 members outside their container's
span. Bus edges verified by reading source, not just counted.

### Known limits

- Getters (`get foo () {}`) emit as `function`, matching core's own object-literal
  walker; `property` would be more truthful but would diverge from core.
- 28 bus edges still originate from a file node — those dispatch sites are in
  React component files, outside this plugin's shape.
- The plugin emits no references of its own; it depends on core's refs being
  re-attributed into its spans. A member whose calls core never captured has an
  empty callee trail.
- Arrays of definitions, call-wrapped values (`Object.freeze({…})`), and
  non-top-level definitions abstain by design.

## 1k — Call-wrapper unwrapping (done)

The 1i plugin only descended into a DIRECT object-literal RHS, so component
definitions of the shape `$ns.Widget = $ui.component('Widget', { …methods… })`
— the dominant construct in the validation project's JSX (221 sites in 189
files) — still extracted to a file node and nothing else, and 28 event-bus
edges kept sourcing from file nodes.

New `wrappers` option on `object-literal-members`: an array of callee
dotted-paths (exact-match). When the RHS of a configured assignment is a call
whose callee is listed, the plugin descends into the call's LAST object-literal
argument as if it were the direct RHS. A wrapper call with no object-literal
argument abstains; non-listed callees (`Object.freeze`, arbitrary factories)
are still refused — no generic "unwrap any call" mode. The container node gets
kind `component` (it is a UI component definition); members keep `function` and
the `::` qualified-name convention. All existing safeguards (topLevelOnly,
maxDepth, maxNodesPerFile, re-attribution spans) apply inside the unwrapped
literal.

### Measured (validation project, re-index after enabling `wrappers`)

| Metric | before | after |
|---|---|---|
| nodes | 13,915 | 15,734 |
| edges | 37,424 | 38,543 |
| `component` nodes | 0 | 213 |
| jsx nodes (219 files) | 776 (3.5/file) | 2,595 (11.8/file) |
| bus edges from file nodes | 28 | **1** |
| `extends` | 248 | 248 |

Precision: 10/10 random component containers verified against source (name and
start line); 0 duplicate ids; 0 members outside their container's span. The
example file that motivated 1i/1j now shows the full chain
`render → renderContent → renderUserAvatar` and `_onActivate → updateProStatus`
with ZERO non-contains edges left on the file node.

### Known limits

- `const Widget = $ui.component(…)` (variable declaration, no namespace
  assignment) is out of shape and abstains — core's declaration path owns it.
- One namespace used as an assignment target in source is missing from the
  project's `objects` list (config gap, one-line fix in the project's
  codegraph.json — grep assignment targets against the configured list).
- Wrapper matching is exact callee text; an aliased factory
  (`const c = $ui.component; $ns.X = c(…)`) abstains by design.
