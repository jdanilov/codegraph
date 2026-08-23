# Visualizer — design contract (ROADMAP item 2)

Local web UI that renders a codegraph project as an explorable graph. CodeGraph
surfaces intra-code relations to agents; the visualizer surfaces the same
relations to developers — navigating agent-generated code, reviewing changes,
and producing feedback an agent can act on.

This document is the CONTRACT for the implementation agent train. Later phases
build against the API and layout rules fixed here; do not change a contract
item without updating this file in the same commit.

## Locked decisions

| Area | Decision |
|---|---|
| Serve | `codegraph ui [--port] [--path <root>]` subcommand in this package; binds **127.0.0.1 only**; no auth |
| Server stack | `node:http` + hand-rolled router — **zero new runtime dependencies** |
| DB access | Server owns one `CodeGraph` instance (writer); auto-starts `watch()` so the graph stays live; frontend **polls** `/api/status` and refetches on version change |
| Indexing | The UI MAY trigger `codegraph index` (`POST /api/index`, spawned as a subprocess); un-indexed root shows an "index now" screen |
| Frontend | Vite + React + TypeScript + Tailwind + shadcn/ui, `web/` directory, single root `package.json` (frontend deps in devDependencies, **no npm workspaces**) |
| Graph rendering | **canvas 2D**, hand-rolled (no rendering dependency); budget ≤2k simultaneously drawn arcs. *(Phase E: was sigma.js/WebGL — the force layout it drove was rejected, see "Visual language" below.)* |
| Build | `npm run build` also builds `web/` → `dist/ui-web/`, served statically; git-URL installs build it via the existing `prepare` hook |
| Question box | Floor: raw text → explore (deterministic, always works). Optional: LLM refine (Anthropic API, key entered in UI settings) |
| Persistence | Cards + UI state: `.codegraph/ui/` in the project (gitignored). User prefs (editor command, API key): `~/.codegraph/ui.json` |
| Editor jump | Command template from `~/.codegraph/ui.json` (e.g. `cursor -g {file}:{line}`), run server-side; client-side `vscode://` URL-scheme fallback when unset |
| Design | Minimal + light futuristic; graph is the background; code panels / views float on top |
| Out of scope v1 | Commit-history / time animation (no gource time axis), auth, UI test coverage, mobile |

## Visual language (locked)

*Rewritten in phase E. The original force-directed backbone (circles,
satellites, shift+click expansion, a 120° wedge, pin/wobble) was built in phase
B, reviewed on a real 13.8k-node project, and rejected: wobbly, spatially
chaotic, visually overwhelming. It is gone — there is no second canvas mode.*

- **The disk IS the structure.** The whole `contains` backbone is drawn as a
  radial **sunburst**: the *current root* fills the centre circle, and every
  ring outward is one level below it. There is no expand/collapse; there is
  navigation.
- **Angle ∝ size.** A directory/file/symbol's angular extent is its share of the
  **LoC** among its siblings, and siblings are ordered **largest first**. A
  directory weighs the sum of its children; a file weighs its line count; a
  symbol weighs its span (a symbol never inflates its file).
- **Minimum sliver + tail aggregation.** No arc is ever thinner than the
  clickable floor. A parent that cannot hold all its children at that floor
  draws the largest ones and folds the rest into a single `+N smaller` arc.
- **Bounded depth.** Rings are capped from the current root; deeper levels are
  reached by re-rooting, not by growing the disk.
- **Deterministic.** The layout is a pure function of (graph, current root). No
  simulation, no pinning, no relaxation — **nothing moves unless the user
  navigates**.
- **Navigation**: click a directory arc to re-root into it; click a file or
  symbol arc to select it (opens the info panel); double-click anything with
  children to drill into it; the centre circle and the breadcrumb go back up.
- **Edges are hidden at rest** and drawn as **hierarchically bundled curves**
  (Holten: routed along the hierarchy through the deepest shared ancestor,
  straightened by β). They appear for the hovered arc's subtree, the current
  selection, or the active card's `edgeRefs`. An endpoint that is not rendered
  attaches to its deepest visible ancestor arc — the centre when it is outside
  the current root's subtree entirely.
- **Provenance renders**: parsed edges solid, `provenance:'heuristic'` edges
  **dashed**, tooltip shows `metadata.synthesizedBy` + the wiring site.
- **Edge-kind toggles**: calls / imports / references / extends / instantiates
  (contains is never toggleable — it IS the disk).
- **Arc encoding**: fill colour = switchable mode (① node kind ② layer — derived
  from filename layer suffixes, read from the project's `plugins.layer-chain`
  config when present, else hidden). Size is the angle, so it is no longer a
  colour concern. Labels are drawn along the arc, and only on arcs wide enough
  to read.
- **Hover** shows an arc's tooltip and bundles its subtree's edges; **click**
  opens the info panel.
- **Card / view activation**: re-root to the deepest node containing every
  result node, glow the results and dim the rest, bundle the result edges.
  Changes view: hot rim on changed arcs, warm rim on impacted ones.
- **URL = state**: current root + active card encoded in the URL.

## HTTP API (contract)

All JSON under `/api/`; everything else serves `dist/ui-web/` static files
(SPA fallback to `index.html`). Path params validated inside the project root
(reuse the existing path-refusal helpers).

| Endpoint | Contract |
|---|---|
| `GET /api/status` | `{ indexed, root, dataVersion, fileCount, nodeCount, watching }` — `dataVersion` changes whenever the DB changes (drives polling + ETag) |
| `GET /api/graph` | Full graph, ETagged by `dataVersion`. `{ nodes: [{ id, kind, name, qualifiedName, file, startLine, endLine, parent, layer? }], edges: [{ source, target, kind, provenance?, synthesizedBy?, line? }], dirs: [{ path, parent, fileCount, loc }] }`. `contains` is expressed via `parent`, NOT in `edges`. |
| `GET /api/node/:id` | Info panel payload: node fields + contained nodes + in/out edges (with target names/kinds) + source (see `/api/source`) |
| `GET /api/source?file&start&end&mode=full\|diff` | Source text of a span; `diff` mode returns only hunks vs `HEAD` overlapping the span |
| `GET /api/search?q` | Fuzzy/FTS over nodes for Cmd+P: `[{ id, name, qualifiedName, kind, file }]`, ranked, ≤50 |
| `POST /api/explore` | `{ query }` → explore result as **structured** nodes/edges/flow (`{ nodeIds, edgeRefs, flow: [{ from, to, via }], summary }`), reusing the MCP explore implementation (refactor to expose a structured result; the MCP markdown path must not regress) |
| `POST /api/ask` | `{ question }` → LLM (key from settings) turns the question into a symbol bag → `/api/explore` internally. `501` when no key configured |
| `GET/PUT /api/cards` | CRUD on `.codegraph/ui/cards.json`: `[{ id, question, createdAt, result }]` |
| `GET /api/changes` | `{ changedNodes: [{ id, status: added\|modified\|deleted }], impactedNodeIds, hunks }` — git diff vs HEAD mapped onto node spans, plus impact radius via `getImpactRadius` |
| `POST /api/index` | Spawn `codegraph index` for the root; streams progress (chunked) |
| `POST /api/open` | `{ file, line }` → run the configured editor command template; `409` when unset (client then uses `vscode://`) |
| `GET/PUT /api/settings` | `~/.codegraph/ui.json`: `{ editorCommand?, anthropicApiKey?, model?, sortMode? }` (`sortMode` added in phase F). The key is never echoed back in full (masked) |

### Phase A clarifications (additive — no contract item changed)

The server implemented in phase A fixes a few details the table above left
open. Later phases and the client can rely on them:

- **Directory identity.** `dirs[]` entries carry an `id` of `dir:<path>`
  alongside `path`; the project root is `path: ""` / `id: "dir:"` with
  `parent: null`. A file node's `parent` is its directory's id, so the
  backbone is one connected tree from the root down to symbols. A symbol whose
  `contains` parent is missing falls back to its file node.
- **Extra response fields.** `/api/status` also returns `projectName`,
  `edgeCount`, `indexing` and `watcherDegraded`; `/api/graph` also returns
  `indexed`, `dataVersion`, `root`, `projectName` and the `layers` vocabulary.
- **Errors** are `{ error: { code, message } }`. A 501 stub carries that error
  **plus** the contract's empty result shape, so a client can read it without
  special-casing. `GET /api/graph` is `ETag: W/"v<dataVersion>"`.
- **`POST /api/index`** streams newline-delimited JSON events
  (`start` / `log` / `done` / `error`), releasing the database to the spawned
  CLI for the duration of the run.
- **Hardening**: loopback `Host` headers only (DNS-rebinding), every served
  path through `validatePathWithinRoot`, and the editor command is tokenized
  and spawned without a shell.

### Phase B clarifications (additive — no contract item changed)

The canvas implemented in phase B pins down details the visual language left
open. Phase C/D can rely on them:

- ~~**Sigma's y axis points UP on screen.** The layout therefore gives the FIRST
  child (A) the most POSITIVE angle so it lands at the top.~~ **SUPERSEDED by
  phase E** — canvas 2D's y axis points DOWN, and the sunburst starts at 12
  o'clock (`-π/2`) growing clockwise.
- ~~**Initial view** is the root EXPANDED with every top-level directory
  collapsed.~~ **SUPERSEDED by phase E** — the initial view is the project root
  at the centre of the disk; there is no expansion set.
- ~~**Mount budget split** (1,200 force-laid primaries + satellites,
  fair-shared per collapsed parent).~~ **SUPERSEDED by phase E** — the ≤2k
  budget is arcs, bounded per ring by the minimum sliver and per parent by the
  slot cap.
- ~~**Shift+click on a satellite** expands it *and* every ancestor.~~
  **SUPERSEDED by phase E** — there is no expansion; a click re-roots.
- **The hover rule** for edges survives phase E in spirit: a relation whose far
  endpoint is not rendered is drawn against the deepest VISIBLE ancestor of that
  endpoint, so a folded subtree never reads as unconnected. Edges are still only
  drawn on demand (hover / selection / card).
- **Edge-kind chips** are the contract's five in the contract's order, followed
  by any other non-`contains` kind actually present in the payload (e.g.
  `implements`, `overrides`) — an edge that is drawn is always toggleable.
- ~~**Camera framing.** A custom bounding box is pinned at the first fit so
  sigma never re-normalizes the coordinate frame.~~ **SUPERSEDED by phase E** —
  the disk is always fitted to the free viewport space; zoom and pan are user
  gestures and `fit` resets them.
- **Phase C mount point**: `<GraphCanvas renderDetail={…} onSelect={…} />`.
  `renderDetail(node)` replaces the stub body of the floating selection card;
  `onSelect` publishes the canvas selection to the shell. **Unchanged in phase
  E**, along with `onController` and `onViewChange`.

### Phase C clarifications (additive — no contract item changed)

The panels implemented in phase C fix the shape of `mode=diff` and the canvas
handles the shell drives. Phase D can rely on them:

- **`GET /api/source?mode=diff` response shape.** `200` with

  ```jsonc
  {
    "file": "src/services/store.ts",
    "mode": "diff",
    "startLine": 8, "endLine": 16,   // present only when a span was requested
    "status": "modified",            // modified | added | deleted | untracked | unchanged
    "hunks": [
      {
        "oldStart": 7, "oldLines": 6,
        "newStart": 7, "newLines": 8,
        "heading": "export class ItemStore {",  // git's enclosing-symbol hint, optional
        "lines": [{ "type": "ctx", "text": "  private items: Item[] = [];" },
                  { "type": "add", "text": "    // new line" }]   // ctx | add | del
      }
    ],
    "hunksOutsideSpan": 0,   // hunks the file has but the span doesn't touch
    "binary": false,
    "truncated": false,
    "git": true
  }
  ```

  Diffs are against `HEAD` (so staged and unstaged changes both show), three
  context lines, `\ No newline at end of file` markers dropped.
- **Hunks are filtered by OVERLAP and returned WHOLE.** A hunk is kept when its
  new-side line range intersects `[start, end]`; it is never trimmed, because
  cutting lines out of a hunk would invalidate its own `oldStart`/`newStart`
  accounting. Omitting `start`/`end` returns every hunk in the file. A deleted
  file's hunks are never span-filtered (there is no new side to filter on).
- **Untracked file → the whole requested span as one `add` hunk**
  (`oldStart: 0, oldLines: 0`), which is the truth relative to `HEAD`. A repo
  with no commits yet reports every file the same way with `status: "added"`.
- **Non-git root → `409`**, and the body still carries the full diff shape with
  `git: false` and `hunks: []`, so a client has one parse path for both answers
  (same principle as phase A's 501 stubs). `403` for a path outside the root,
  `404` for a missing file.
- **`CanvasController` additions** (phase D needs all three):
  `getExpanded(): Set<string>` / `setExpanded(ids)` — read and restore the
  expansion set, the setter applying the whole set in ONE re-mount — and
  `reveal(id)`, which expands the node's ancestors (never the node itself),
  selects it, fires `onSelect`, and animates the camera onto it once the layout
  settles. `<GraphCanvas onController={…}>` publishes the controller to the
  shell.
- **Node panel data.** `/api/node/:id` has no row for a `dirs[]` entry, so
  directories are answered from the client-side model instead of fetched.
  The panel renders the `source` block the node payload already carries, so
  opening one costs a single request.

### Phase D clarifications (additive — no contract item changed)

The questions/changes layer fixes the shapes the table left open:

- **Structured explore is the SAME implementation, not a second one.**
  `handleExplore` collects a structured twin of the response it was already
  assembling and attaches it to the `ToolResult` under an internal key, opt-in
  per call (`src/mcp/explore-structured.ts`). The MCP server never opts in, so
  an agent call computes none of it and its markdown is byte-identical
  (verified before/after on a multi-file flow fixture and on this repo).
  `POST /api/explore` runs the tool handler and reads that twin.
  - `nodeIds` are ordered **flow spine first**, then named symbols, then the
    symbols of every file whose source survived the budget (≤600).
  - `edgeRefs` are `{ source, target, kind, provenance?, synthesizedBy? }`
    among those nodes, spine hops first (≤1200); `contains` is never included.
  - `flow` is the rendered Flow section's path, hop by hop, with
    `via = metadata.synthesizedBy` for a synthesized hop, else the edge kind.
  - `summary` is the response's own "Found N symbols across M files." line plus
    the flow, as plain text.
  - An un-indexed project answers **200** with the empty shape and the reason
    in `summary` (same principle as the 501 stubs).
- **`POST /api/ask`** answers the contract's 501 (with the result shape and
  `symbolBag: ''`) when no key is configured, and **502** with the same shape on
  a timeout (25s), HTTP error or unusable answer — in every case the client's
  move is the same: keep the deterministic explore answer. The model is called
  over plain `fetch` (Messages API, no SDK, no new dependency), default model
  `claude-sonnet-5`, and only ever rewrites the question into a bag of symbol
  names — it never sees code and never answers about the codebase. The answer is
  filtered to identifier-shaped tokens (≤16) before it reaches explore.
- **`GET /api/changes`** returns
  `{ changedNodes, changedFiles, impactedNodeIds, hunks, git, truncated }`:
  - `changedNodes: [{ id, status: added|modified|deleted, file, name, kind,
    startLine, endLine }]` — ids that resolve against `/api/graph`. A node is
    changed when a hunk's **actually changed lines** (not its context lines)
    fall in its span; for an added/untracked/deleted file, every node in it.
  - `changedFiles: [{ path, status: added|modified|deleted|untracked, nodeId,
    nodeCount, hunkCount, binary }]` — file-level truth. **A deleted file whose
    nodes the index has already dropped appears only here, with `nodeId: null`**
    (when the index hasn't caught up yet, its nodes are still reported with
    `status: "deleted"`).
  - `hunks` is FLAT: `DiffHunk & { file }`, reusing `parseUnifiedDiff`.
  - `impactedNodeIds` = union of `getImpactRadius(id, 2)` over changed symbols
    (file nodes are not seeded), minus the changed ids. **Caps** (all reported
    via `truncated`): 200 files, 60 untracked files read from disk, 200 impact
    seeds, 2000 impacted ids. Two git invocations for the whole tree, not two
    per file.
  - Non-git root → **409** carrying the full shape with `git: false`.
- **URL state** is `#<version><base64url>`: `#1…` is DEFLATE-compressed JSON,
  `#0…` the uncompressed fallback. The JSON is `{ e: expandedIds, c: cardId,
  m: colorMode, k: edgeKinds }`. Over 6000 chars the expanded set is dropped
  and everything else still travels (the card re-derives its own expansion).
- **Canvas highlight** (`CanvasController.setHighlight` / `frameNodes`): halos
  are a second, larger, translucent circle mounted behind the node (`halo|<id>`)
  — no custom WebGL program, no new dependency. Hot = changed, warm = impacted,
  accent = card result; every pointer handler maps a halo back to its node.
- **Cards**: `{ id, question, createdAt, result }` in `.codegraph/ui/cards.json`.
  The two standing views are client-side ids (`view:project`, `view:changes`)
  and are never persisted. Activating a card applies
  `setExpanded(exactly the ancestors of its result nodes)`, selects nothing,
  highlights the result, and frames it; **Project** restores the default
  expansion. A node opened while Changes is active shows its **diff** first.

### Phase E clarifications (the sunburst — replaces phase B's representation)

Phase E swapped the representation and rewrote "Visual language" above. The
numbers and shapes it pins down:

- **Geometry.** Start angle `-π/2` (12 o'clock), clockwise, canvas y down.
  Centre disk radius 62; ring *n* thickness `max(30, 56 - 4(n-1))` with a 2-unit
  gap; at most **6 rings** from the current root, so the outer radius is 348
  layout units. The disk is scaled to fit the viewport minus a 372px left
  gutter (the floating card column) and always centred in what is left.
- **Thresholds.** Minimum arc **1.1°** (the clickable floor — it also bounds a
  full circle at ~327 arcs). A parent renders at most **96** children
  individually before folding (a full circle of 327 slivers reads as a comb).
  A file or symbol only grows a ring of its own children when its wedge is
  **≥ 6°**; a re-rooted file owns the full circle, so its symbols always show.
  Any arc needs **≥ 3×** the minimum (or a single child) before it drills at
  all. Labels need **38px of arc length**, an **11px ring thickness**, and at
  least 5 legible characters after truncation — otherwise the arc stays bare and
  the hover tooltip carries the name. On this repository (12.9k nodes) the
  project root draws 278 arcs across 5 rings in ~18ms, ~10 of them labelled.
- **Aggregation is by FIT, not by share.** A child is folded into the parent's
  `+N smaller` arc only when it does not fit at the minimum sliver. A share
  threshold was tried and is wrong: 40 equally-sized files in a 6° wedge are all
  below any fixed share, so the entire directory folded into one arc even though
  four of them fit. Folded children are still reachable — ⌘P re-roots onto the
  node itself, and clicking a `+N` arc re-roots onto its parent.
- **Reveal (`⌘P`) semantics.** Re-root to the node's **parent** and select it;
  if the node still has no arc (it was folded), re-root onto the **node itself**
  — the centre disk always renders the root, so ⌘P can reach anything.
- **Edge bundling.** Control points are the arc centroids along
  `source → … → deepest shared ancestor → … → target`, straightened by
  **β = 0.85**, drawn as a uniform cubic B-spline with tripled endpoints
  (hand-rolled: the sampled points are also the tooltip's hit test). Budget: 500
  edges per hover/selection/card, 4,000 nodes scanned per subtree.
- **Hover has two independent channels.** The arc hover (tooltip + bundling) is
  never stolen by the edge hover; otherwise hovering an arc reveals an edge
  under the cursor, which drops the arc hover, which hides the edge, forever.
- **URL state** is now `{ r: rootId, c: cardId, m: colorMode, k: edgeKinds }` in
  the same `#<version><base64url>` envelope. A phase D hash (`e: expandedIds`,
  no `r`) still opens: the shell re-roots to the deepest node those ids have in
  common. `e` is never written any more.
- **`CanvasController` surface.** `setRoot(id, animate?)` / `getRoot()` /
  `rootUp()` / `focusNodes(ids)` are the navigation API; `reveal`,
  `setHighlight`, `setSelected`, `setColorMode`, `setEdgeKinds`,
  `enabledEdgeKinds`, `fitView`, `destroy` keep their phase C/D meaning.
  `getExpanded()`/`setExpanded()` remain as compatibility shims — the former
  returns `{root}`, the latter re-roots to the deepest common ancestor of the
  ids it is handed. `frameNodes` is gone; `focusNodes` replaces it.
- **Removed dependencies**: `sigma`, `@sigma/edge-curve`, `graphology`,
  `graphology-types`. Nothing was added — the arcs, the curved labels and the
  β-spline are ~40 lines of canvas 2D each, which is the house preference (cf.
  the hand-rolled TOML writer) and keeps the frontend dependency-free beyond
  React/Tailwind.

### Phase F clarifications (canvas review — additive to phase E)

The sunburst was reviewed on a real project and kept; phase F is the round of
corrections that came out of that review. Everything below refines phase E's
numbers — no contract item changed.

- **Radial depth encodes the kind.** A directory wedge owns its whole ring
  band, a **file** ¾ of it, a **symbol** ½ (`depthFactor`). Bands still pack
  from the inside out: a band ends at its *tallest* wedge and the next band
  begins there (plus the 2-unit gap), so a ring of nothing but symbols is
  genuinely thinner, a mixed ring keeps its directories touching the ring
  outside them, and a shorter wedge simply leaves space toward the outside of
  its own band. Hit testing is against the **band**, not the wedge's painted
  outer radius — shrinking the click target with the paint would make symbols
  measurably harder to hit. An aggregate (`+N smaller`) arc takes the deepest
  factor among the children it folded.
- **Sibling order is a mode; the angle is not.** `SortMode` is `structural`
  (**the default**) or `size`. Structural reads like the source tree: a
  directory's children alphabetically, a file's (or a class's) members in
  **declaration order**. `size` is phase E's largest-first order. The angular
  extent is the LoC share in *both* modes — only the order around the disk
  changes. The fold into `+N smaller` is still decided by **fit** and still
  drops the *smallest* children, but the survivors keep the mode's order and the
  aggregate arc is always drawn last. The mode is a **user setting**
  (`sortMode` in `~/.codegraph/ui.json`, `GET/PUT /api/settings`), not URL
  state: it is how a person likes to read a disk, not part of a view they would
  share.
- **Label fallback.** Curved-along-the-arc is still the first choice. When the
  wedge is too short (<38px of arc) or too thin (<11px) for it, the name is
  drawn **horizontally, screen-aligned, through the wedge's centroid**. The
  available room is the horizontal/vertical chord of the wedge's centroid
  rectangle (radial × tangential half-extents rotated to the mid angle — two
  divisions, evaluated before any `measureText`); the label needs ≥18px of
  width, ≥8px of height and a fit that leaves **≥3 characters** (plus the
  ellipsis). Otherwise the wedge stays bare and the hover tooltip carries the
  name.
- **The centre circle names its destination.** It shows the **parent** you land
  on by clicking it (`▲ <name>`), or the project root's own name when there is
  nowhere up — with the **LoC of the current root** underneath, grouped
  (`5,176 loc`). The old bare "up" caption is gone.
- **Colours.** Directories are **grey in every colour mode** — structure is
  scaffolding and should not outshout the code in it. In the layer mode
  "no layer" is a **distinct non-grey** colour and directories get their own
  legend row, so the two can never be read as the same thing.
- **Hover dims by connectivity, instantly.** Hovering a wedge dims everything
  it has no edge with — same alpha as phase D's card dimming, no transition.
  Connectivity is aggregated exactly like the card highlight: the hovered
  wedge's whole subtree is the source, and each relation's far endpoint lights
  the deepest **rendered** arc standing in for it.
- **Labels survive dimming.** A dimmed wedge still draws its label (in quiet
  ink). They used to disappear the moment a card dimmed the disk, which is
  precisely when the user needs them to navigate back out.
- **Edges: direction, not kind.** Colour is the relation's direction relative
  to the focused (hovered, else selected) wedge — **incoming = green, outgoing =
  amber**; edges with no single focus (a card's `edgeRefs`) are neutral. The
  provenance distinction is untouched: parsed solid, `heuristic` **dashed**. The
  two colours, their meaning and the provenance rows are exported from
  `web/src/graph/palette.ts` (`EDGE_DIRECTION_COLORS`, `EDGE_DIRECTION_LEGEND`,
  `EDGE_PROVENANCE_LEGEND`) so the legend panel and the canvas cannot drift.
- **Edges never raise a tooltip.** Hovering a rope may highlight it; the tooltip
  is a **wedge-only** affordance now (`CanvasCallbacks` lost `onEdgeTooltip`).
  A bundled rope put a tooltip under the pointer everywhere the user was aiming
  at an arc.
- **No renderer telemetry on screen.** The arcs/budget, ring-count and
  edge-count readout is gone. `ViewSummary` still carries the numbers for the
  shell; nothing paints them.

### Phase F clarifications — panels (additive to the canvas pass)

The panels/dialog pass the canvas review deferred. It moves chrome between the
two columns and fixes three bugs; no endpoint's shape changed except the two
additive fields noted below.

- **The two columns have one job each.** The LEFT column is everything you
  drive the disk with — status, ⌘P/settings, questions, and now the **LEGEND**
  (the old top-right COLOR panel) with the `Fit` control folded into its
  header. The RIGHT column is the SELECTION and nothing else: a **node panel**
  and, under it, a **code panel**. The canvas keeps only the controls that mean
  nothing without a disk under them (breadcrumb, edge-kind chips, arc tooltip);
  `<GraphCanvas renderDetail>` is gone — the shell renders the selection
  itself, `onSelect` / `onController` / `onViewChange` are unchanged.
- **The legend carries both vocabularies.** The active colour mode's swatches
  (arcs) *and* the edge rows: **incoming green, outgoing amber, dashed =
  heuristic**, read from `EDGE_DIRECTION_LEGEND` / `EDGE_PROVENANCE_LEGEND` in
  `web/src/graph/palette.ts` — never re-typed, so the panel and the canvas
  cannot drift. The wedge/budget, ring and edge counters are gone from the UI
  entirely (`ViewSummary` still carries them; only `presentColorKeys` reaches
  React, and only when it changes).
- **Collapse, never close.** Both right-hand panels have a collapse toggle and
  no close button. Closing was the wrong verb — it threw the selection away to
  get the code out of the way. Collapse state is per PANEL and survives picking
  a different node. The node panel yields the lower half of the column to the
  code panel, and takes the whole column when there is no code panel (a
  directory) or the code panel is folded.
- **Escape has exactly one owner** — a window-level handler in the shell, with
  a fixed priority: **⌘P palette → settings → feedback export → selection**.
  Nothing when none of those is up; Escape never navigates. Dialogs no longer
  handle it themselves: a React `onKeyDown` on the dialog element only fires
  while the DOM focus sits inside it, which is what left ⌘P un-closable.
  Clearing the selection hides both right-hand panels.
- **The node panel answers "where is this" in ONE row.** `parent` — the file
  containing the node with the node's own line range appended
  (`src/lib/api.ts:67-135`), or the containing directory for a file/directory.
  The `qualified`, `file` and `lines` rows and the extension/layer/language
  pills are gone (the kind is in the title bar). "Jump to editor" is an icon
  button in that title bar; the source/changes switch is one in the CODE
  panel's title bar, next to the span's line range.
- **Code gets the width.** The code panel has minimal padding and **no
  line-number gutter** — the span's range is in the title and a hunk's `@@`
  header carries its own. Same for the diff's old/new number columns.
- **Qualified references.** Every list of symbols shows the owner, not a bare
  name (`web/src/lib/qualify.ts`): `parent.symbol` when the reference is in the
  SAME file as the selected node, extended up to the file name (three segments
  max, extension dropped — `analytics.send`) when it is outside it. A list with
  no file context — a question card's SYMBOLS list, the flow chain — always
  gets the file-qualified form.
- **A question card's counts agree with its list.** `POST /api/explore` (and
  `/api/ask`) now also return **`symbolCount`** and **`fileCount`**, derived
  from `nodeIds` — `symbolCount` IS `nodeIds.length`, `fileCount` the distinct
  files those ids live in — and `summary` quotes those numbers. The markdown
  response counts something subtly different (the symbols of the files whose
  SOURCE survived its byte budget), which is right for a reader of that text
  and wrong for a client rendering the id list: the list also carries the flow
  spine, whose hops can land in a file that didn't survive. Reusing the
  rendered sentence is what showed 99 rows under "Found 98 symbols across 7
  files". The sentence's trailing clauses (pinned files, unresolved paths) are
  carried over verbatim. **The agent-facing markdown is untouched** — the
  structured twin is still opt-in and read-only.
- **Editor jump resolution order**: the **configured command wins**.
  `POST /api/open` runs the template from `~/.codegraph/ui.json`; only its
  contract 409 ("nothing configured") falls back to the client-side
  `vscode://` URL. Two fixes: the button was an anchor whose `href` was ALWAYS
  the `vscode://` fallback (so the browser advertised — and on any path that
  skipped the click handler, followed — VS Code even with another editor
  configured); and `launchEditor` swallowed the child's asynchronous `error`,
  reporting "opened" for a command that never started. It now resolves on the
  child's `spawn`/`error` event and a failed launch answers **502
  `editor_failed`** with an actionable message (a shell alias is not an
  executable), instead of a silent success.
- **The DOM is instant.** Every `transition-*` utility is gone from the
  components, with a base-layer `transition-property: none` guard in
  `web/src/index.css` so one can't creep back. Animations are untouched —
  spinners still spin, and the disk's drill-down/up motion is canvas-drawn, not
  CSS. Per-file-type **lucide** icons (`web/src/lib/file-icons.tsx`, one table,
  reused by ⌘P, the node panel and the card lists) replaced the ⌘P colour dot;
  the hover-only "go to" arrow on a result row is gone — the row's hover tint
  is the affordance.
- **Chrome tidying**: `watching` and the data version moved beside the
  CODEGRAPH title in the status panel; a question card shows its counts as
  `<icon> N  <icon> M`, replaced by the delete button on hover; the two
  explanatory paragraphs ("The whole project, with every top-level folder
  collapsed…" and "Click a directory arc to open it…") are gone.

Standing views (always-present cards, client-side): **Project** (whole graph)
and **Changes** (`/api/changes`, refreshed on `dataVersion` change).

**Feedback export**: from a card + selected nodes, generate markdown (file
paths, line spans, user note) to paste into an agent prompt. Client-side only.

## Phases (agent train, sequential)

1. **A — server + scaffold**: `codegraph ui` command, `src/ui-server/`, all
   endpoints except `explore/ask/changes` (stub those with typed 501s),
   watcher auto-start, `web/` scaffold rendering a proof-of-life (node count
   from `/api/graph`), full build wiring.
2. **B — canvas**: sigma.js backbone, atom/expand/collapse, wedge force
   layout, pin/unpin, hover edges, curved-vs-straight + solid-vs-dashed,
   color modes, edge-kind toggles. *(Representation replaced in phase E; the
   colour modes, edge chips and provenance rendering survived.)*
3. **C — panels**: node info panel, source full/diff, editor jump, Cmd+P
   fuzzy search, settings UI.
4. **D — questions + changes**: cards, explore/ask endpoints (structured
   explore refactor), Changes view with badges + impact radius,
   auto-expansion, feedback export, URL state.
5. **E — sunburst**: replace the force canvas with the radial disk +
   hierarchical edge bundling (canvas 2D, no rendering dependency); re-root
   navigation, breadcrumb, arc labels, rims/glow, root-based URL state.
6. **F — canvas review**: depth by kind, sort modes (structural default),
   horizontal label fallback, destination-naming centre circle, grey
   directories, hover connectivity dimming, direction-coloured edges, no edge
   tooltips, no on-canvas telemetry. Then a second pass over the **panels**:
   legend + fit to the left column, selection split into node + code panels
   that collapse, qualified references, agreeing card counts, one owner for
   Escape, transition-free DOM.

## House rules for every phase

- The customer/validation project's name must NEVER appear anywhere in this
  repo (code, comments, fixtures, docs). Use generic examples.
- No new runtime dependencies for the server. Frontend deps are devDependencies.
- Do not regress the MCP server, CLI, or index pipeline; `npm test` stays green.
- No UI test coverage required for v1 (explicit scope decision).
- CHANGELOG entry per phase under `[Unreleased]`, user-facing wording.
