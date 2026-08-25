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

### Phase F clarifications — round 2 (additive; supersedes four phase F items)

A second manual review of the phase F build. Everything here refines phase F's
own numbers and wording; no contract item and no endpoint shape changed.

- **The fallback label is RADIAL, not screen-horizontal.** When a name cannot
  follow its arc it is drawn **along the radius**, on the wedge's angular
  bisector, flipped 180° on the left half of the disk (`cos(mid) < 0`) so it is
  never upside down — the convention every sunburst uses. The room it has is the
  wedge's own geometry with the axes swapped from the curved case: the **radial
  depth** (`r1 - r0`) is the line's LENGTH, the **angular chord at the centroid**
  (`span × midRadius`) its HEIGHT. Gates (≥18px of length, ≥8px of height, both
  evaluated before any `measureText`) and the **≥3-characters-or-nothing** rule
  are unchanged. *Supersedes phase F's "Label fallback".* The horizontal
  fallback scattered text at every angle across the disk and collided with
  neighbours; radial text is bounded by the wedge that owns it.
- **Depth by kind is FLIPPED: directory 1, file 4/3, symbol 4/3.** Radial depth
  is now the label's room, and the long names are the files' and the symbols'
  (`canvas-controller.ts` vs `graph`), so the wedges that carry them get a third
  more room than a directory rather than less. *Supersedes phase F's "Radial
  depth encodes the kind" ratios (1 · ¾ · ½); everything else about it stands* —
  bands still pack from the inside out and end at their tallest wedge, hit
  testing is still against the **band** (so the empty band behind a shallow
  DIRECTORY wedge still belongs to that directory), and a fold arc still takes
  the deepest factor among the children it folded. `MAX_RADIUS` (the fallback
  used before a layout exists) is computed at the deepest factor; a real layout
  reports its own `maxRadius`, which is what the camera fits to.
- **A fold arc is labelled `+N`.** "smaller" ate the room the number needed;
  the arc is drawn at the same size as its neighbours and the tooltip still
  explains what it folded and how to reach it.
- **The centre circle names WHERE YOU ARE.** The current root's name, prominent,
  with its LoC under it (`5,176 loc`) — and, when there is somewhere up, a small
  secondary `▲ <parent>` hint above it. It is still a button and still re-roots
  one level out; at the project root the hint is simply absent and the name is
  the project root directory's. *Supersedes phase F's "The centre circle names
  its destination"*: the disk shows one subtree at a time and the centre is the
  only thing that can say which one, which matters more than pre-announcing a
  click's destination — especially now that the breadcrumb is gone.
- **The bottom band is gone.** No breadcrumb, no edge-kind chips: up-navigation
  is the centre circle, ⌘P and the URL. `CanvasController` keeps
  `setEdgeKinds`/`enabledEdgeKinds` (URL state still restores them) and
  `ViewSummary` still carries `breadcrumb`, `edgeKinds` and `enabledKinds` — but
  nothing renders them, and `<GraphCanvas>`'s only chrome is the arc tooltip.
- **Collapse is now every panel's affordance, on both columns.** The QUESTIONS
  and LEGEND panels fold to their title bars exactly like the node and code
  panels (same `PanelButton`, same chevrons); the legend keeps its mode switch
  and `fit` in the title bar while folded, and the questions panel gives its
  `flex-1` back to the column. State is per panel and lives in the shell.
- **The legend drops the provenance rows.** Colour swatches (kind/layer) and
  incoming-green / outgoing-amber only. Dashed rendering on the canvas is
  untouched — `EDGE_PROVENANCE_LEGEND` simply has no reader in the UI any more;
  the node panel already names a synthesized relation in words on the row
  itself. *Supersedes "The legend carries both vocabularies"'s provenance half.*
- **An incoming `extends` reads `extended by`.** Edges are stored in the
  direction the source declares them, so an incoming inheritance edge means
  "that symbol extends THIS one"; `INCOMING_KIND_LABELS` in the node panel is
  the (currently single-entry) table for that. The other incoming groups are
  left alone deliberately — `implements`/`overrides` have the same shape and can
  join the table the day anyone finds them confusing, while `calls`/`imports`/
  `references` read fine under the ← arrow and gain nothing from a passive
  voice on every row.
- **A `<label>` must not wrap a group of buttons.** The settings dialog's
  "Graph order" control was inside the shared `Field`, which renders a
  `<label>`; a label forwards every click that does not land on interactive
  content to its **first labelable descendant**, so clicking the caption, the
  hint, or the empty row beside the two buttons synthesised a click on the FIRST
  button (`structural`) and silently discarded the user's choice — which Save
  then honestly persisted. `Field` takes a `group` flag and renders
  `<div role="group">` for control sets; only a single-input field stays a
  `<label>`. Save additionally re-publishes the **persisted** order to the shell
  (`onSortModeChange(view.sortMode)`), so the file, the dialog and the disk
  cannot disagree after a write. The server round-trip was never at fault:
  `PUT /api/settings` with `sortMode` → `GET` returns it (verified live).

### Phase F clarifications — round 3 (additive; supersedes three round-2 items)

A third manual review. Everything here refines the layout, the labels and the
chrome; no contract item and no endpoint shape changed.

- **Radii are PER BRANCH, not per ring.** A wedge's children start at **that
  wedge's own outer radius** (`parent.r1`), so a directory always touches the
  children it contains. *Supersedes the band model* ("bands pack from the inside
  out — a band ends at its tallest wedge and the next band starts there"), which
  sized every band by its **tallest** wedge: with directories 1 deep and files
  4/3 deep, a directory whose siblings were files was followed by a strip of
  blank disk before its own children began. Measured on a real 14.2k-node
  project (83 roots × both sort modes, 14,756 parent→child pairs): **every**
  pair had a gap, mean 6.2 layout units, worst 20.7 — a third of a ring of
  whitespace. It is now exactly 0 for every pair. The 2-unit inter-ring gap went
  with the bands; ring 1 still starts at the centre disk's edge.
  - The disk stays bounded by the same two caps: **6 rings**, and
    `MAX_RADIUS` — now `CENTRE_RADIUS + Σ ringThickness(n) × 4/3` = **430**
    (down from 440, since the gaps are gone), which is exactly the deepest
    possible branch. A branch that would pass it folds there, reporting
    `truncated` like the depth cap does. On the same project the project root
    draws 327 arcs over 6 rings out to radius 350; the deepest sampled branch
    reached 363.
  - `SunburstLayout.bands[]` is **gone**. Hit testing is now **angle first,
    then radius**: for each ring, a binary search over that ring's arcs (sorted
    by `a0`, angularly disjoint) finds the arc owning the angle, and it is kept
    only if the radius lands in its own `[r0, r1)`. Cost is
    `rings × log(arcs/ring)` — cheaper than the band scan it replaces. Ring is
    no longer a radial interval, so the search cannot stop at the first ring
    whose band contains the radius.
  - *Supersedes round 2's "hit testing is still against the band"*: the wedge's
    painted extent IS its click target now. Nothing was lost — a shallow wedge
    is no longer followed by empty band, because whatever it contains starts
    where it ends.
  - Still a **pure deterministic function of (model, rootId, options)**;
    verified by re-running every sampled layout and comparing the arcs.
- **Label orientation is MEASURED, not preferred.** For each wedge, compare its
  **tangential** extent at the label radius (`span × midRadius`, in px) with its
  **radial** extent (`r1 - r0`, in px) and run the text along the longer one:
  tangential > radial → the curved-along-the-arc layout, else the radial one.
  *Supersedes round 2's "curved is the first choice, radial is the fallback"* —
  a fixed preference reads backwards on exactly the wedges per-branch radii
  produce, deep and narrow. Both layouts keep their own gates
  (curved: ≥38px of arc, ≥11px thick; radial: ≥18px long, ≥8px high, both
  evaluated before any `measureText`) and the **≥3-characters-or-nothing** rule;
  if the picked orientation cannot fit a name, the other is tried before the
  wedge is left bare for the hover tooltip.
- **Search and settings are icon buttons in the CODEGRAPH panel's header**,
  beside its collapse control, using the same `PanelButton` as every other
  title bar. The "Search the graph…" bar and the settings button that sat in a
  row of their own under the panel are gone; ⌘P is unchanged, and the two
  buttons keep their `open-palette` / `open-settings` test ids.
- **The node panel's EDGES are side by side.** One `edges` heading over two
  columns, `incoming` | `outgoing`, each with its own count and its own
  kind-grouped list. They used to stack, which pushed the incoming half off the
  bottom of a panel that shares its column with the code. Qualified names and
  the `extended by` relabelling of an incoming `extends` are unchanged.
- **Back/Forward walk the selection history.** The hash is the state, so it is
  also the history: **navigation pushes, everything else replaces.**
  - `pushState` for a change of **root**, **selection** (including clearing it)
    or **active card**; `replaceState` for the camera (pan / zoom / fit), the
    colour mode and the edge-kind set. A hover changes none of them and writes
    nothing.
  - The URL gained **`s`** — the selected node id — alongside `r`/`c`/`m`/`k`.
    Without it Back could restore where you were looking but not what you had
    open.
  - Writes are debounced (300ms), which is also the coalescer: a re-root that
    moves the selection with it is **one** entry. The shell keeps the state the
    hash currently carries and **diffs before writing** — identical state is
    dropped, so nothing can spam the history. The first write of a session
    replaces (the entry the user arrived on).
  - `popstate` decodes the hash and applies the **whole** state (root,
    selection, card + its highlight, colour mode, edge kinds) through the same
    function the initial restore uses, then records it as the current state —
    so the writes its own setters schedule find nothing to say and no entry is
    pushed for a navigation the browser already performed. Any write still in
    flight is cancelled first.

### Phase F clarifications — round 4 (additive; supersedes three round-3 items)

A fourth manual review. It restores one thing round 3 removed, puts one thing
round 3 moved back where it belongs, and adds four affordances. No contract item
and no endpoint shape changed.

- **The inter-ring gap is back — `RING_GAP = 2`, now PER BRANCH.** A wedge's
  children start at `parent.r1 + RING_GAP`. *Supersedes round 3's "the 2-unit
  inter-ring gap went with the bands"*: flush radii proved the per-branch model
  but read as one solid block of colour, with no seam to tell a parent from what
  it contains. Two units is the original value and is uniform everywhere — a
  hairline, not the third-of-a-ring of whitespace the band model produced. Ring 1
  still starts at the centre disk's edge. Measured on a real 14.2k-node project
  (561 roots × both sort modes, **41,648** parent→child pairs): the gap is
  exactly 2 for every single pair, min = max = 2.
- **Radial depth is now LABEL-FIT, in the layout.** A directory is still exactly
  1. A file or symbol interpolates between **4/3 and 5/3** of the ring thickness
  by how much room its name wants — `length × LABEL_CHAR_WIDTH` layout units,
  ramped between a 22-unit floor and a 132-unit ceiling and clamped at both ends
  (`labelDepthFactor`). A run of siblings therefore reads as a staircase:
  `a.js` sits at the floor (1.333), `a2.js` a hair deeper (1.350),
  `canvas-controller.ts` near the ceiling (1.600). *Supersedes round 2's flat
  "file 4/3, symbol 4/3"* — depth has been the label's room since round 2, so it
  should be sized by the label, not by the kind.
  - The layout stays a **pure deterministic function of (model, rootId,
    options)**: `LABEL_CHAR_WIDTH` is a fixed average glyph advance, and the
    layout never touches a canvas or `measureText`. A name that ends up a few
    units short is truncated by the painter exactly as before.
  - A `+N` fold arc still takes the deepest factor among the children it folded,
    so it is never shallower than the siblings it stands in for.
  - `MAX_RADIUS` is recomputed at the new ceiling:
    `CENTRE_RADIUS + Σ (ringThickness(n) × 5/3) + 5 × RING_GAP` = **532**. On the
    probe project the deepest sampled branch reached 418; every one of 47,360
    arcs stayed inside the cap, every hit test round-tripped on its own centroid,
    and 1,122 re-run layouts were byte-identical.
- **The label pass is deferred while the camera moves.** Zooming used to re-run
  the whole label layout every frame — an orientation choice plus a `measureText`
  per candidate wedge per tick, plus one `measureText` per GLYPH for every curved
  label — which is what made a zoom judder the moment names came into range.
  Three changes, and the picture **at rest is unchanged**:
  1. a **text-metrics cache** keyed by (bucketed font size, string); font sizes
     are bucketed to a half pixel, which is what stops a continuous zoom from
     missing the cache on every frame;
  2. per-arc label **geometry is precomputed once per layout** (mid angle, its
     sine/cosine, label radius, tangential and radial extents in layout units) —
     these are properties of the wedge, not of the frame;
  3. while the camera is in motion the painter **replays the last plan** through
     arithmetic gates only — the same thresholds against the wedge's extents at
     the current scale, plus the plan's already-measured width — and the full
     pass runs once the camera has been still for **100ms**. The plan's font is
     held for the length of the gesture (it only ever varies between 8 and
     12.5px, so this is not visible, and it keeps every metric a cache hit). The
     replay can only ever DROP a label, never invent one.
  The re-root animation counts as camera motion for this purpose, so a drill-in
  is planned once and re-planned when it lands.
- **Changed files wear their diff on the rim.** A file wedge with uncommitted
  edits gets up to two thin bars on the OUTER band of its own radial extent,
  **stacked radially — green (added) outermost, red (removed) directly inside
  it** — each running along the arc for the share of the file's own line count it
  accounts for (clamped to the full span). Stacked rather than side by side
  angularly because the angle already means "how much code is here", and
  re-using it would make a small heavily-edited file read as a big one. Data is
  `GET /api/changes` (`hunks` counted per file, `changedFiles[].nodeId` for the
  wedge); it is now fetched for **every** view, not just the Changes card, and
  refreshed on `dataVersion`. Always on, deliberately subtle.
- **⌘P pulses what it landed on.** After the palette reveals a node the wedge
  breathes three times over ~1s (opacity + stroke width, decaying), starting when
  the re-root transition ENDS. A re-root can move the whole picture; "which of
  these 300 arcs did I just ask for" should not be answered by reading.
- **The legend is a filter.** Clicking a kind/layer swatch makes that category
  **invisible** — not painted, no label, no tooltip, and the pointer goes
  straight through it — while the **layout is untouched**, so the wedges keep
  their angular space and nothing else moves. A filter that re-flows the picture
  is a filter you cannot use to compare two states. Switched-off rows render
  muted and struck through. State is **session-only** (shell state, not the
  hash): hiding a kind is how you are reading the disk this minute, not the view
  you would send someone — the same reasoning that keeps the sort mode in
  settings.
- **Per-node IMPACT mode.** An `impact` toggle in the node panel's title bar
  lights the selected node plus its **transitive dependents** and dims everything
  else with the same treatment a question card uses (dimmed wedges keep dimmed
  labels). The closure is computed **client-side**: the model already holds every
  non-`contains` edge indexed by node, so the walk is local — seeded with the
  node and everything it contains (a file's dependents are its symbols'
  dependents), then following edges BACKWARDS (an edge's source depends on its
  target), capped at 4,000 nodes. `/api/changes`'s `impactedNodeIds` is a
  different question (depth-2, seeded from a whole changeset) and is left alone.
  Toggling off, or selecting another node, clears it.
- **The disk is drivable from the keyboard.** `←`/`→` walk the SIBLINGS in
  display order (wrapping — a ring is a circle), `↑` selects the containing
  wedge, `↓` the first wedge inside, and `Enter` re-roots onto the selection.
  With nothing selected any arrow lands on the first wedge of ring 1. Arrow keys
  stand down whenever a dialog is up or a field has focus. A **(?) icon button**
  in the CODEGRAPH header opens a compact shortcut overlay (⌘P, arrows, Enter,
  Esc, Back/Forward); Escape's priority is now **⌘P palette → help → settings →
  feedback export → selection**. No transitions, like every other surface here.
- **EDGES belong to the LEGEND.** The side-by-side incoming|outgoing treatment is
  one compact row in the legend panel on the LEFT — `EDGES ● incoming ●
  outgoing`, colours from `EDGE_DIRECTION_LEGEND`. The node panel's own lists are
  **stacked again**, outgoing then incoming, one after the other. *Supersedes
  round 3's "the node panel's EDGES are side by side"*: halving their width
  halved the room a qualified name (`analytics.send`) has to be readable in,
  which is the whole reason those names are qualified. An empty half is left out
  entirely rather than printed as a `· 0` heading over nothing.

Standing views (always-present cards, client-side): **Project** (whole graph)
and **Changes** (`/api/changes`, refreshed on `dataVersion` change).

**Feedback export**: from a card + selected nodes, generate markdown (file
paths, line spans, user note) to paste into an agent prompt. Client-side only.

### Phase G — multi-disk workspace (1) (additive; no contract item changed)

The canvas becomes a **workspace holding N disks** rather than a single disk.
The question that motivates it is task-anchored and cannot be answered by one
sunburst: *a chain of calls between different levels of the system* is not one
subtree, so it is not one disk. Phase G1 is the geometry and the gesture; the
AI-composed flow views and the named saved views that build on it are phases
G2/G3 and are **deliberately not built here** (see the deferrals at the end).

- **The workspace model.** A disk is `{ id, rootId, position (workspace coords),
  its own root / expansion state }`. One **shared camera** (pan + zoom) over the
  whole workspace; disks carry positions, never individual scales — two disks on
  screen are always the same size, which is what makes a wedge in one comparable
  with a wedge in the other. Each disk renders the EXISTING sunburst via
  `computeSunburst(model, disk.rootId, options)` under its own translate:
  **`sunburst.ts` is untouched and never learns that a second disk exists**, and
  `bundling.ts` likewise. The new layer is `web/src/graph/workspace.ts`, and it
  is **pure** — workspace bounds, the fit camera, "which disk owns this point",
  spawn placement, the cross-disk curve — so all of it is numerically probeable
  without a browser. `canvas-controller.ts` orchestrates; it is a layer ABOVE the
  single-disk pipeline, not a fork of it.
- **A one-disk workspace is numerically identical to phase F.** The primary disk
  sits at workspace `(0, 0)` and the camera is anchored there (not to the
  workspace bounding box), so spawning a disk never shoves the picture the user
  is reading sideways — re-framing is an explicit gesture. `fitCamera` returns
  exactly `{ zoom: 1, pan: 0, 0 }` for a single disk at the origin, which is the
  phase F reset. `ZOOM_MIN` drops from 0.5 to **0.12**: `fit` now has to frame a
  whole workspace, and a fit that cannot reach the scale it needs is a fit that
  lies.
- **Hit testing is workspace → disk → the existing angle-first test.** The
  pointer is transformed into workspace space, `diskAt` picks the disk
  (containment, **nearest centre wins** on overlap), the point is translated into
  that disk's local space, and `arcAt` — unchanged, per-ring binary search —
  answers. A disk's radius is its layout's own `maxRadius`, i.e. its real painted
  extent, so a two-ring disk packs tighter than a six-ring one.
- **Spawn by drag-away.** A drag that STARTS on a wedge and crosses that disk's
  **outer radius** spawns a ghost (a dashed circle outline plus the node's name,
  following the cursor); the drop spawns a disk rooted at that node, showing its
  subtree. Crossing the rim is the threshold rather than a pixel distance: "I
  pulled this out of there" is a spatial claim, and the rim is where the user
  sees the disk end. The gesture is reversible right up to the release — coming
  back inside cancels it. The ghost's radius is the prospective disk's real
  radius: the layout is computed once, the moment the ghost appears, and cached,
  so the drop itself is free. Dragging a leaf symbol works; the disk shows that
  node as its root with whatever the layout gives it (a lone centre circle for a
  childless symbol).
- **Gesture disambiguation is decided by WHAT IS UNDER THE POINTER AT PRESS
  TIME**, once, and never re-decided mid-gesture:
  1. **a wedge that renders a node** → a spawn candidate. It becomes a spawn only
     if the pointer leaves the disk's outer radius before release; otherwise the
     drag is a **no-op** and the click underneath does the selecting, exactly as
     if the pointer had never moved.
  2. **anywhere else inside a disk** — the centre circle, the gaps between
     wedges, a `+N` fold arc, a wedge whose category the legend switched off →
     **move that disk**. Everything that is not a wedge is grab-able; the
     alternative (a dedicated drag handle) is a target the user has to find.
     A press on the centre circle that does NOT move is still the up-navigation
     click, unchanged.
  3. **empty canvas** → pan the shared camera, unchanged from phase F.
  4. **a secondary disk's `×`** → close it on release.
  Pressing anywhere inside a disk also FOCUSES it, so the keyboard follows the
  pointer without a second gesture.
- **Disk management.** Every non-primary disk gets a small `×` on its rim while
  it is hovered (drawn in SCREEN space so it keeps its size at any zoom; no
  transitions). **The primary disk cannot be closed** — it is the URL-backed
  view. The **focused disk** is the last one interacted with, and it routes
  keyboard navigation, `Enter` re-root and the centre-circle up-navigation; it
  wears a quiet ring on its centre circle, and only once there is more than one
  disk. `fit` (legend panel) frames **all** disks.
- **Selection is global.** One node is selected at a time and its wedge lights in
  EVERY disk that renders it — the node and code panels are unchanged, because
  there is still exactly one selection. The same is true of every other
  channel: a question card's highlight, hover-connectivity dimming, impact mode,
  the legend's invisible categories and the change markers are all held at NODE
  level on the controller and **projected per disk**, so they apply uniformly
  across the workspace by construction rather than by repetition.
- **Cross-disk edges.** Each relation is routed **once**: both endpoints are
  matched against every disk on a ladder (own arc > folded into a `+N` > the
  disk's own root > an ancestor arc > not in this disk at all), the best match
  wins, ties go to the disk the hover/focus came from and then to creation
  order. Two endpoints in the same disk → the **existing Holten bundling**,
  untouched. Two endpoints in different disks → **one gentle quadratic** between
  the two wedge centroids in workspace space, **no bundling**: bundling routes
  along the hierarchy, and two disks share no hierarchy, so a rope between them
  would read as a detour rather than as a relation. Same green-incoming /
  amber-outgoing direction colours, same dashed-for-`heuristic` rule. **At rest
  nothing is drawn**, unchanged.
- **The source wedge is marked.** A wedge a disk was dragged out of wears a short
  tick on its outer edge for as long as that disk exists. A workspace of four
  disks otherwise gives no answer to "which of these came from where", and the
  only honest place for that answer is the wedge itself.
- **⌘P reveal.** If ANY disk already renders the node, that disk answers —
  reveal and pulse there, and take the focus with it. Nothing moves, because what
  the user asked for is already on screen. Otherwise it is the phase E/F
  behaviour on the primary disk (re-root to the parent, or onto the node itself
  when it was folded away).
- **State scope.** The URL hash is **exactly as today** — `{ r, c, m, k, s }` —
  and describes the **PRIMARY disk only**. An old link therefore opens as a
  single-disk workspace, unchanged, and `getRoot()`/`setRoot()`/`focusNodes()`/
  `setExpanded()` deliberately keep speaking for the primary disk no matter where
  the focus is. Secondary disks are **session-only** in phase G1 (in memory; a
  refresh drops them — named views are phase G3). Spawning, moving and closing a
  secondary disk **never pushes history**; the primary disk's pushState rules are
  untouched. A re-index keeps the whole workspace, dropping only disks whose root
  no longer exists.
- **Performance.** Layouts are cached per `(rootId, sortMode)` and shared between
  disks on the same root, so closing a disk and dragging it out again costs
  nothing; the cache is dropped wholesale when the model or the sort mode
  changes. The round-4 camera-settle label machinery is **per disk** (each keeps
  its own plan) over ONE shared settle window and ONE shared text-metrics cache,
  so a second disk pays nothing for names the first already measured. The
  single-disk frame does the same work it did in phase F.
- **Deferred to later phases, deliberately not built here**: AI-composed flow
  views (a question that lays out its own set of disks), and **named saved
  views** (which is what will make a multi-disk workspace survive a refresh and
  become shareable — and therefore what will decide whether the URL grows beyond
  the primary disk).

### Phase G — multi-disk workspace (2) (additive; supersedes three G1 items)

A manual review of the G1 build. It changes how the arc budget is spent, gives
an expanded wedge an honest representation in the disk it came from, and moves
one affordance. No contract item and no endpoint shape changed.

- **The arc budget is spent BREADTH FIRST, round-robin by sibling index.**
  Every wedge is offered its 1st child before any wedge is offered its 2nd.
  *Supersedes phase E's "a file or symbol only grows a ring of its own once its
  wedge is ≥ 6°"* and the whole-ring rejection ("never render a partial ring"):
  a small file used to show **nothing** until the user drilled into it, which
  reads as "the children were silently dropped", and a ring that did not fit the
  budget vanished entirely. A ring is now laid out in three passes:
  1. **Per-parent geometric fit** — unchanged. Each parent decides on its own
     which children it can render at the minimum sliver (1.1°, capped at 96
     slots) and folds the rest. The minimum arc angle still governs how many
     children a thin wedge can *ever* show.
  2. **Round-robin** over every parent in the ring, in the order their wedges sit
     around the disk, taking one child per parent per pass until the budget runs
     out. The budget is charged for fold arcs too, and a parent that is holding
     anything back is charged for its `+N` arc **before** it is offered another
     child — which is what makes the cap exact rather than approximate.
  3. **Sizing** — the granted children keep the sort mode's display order;
     everything else (geometric tail *and* budget remainder) folds into that
     parent's single `+N` arc, drawn last, exactly as before.

  **The invariant.** Write `K(p)` for the children of parent `p` that survive
  `p`'s own geometric fit and `A(p)` for those actually rendered. Within one
  ring: `A(p)` is a **prefix of `p`'s fitted survivors in display order**, and
  `A(p) < K(p)` (p was cut short by the budget) **implies `A(q) ≤ A(p) + 1` for
  every other parent `q` in that ring** — the `+1` because the budget can run out
  part-way through a round. In words: no wedge gets a second child while another
  wedge still has none. Rings are still laid out outward in order, so the budget
  is spent shallowest first, which is what "breadth first" means for a disk whose
  deeper rings do not exist until the ring above them is placed.

  Only the *kind* gate is gone from `canDescend`; the geometric floor stays — one
  child needs one sliver, more than one needs two (the second slot is the fold
  arc), because a ring of nothing but `+N` arcs stacked radially outward is
  noise and the parent's own tooltip already says how many it is holding back.
  Measured on a real 14.2k-node project (559 roots × both sort modes): the layout
  draws **+12.2%** arcs, **2,912** parents that previously showed fewer children
  (or none) now show them, and the largest disk grew from 327 to 414 arcs — still
  a fifth of the 2,000 budget. Under forced caps as low as 8 arcs (2,992 layouts,
  2,870 budget-cut parents) the cap was never exceeded, the `A_max − A_cut`
  spread was never more than 1, every `+N` count was exact and every layout
  re-ran byte-identically.
- **A wedge expanded as its own disk COLLAPSES where it came from.** While a
  secondary disk is rooted at a node, every other disk draws that node as a stub:
  1. **one third of its normal radial depth** (`COLLAPSED_DEPTH_SHARE`) — its
     angle is untouched, so nothing around it moves;
  2. **no children**, and nothing folded into a `+N` for it either. There is no
     "more inside" to promise: the more is on the other disk, in full. The
     un-rendered subtree simply frees arc budget, which the round-robin above
     then gives to the wedges that do still have children to show;
  3. **no code edges**, to it or to anything in its subtree, in that disk. The
     projection ladder scores the whole collapsed subtree **0** there, so every
     relation routes to the disk that actually renders the endpoint. Drawing a
     rope onto a stub would attach a relation to a wedge that cannot be read.

  `collapsed` is an option of `computeSunburst` and a set on the resulting
  layout, so the layout stays a **pure deterministic function of (model, rootId,
  options)** — and it is part of the layout cache key alongside the root and the
  sort mode, so closing a disk restores the previously cached layouts and a
  spawn/close round trip still costs nothing. A node is never collapsed in the
  disk it is the ROOT of. Closing the disk restores the wedge in full.
- **One tether per expanded disk, always visible.** A single quiet line from the
  rim of the disk holding the collapsed wedge — at that wedge's **mid angle** —
  to the **nearest point on the expanded disk's rim**. *Supersedes G1's
  "expanded elsewhere" tick*, which was removed: a mark on the source wedge said
  *that* something had been pulled out but not *which* disk it became. The tether
  is deliberately **not** a code edge and does not look like one — neutral slate,
  thin, solid, and drawn under the relations — where relations appear only on
  hover/selection and carry the green-incoming / amber-outgoing colours and the
  dashed-for-`heuristic` rule. It represents the expansion relationship, nothing
  about the code. When the two disks overlap far enough that the rim anchor falls
  inside the expanded disk, nothing is drawn rather than a line pointing the
  wrong way.
- **The close `×` moved from the rim to the CENTRE**, under the `N loc` line,
  still screen-sized, still hover-only, still non-primary disks only, still no
  transitions. *Supersedes G1's "a small `×` on its rim"*: on the rim it competed
  with the wedges for the eye and shifted every time a re-root changed the disk's
  radius. The centre circle is the one part of a disk that is always chrome
  rather than data, and "close this disk" is chrome. It is hit-tested before the
  centre circle, so a press on it never reads as the centre's up-navigation.
- **The keyboard overlay gets the settings dialog's panel.** It hand-rolled its
  own container classes and named a `bg-card` colour the theme does not define,
  so it rendered with **no background** and the disk showed straight through the
  shortcut list. It now uses the same `Card` the settings dialog does, so the two
  cannot drift.

### Phase G — multi-disk workspace (3) (additive; supersedes four G1/G2 items)

A manual review of the G2 build. It changes how an expanded wedge is drawn and
tied back, moves the close affordance onto that tie, narrows hover and selection
to a node's own relations, and states the invariant that a view never moves the
camera. No contract item and no endpoint shape changed.

- **An expanded wedge is a full-height SPOKE, out to the rim.** A wedge whose
  subtree is open as its own disk keeps its angle and its inner radius `r0` and
  is stretched OUTWARD to the disk's own `maxRadius`. It still renders no
  children and still folds nothing into a `+N`. *Supersedes G2's
  `COLLAPSED_DEPTH_SHARE` third-depth stub*: a wedge shorter than its siblings
  read as "this shrank", disappeared into the ring rather than standing out of
  it, and gave the tether nowhere honest to leave from. A spoke that touches the
  rim reads as an open channel and is exactly where the tether starts.
  - **The stretch lives in the LAYOUT, as a post-pass**, not as a paint-time
    override in the controller. Two reasons: the rim is not known until every
    arc is placed, and putting the extent in the arc means `arcAt` covers the
    whole stretched spoke for free — a paint-time override would need its own
    parallel hit test, which is how a click target drifts from what is drawn.
  - It is **one-directional and cannot move anything**. The wedge is placed at
    its NATURAL depth first, so `maxRadius` already accounts for it; the
    post-pass then only ever grows it INTO disk that already exists. Siblings'
    radii, the ring structure and the disk's own radius are untouched, and a
    collapsed layout is never larger than the same layout uncollapsed.
  - Probed on a real 13.8k-node project (88 collapse cases over 41 roots): the
    stub's `r1` equalled `maxRadius` in every case (mean stretch **156 layout
    units**), every one of 891 shared arcs at or inside the stub's ring was
    byte-identical to the uncollapsed layout, no descendant of a collapsed wedge
    was drawn, and the hit test round-tripped at 2 %, 25 %, 50 %, 75 % and 98 %
    of the stretched extent.
- **The tether is a cubic BÉZIER, rim to rim.** It starts on the source disk's
  rim at the collapsed wedge's mid angle — where that wedge's spoke meets the
  rim, so the curve continues the wedge rather than attaching to the disk —
  **leaves radially** (first control arm along the same radius), and **arrives
  radially** at the nearest point of the expanded disk's rim (second arm along
  that disk's radius through the arrival point). Both arms are
  `clamp(gap × 0.42, 8, gap / 2)`, so the curve is symmetric and can never loop
  back on itself. *Supersedes G2's straight rim-to-rim line*, which read as a
  chord across the workspace rather than as something leaving one disk for
  another. Everything else about it stands: quiet slate, thin, solid, under the
  code edges, always visible, and **nothing is drawn** when the rim anchor falls
  inside the expanded disk. The geometry is pure and lives in `workspace.ts`
  (`tetherCurve` / `tetherPointAt` / `tetherPolyline`), so it is probeable
  without a browser — 243 curves over 52 mid angles × 5 placements: start on the
  source rim at the mid angle, end on the target rim and demonstrably the
  NEAREST point of it, both tangents radial to within 1e-9, 17 overlapping
  placements correctly refused.
  - When no disk renders the source wedge any more (the source disk was
    re-rooted away), the tether still leaves the source DISK, from the point of
    its rim facing the expanded one. The tether carries the close button now, so
    it has to survive a re-root that hid the wedge it came from.
- **The close `×` sits ON the tether, at its midpoint.** It appears when the
  pointer is on the tether (the sampled curve, small screen-space tolerance) and
  closes the disk on click; the button's own hit area counts as the line's, so
  the affordance cannot vanish on the way to it. Still screen-sized, still no
  transitions, still secondary disks only. *Supersedes G2's "the close `×` moved
  from the rim to the CENTRE"* — and the centre affordance is **gone entirely**.
  The button belongs to the RELATIONSHIP, not to either disk: the tether is the
  one mark that means "this disk is an expansion of that wedge", and closing the
  disk is the undoing of exactly that. In the centre it sat on the disk's own
  caption and could only be found by hovering the disk itself.
- **Hover and selection show a node's OWN edges — never its subtree's.** A wedge
  lights the relations incident to the node it renders, and nothing else: a
  class with one outgoing and three incoming relations draws exactly four ropes.
  *Supersedes phase E/F's "hover bundles the arc's SUBTREE's edges"* and phase
  F's "connectivity is aggregated exactly like the card highlight, the hovered
  wedge's whole subtree is the source": on a real project a container wedge
  averaged **38 aggregated relations against 4 of its own** — a hairball with no
  single subject, in which the wedge's own relations were unfindable. A child
  rendered as its own wedge owns its own relations through its own hover.
  - An aggregate `+N` wedge stands for several nodes at once, so it takes each
    of THEIR own edges — the same rule applied to each node it stands in for.
  - **The hover DIMMING follows the same rule**, by construction: the dimming
    set is derived from the very edges just collected, so what stays lit is the
    hovered wedge plus whatever it actually has a relation with. The hovered
    wedge's descendants are no longer kept lit for being descendants —
    containment is what the disk already draws.
  - Question-card and impact projections are untouched: they highlight node
    SETS, which is a different question from "what does this one thing touch".
- **Inside a card view, the hover is scoped to the card.** While a question card
  carries an edge set, hovering a node shows
  `intersection(card edges, that node's own edges)` — a card is a view of one
  answer, and a hover inside it is a question about that answer, not about the
  graph. With no card active (or a view with no edges of its own, e.g. Changes)
  the own-edges rule above applies unchanged.
  - The card's own edge set stays drawn while the card is active — that IS the
    view. What the scoping removes is the hover's ability to ADD relations the
    card never claimed; the intersection is what the hover then colours by
    direction (green in, amber out) and what the dimming reads. Narrowing the
    picture to the intersection instead would hide the rest of the answer
    every time the pointer crossed a wedge, which is the answer flickering.
- **Views are HIGHLIGHTERS: switching one never moves the camera.** Activating
  or deactivating a card, Changes or Project performs **no fit, no pan, no zoom,
  no re-root and no reveal** — it only changes what is lit and what is dimmed.
  *Supersedes phase D's "activating a card frames it" and phase E's "re-root to
  the deepest node containing every result node"*: the shift came from
  `focusNodes(result ids)` in the card-activation path (and `setRoot(ROOT_ID)` +
  `fitView()` on Project), which yanked the picture out from under whatever the
  user was reading — and, an answer being usually spread wide, generally landed
  back on the project root anyway, i.e. it paid a full re-root for nothing.
  Clicking an individual symbol listed IN a card still reveals it: that is an
  explicit navigation act, and now the only one in this path. `focusNodes` stays
  on `CanvasController` as navigation API; nothing in the view layer calls it.

### Explore/ask scope (additive; no contract item changed)

`POST /api/explore` and `POST /api/ask` take an **optional `path`** alongside
`query` / `question`: a project-relative directory (`core`, `packages/api`) or
glob (`packages/api/**`) that scopes the answer to one subtree. It is the same
`path` argument `codegraph_explore` gained on the MCP surface, passed straight
through — one implementation, one spelling, so the Ask box scopes exactly the
way an agent does.

- **Additive and optional.** Omitting `path` is byte-for-byte the previous
  behaviour; the request/response shapes are otherwise unchanged.
- **An unusable scope is not an error.** A path that escapes the project, is
  malformed, or selects no indexed file comes back `200` with the contract's
  empty result shape and the guidance in `summary` — the same rule the MCP
  surface follows, because an error response teaches abandonment. The client
  renders that summary rather than an error toast.
- Scoping restricts candidate files, ranked symbols, emitted source **and** flow
  endpoints, so a returned `nodeIds`/`flow` can only name nodes inside the
  scope.

### Disk identity — centre size and border (additive; no contract item changed)

In a multi-disk workspace the centre circle is what a disk IS, so it now says
so twice over:

- **Centre size is the root's LoC on a log scale.** `centreRadiusFor(rootLoc,
  projectTotalLoc)` pins both ends — a root holding the whole project gets
  exactly ×1.6 of the base `CENTRE_RADIUS`, a one-line root exactly ×0.8 — and
  interpolates `log(rootLoc)/log(projectTotalLoc)` between them. Log, because
  LoC spans four or five orders of magnitude and a linear scale would collapse
  every disk but the project root onto the floor. Pure and deterministic:
  `projectTotalLoc` is constant across a workspace, so two equally-weighted
  roots get equal centres wherever they sit. The ring stack RIDES the centre
  (`maxRadiusFor(centreRadius)`): a bigger centre pushes the same six rings
  outward rather than squeezing them, and the parent→child `RING_GAP` invariant
  is unchanged.
- **Centre border is the root's colour.** A 2.5-unit border ring carries the
  disk root's own colour under the ACTIVE colour mode, through the same
  `colorForNode` + palette the wedges use — grey for a directory, the kind's
  (or layer's) colour otherwise — and re-colours when the mode switches,
  because it is derived, not stored. Hover and keyboard-focus rings are drawn
  just OUTSIDE the identity border instead of replacing it: losing a disk's
  colour the moment you point at it is the wrong trade.

### Phase G — multi-disk workspace (4) (additive; supersedes two G2/G3 items)

A third manual review of the multi-disk build. It makes the LEGEND's filter
reach everything derived from what is on screen, gives the expanded wedge and
its tether an honest reading, hands the right-hand column its own width and
wrap, and states outright that drilling in does not move the camera. No
contract item and no endpoint shape changed.

- **A `+N` fold arc counts what it still stands for.** The number is baked into
  the arc's label at LAYOUT time, and the layout deliberately knows nothing
  about the legend — so the recount happens in the CONTROLLER, at render time,
  from the metadata the layout already exposes: `SunburstArc.aggregated` is
  **every** folded child's node id, so `rendered children + aggregated.length`
  is exactly the parent's child count. Switch `method` off and a `+15` holding
  three of them paints `+12`; switch off everything it folded and the arc is
  **not drawn at all** — unpainted, unlabelled, and the pointer goes straight
  through it, exactly like any other hidden wedge, because a fold arc that
  folds nothing visible promises content that is not there. The stand-in rule
  follows the same set: a `+N` wedge takes the own-edges of the nodes it still
  stands for, and its tooltip reports the same number the wedge does. The
  layout stays a **pure function of (model, root, options)** and nothing moves
  when a category is switched off — the wedges keep their angular space, which
  is the whole point of an invisible-not-reflowed filter.
  - Probed against a live `/api/graph` on a real 13.8k-node project (4,514
    layouts over 1,400 roots × both sort modes, 85,730 arcs): every one of
    1,852 fold arcs summed exactly (15,918 folded ids, no duplicates, every id
    a real child of the parent), each parent wedge's `hiddenChildren` equalled
    its fold arc's id count, 870 synthetic hidden-kind cases recounted exactly
    (3,010 arcs with a non-zero delta, 2,370 correctly reduced to zero and
    therefore not rendered), all 57,640 parent→child pairs sat at exactly
    `RING_GAP = 2`, all 85,730 centroid hit tests round-tripped, and every
    layout re-ran byte-identical.
- **A relation with a hidden endpoint is not drawn, on EITHER side.** A hidden
  wedge already could not be hovered; now it cannot turn up as the far end of
  somebody else's rope either — in any edge display (hover, selection, card
  `edgeRefs`, impact, cross-disk). And when an edge that survives has to attach
  to an ancestor, the projection ladder **skips invisible arcs** and carries on
  to the next visible one (the centre, in the limit), so a rope can never end
  on a wedge that is not painted. *Refines phase F's "an endpoint that is not
  rendered attaches to its deepest visible ancestor"*: invisible is now part of
  "not rendered".
- **An expanded wedge is drawn HOLLOW.** The rim-stretched spoke keeps its
  angle, its inner radius and its full extent out to `maxRadius`, but it is
  filled with the **canvas background** and outlined in the colour it would
  otherwise be filled with (under the active colour mode) — its label wears
  that colour too, since there is no fill behind it any more. *Supersedes G3's
  solid spoke*: stretched to the rim it is by far the largest shape on the
  disk, and painted solid it dominated a picture whose subject is somewhere
  else entirely — the other disk. An outline reads as an open channel. Label,
  hit test and tether anchoring are unchanged.
- **The tether has a direction dot.** A small circle — canvas-background fill,
  the tether's own slate on the border, screen-sized like the `×` — sits where
  the curve ARRIVES, on the expanded disk's rim. A symmetric line between two
  disks otherwise reads as undirected, leaving "which of these two is the
  expansion" to be worked out from the wedge at the far end. It is **not a
  button**: the close `×` stays on the middle of the line, and the dot has no
  hit area of its own.
- **Drilling in never moves the camera.** Clicking a directory wedge re-roots
  its disk **in place**, at its workspace position; zoom and pan are exactly
  what they were. *Supersedes the primary disk's `zoom = 1; pan = 0,0` reset*,
  which fired on every re-root of the URL-backed disk: in a workspace the user
  had panned or zoomed, one disk drilling in yanked the entire view back to the
  default framing. This is the same rule phase G3 stated for views ("views are
  highlighters: switching one never moves the camera"), now applied to
  navigation: `fit` is the one gesture that frames, and it is explicit. The
  wedge-morph re-root animation is untouched. (The disk is still fitted to the
  free viewport at zoom 1, so a re-root can still change the disk's SIZE — that
  is the phase E fit rule, not a camera move.)
- **Backspace goes up.** It re-roots the FOCUSED disk one level out — the
  keyboard twin of clicking its centre circle, and the way back from the
  `Enter` that drilled in. It stands down under exactly the conditions the
  arrows do: a dialog up, or a field/contenteditable holding the focus, so it
  never competes with a text input for the delete key. It is in the (?)
  shortcut overlay with the arrows.
- **The right-hand column is resizable, and the code can wrap.** A drag handle
  on the column's INNER edge sets its width (min 20rem, max 60% of the window,
  clamped again when the window itself shrinks); a `wrap` toggle in the code
  panel's title bar wraps long lines in **both** the source and the diff view,
  off by default. Both are remembered across sessions in **`localStorage`**
  (`web/src/lib/prefs.ts`) — there was no existing client-side preference
  store, and neither belongs in the URL (they describe this browser, not a view
  worth sharing) or in `~/.codegraph/ui.json` (a server write per drag frame).
  No transitions, like every other surface here.
- **The legend list is ~30px taller**, so a project with a dozen kinds shows
  another row or two before it scrolls.

### Performance round (G5) — gesture blit, viewport culling, colour caches (additive; nothing on screen changed)

A render round, not a design round: **nothing about the picture changed**, and
at rest every frame is pixel-identical to G4's. What changed is what a frame
COSTS. Three expanded disks, zoomed in, dragging the camera measured ~33ms per
committed frame — a frame budget and a half, i.e. visible jitter on the one
gesture the user makes constantly. All three fixes live in the controller;
`sunburst.ts` and `workspace.ts` are still pure and are untouched.

- **A camera-only gesture BLITS the last frame instead of re-drawing it.** A
  camera is exactly `(origin, scale)`; every disk, arc, rope, tether and
  screen-space affordance is placed through those two. So while a pan drag or a
  wheel zoom is in flight the painter does not execute the scene at all: it
  keeps a snapshot of the last full frame (canvas → canvas `drawImage`, never
  `getImageData` — a readback is a synchronisation point) together with the
  camera it was painted under, and re-projects it as
  `new = newOrigin + (old − oldOrigin) × (newScale / oldScale)`. Deriving the
  transform from the two cameras rather than from a pan delta is what makes it
  compose a **cursor-anchored** zoom for free, since the wheel handler expresses
  its anchoring as a new `(origin, scale)` pair and nothing else. A pan is
  therefore pixel-exact; a zoom goes slightly soft (and the two screen-sized
  affordances — the close `×`, the tether's direction dot — scale with it) until
  the gesture stops. That is the same trade the G4 label plan already makes, and
  it resolves the same way: the settle window keeps the frame loop alive for
  100ms after the last camera move, the blit window is only 50ms, so the loop is
  **guaranteed** to reach a real redraw — which repaints everything crisply,
  re-plans the labels and refreshes the snapshot.
  - **Invalidation is default-deny, not a list.** `requestDraw()` — what every
    mutation path in the controller already calls — marks the scene dirty, and a
    dirty scene can never be blitted. Only two call sites opt out
    (`requestCameraDraw()`): the `pan` branch of the pointer drag and the wheel
    handler. So the model, a layout, a root, a disk being added / moved / closed,
    a wedge drag or its ghost, a re-root transition, hover, selection, a card's
    highlight, impact mode, the legend filters, the colour mode, the sort mode,
    the change markers, the edge-kind filters and a resize all force a full
    redraw **by construction**, and a future mutation path that forgets about
    the snapshot is merely slower, never wrong. On top of that the blit refuses
    outright while any disk is mid-transition, while the ⌘P pulse is breathing,
    for any drag that is not a pan, and whenever the device pixel ratio or the
    canvas's CSS size differs from the snapshot's. The snapshot is **dropped**
    (not kept) on any frame that is a moment in an animation, so a gesture
    starting right after one can never stamp back a half-morphed picture.
  - **A hover that arrives mid-gesture is deferred, not dropped.** A pan drag
    already suppressed the hover; a wheel zoom has no drag to suppress it with,
    and a hover CHANGE would both dirty the scene and pay for a hit test per
    frame. The pointer position is parked instead and hit-tested once, on the
    first settled frame — the pointer did not move, only what is under it, so
    one answer at the end is the same answer for less work. A press abandons a
    parked hover rather than delivering it late.
- **The settled redraw culls to the viewport.** Making the gesture cheap is not
  enough when the frame it settles into is itself over budget. Three levels,
  all conservative:
  - **disk** — a disk whose bounding circle (`maxRadius` about its workspace
    position) misses the canvas rect paints nothing: no arcs, no centre, no
    labels, none of its own bundled ropes. Its **tether and its cross-disk
    relations are not culled with it** — they live in workspace space and can
    cross a viewport that shows neither of their two disks, so they are culled
    by their own curve's bounding box (endpoints plus control points) instead.
  - **arc** — the screen rect is mapped into the disk's local frame and reduced
    to a distance interval from the centre plus, when the centre is off screen,
    an angular window. A wedge is rejected when `[r0, r1]` misses the distance
    interval or `[a0, a1]` misses the angular window. The same reject runs in
    the label pass (both when a plan is built and when one is replayed) and
    covers the rim, the focus outlines and the change markers, which ride the
    wedge they annotate.
  - **The correctness rule, which is the whole of this item:** the predicate may
    only reject what *provably* cannot touch the rect. A **false negative**
    (painting something that turns out to be off screen) costs a path nobody
    sees; a **false positive** is a hole in the picture. So both windows are
    outer bounds — the distance interval runs from the rect's nearest point to
    its farthest corner, and a rect that CONTAINS the centre subtends every
    angle and therefore constrains nothing. The angular window is exact because
    a rect that misses the centre is convex and sits in an open half-plane
    through it, so its cone is narrower than π and is spanned by its four
    corners. The rect is padded by 24 screen px before any of this, which covers
    strokes, rims and glyphs that sit slightly outside their wedge without any
    of them being modelled. **Hit testing is not culled** — it works from the
    pointer, not the viewport, and already binary-searches per ring.
  - Probed (throwaway numeric probe over the real modules, bundled with
    esbuild): **32,000** (camera, viewport, arc) cases drawn from 28 real
    `computeSunburst` layouts plus hand-built adversarial ones (full-circle
    arcs, a wedge straddling the ±π seam, a viewport containing the centre) —
    **23,237 rejects, 0 violations** against an oracle that samples the sector
    densely *and* tests the rect's own corners against the sector; **20,000**
    angular-overlap cases, 0 violations; and a mutation control (the same
    predicate with its windows shrunk a few percent) that the oracle catches on
    393 cases, so "zero" is a result rather than a blind spot.
- **Colour work is memoised, per-frame string building is not.** `withAlpha`
  was parsing a hex colour and building an `rgba(...)` template per arc per
  frame (twice for a labelled one); it is now a map keyed `(colour, alpha)`,
  byte-identical output — the alphas are a small set by construction (the ring
  step, that times the dim factor, the 0.85 floors, the two edge weights), and
  the one continuous caller is the ⌘P pulse, which is why the cache is emptied
  wholesale at its cap rather than frozen: an entry the pulse pushed out has to
  be able to come back. Each arc's **base fill** is cached per
  `(colour mode, arc key)` — an arc key is a node id, and the palette's answer
  for a node under a mode is fixed for the model's lifetime — which removes a
  `model.get` plus a palette lookup per arc per frame; a new model drops it, and
  the mode is in the key so switching modes needs no invalidation at all. Ink
  (`readableOn`) rides the same scheme. **Emphasis and dimming are deliberately
  NOT cached**: they change with the hover and are already set lookups.
  - Probed: **11,520** memoised-vs-uncached comparisons across the whole kind
    palette, the edge-direction colours, the `rgba(...)` chrome colours and two
    malformed inputs × every alpha the painter uses, before *and* after the cap
    emptied the cache — 0 mismatches.
- **Explicit non-goals, deferred.** No `Path2D` caching per arc (the win is
  real but it needs a per-layout invalidation story of its own, and culling
  already removes most of the path work). No device-pixel-ratio downshift while
  a gesture is in flight (the blit makes the gesture cheap without trading
  sharpness at rest, and a ratio change is exactly what invalidates a snapshot).
  Neither is required by anything above, and both would be judged on their own
  measurements.

### Performance round (G5.1) — the frame is a 50% margin wider than the viewport

G5 as written above culled the redraw to the viewport and snapshotted the
viewport, which made a pan drag **drag black into view**: the pixels beyond the
edge were never painted, so the blit had nothing to stamp there until the
gesture settled 100ms later. The margin is the fix, and it changes only where a
frame is painted — the picture, the cull predicate's correctness rule, and every
invalidation rule above are untouched.

- **A full redraw paints into a virtual viewport expanded by 50% of its own
  width and height on EVERY side** — a rendered area of 2w × 2h with the real
  viewport as its centre quadrant. It goes to an offscreen scene canvas at the
  current device pixel ratio, whose base transform carries the shift, so nothing
  below the compositing step (arcs, ropes, labels, the close `×`, the drag
  ghost) knows the margin exists: it is all still written in viewport
  coordinates. The visible canvas then gets **one `drawImage`** of the centre
  quadrant. The margin is rounded to a whole DEVICE pixel, which is what makes
  that composite a straight copy rather than a resample — **at rest the visible
  pixels are byte-identical to G5's**.
- **The scene canvas IS the snapshot.** G5 copied the finished frame into a
  second offscreen canvas; there is nothing left to copy, since the frame was
  already painted offscreen. The stored camera (`origin`, `scale`, ratio, size)
  survives unchanged in meaning, plus the margin it was painted with — the
  origin is still in viewport coordinates, and the snapshot's own top-left sits
  at `(−marginX, −marginY)` in them, which is the whole of the change to the
  blit's arithmetic.
- **The cull rect is the expanded rect**, at every site that takes one: the
  per-disk bounding-circle reject, the arc windows, the rope and tether boxes,
  and — this one matters as much as the pixels — **the label plan**, which would
  otherwise fill the margin with bare wedges whose labels only appear on settle.
  The 24px `CULL_MARGIN_PX` still rides on top of the margin, for the strokes
  and glyphs that sit slightly outside their wedge at the rect's own edge.
- **What it buys:** a pan of up to **half a viewport in any direction**, and a
  zoom **out to ~0.5×**, read entirely from painted pixels — no black, at any
  point in the gesture. Past that the snapshot runs out and the background shows
  through (never stale or garbage pixels), and the settled redraw fills it in.
  Probed over the real exported `sceneMetrics` / `blitPlacement`: **30,000**
  cases across 8 viewport sizes × 5 device pixel ratios × log-uniform scales —
  **0 identity violations** (camera unmoved ⇒ the centre quadrant maps onto
  `(0, 0, w, h)`, worst error 2.3e-13 px), **0 coverage violations** for pans up
  to ±½ viewport in each axis (worst slack 8.7e-6 px, i.e. the bound is exactly
  ½) and for a 0.5× zoom-out about the viewport centre (slack exactly 0, the
  documented edge); a mutation control that sets the margin back to zero is
  caught on 2,000 of 2,000 cases, so "0" is a result and not a tautology.
- **The cost is memory, and it is accepted:** at ratio 2 the scene canvas is 4×
  the visible pixel count. No downshift and no tiling — both would trade
  sharpness or complexity for a budget nobody has complained about, and the
  round's whole point is that the gesture reads pixels that are already there.

### Performance round (G5.2) — direct culled redraw replaces the blit

G5 and G5.1 above are **reverted in their entirety**; everything else from both
rounds stays. The blit was the wrong trade on the machine it was supposed to
help, and it was measured being wrong.

- **What was measured.** On a large display at device pixel ratio 2, a pan drag
  spent **84ms inside `composite()`'s single `drawImage`** — a copy that is
  supposed to be the cheap part of the frame, and by itself a five-frame stall.
  The cause is the scene canvas's own size: G5.1 made it 2w × 2h, which at
  ratio 2 is **four times the backing store of an already 4× viewport**, past
  the GPU's maximum texture dimension on that display. A canvas over the cap
  falls out of the accelerated path, so the "one `drawImage`" ran in **software**
  — the fast path had quietly become the slowest thing in the frame. Making the
  margin smaller only moves the cliff; the whole structure is what buys the
  problem.
- **Removed:** the offscreen scene canvas and its context, `composite()`, the
  half-viewport margin (`sceneMetrics`, `SceneFrame`, `marginDeviceX/Y`), the
  snapshot camera and `blitPlacement`, `blitFrame`, `captureSnapshot`, the
  `BLIT_GESTURE_MS` window, and the `sceneDirty` / `requestCameraDraw` split
  that existed only to decide whether a frame *could* be blitted. `requestDraw`
  is once again the single entry point every path calls, and `draw()` paints
  straight onto the visible canvas, as it did before G5.
- **Kept, and it is what makes the removal affordable:** the **viewport
  culling** (`makeCull` / `arcVisible`, the per-disk bounding-circle reject, the
  rope and tether box culls), the **colour memos** (`withAlpha`, `readableOn`,
  the per-arc fill cache), and the **label-plan replay** while
  `cameraSettling()` — which is the thing that actually keeps a gesture frame
  cheap, since it is what stops the painter re-measuring text 60 times a second.
  The deferred hover is kept too: the hit test it skips is genuinely per-tick
  work a wheel gesture cannot afford, and it never depended on the blit.
- **The cull rect is the viewport again**, plus the unchanged 24px
  `CULL_MARGIN_PX`. The margin existed only so a blit had painted pixels to
  stamp into; with no blit there is nothing off screen that a later frame has to
  reuse, so painting it is pure waste. Every frame is now painted for exactly
  the pixels the screen shows.
- **Black edges are impossible by construction, not by budget.** The G5.1
  margin bought "a pan of up to half a viewport before the background shows
  through" — a bound, with a failure mode past it. A frame that is always the
  real scene has no bound to exceed and nothing that can be stale: there is no
  second copy of the picture, so there is no way for what is on screen to
  disagree with what the camera says. Pan as far and as fast as you like.
- **The trade this accepts:** a pan/zoom frame re-executes the (culled) scene
  instead of transforming a bitmap. That is the design — culling plus the caches
  is what made the full pass cheap in the first place, and a cheap-but-real
  frame beats a nominally-free one that falls off the GPU.
- Probed after the surgery (throwaway numeric probe over the real modules,
  bundled with esbuild): **6,000** (camera, viewport, arc) cases against real
  `computeSunburst` layouts plus the adversarial trio (full circle, ±π seam,
  viewport containing the centre) — **4,688 rejects, 0 false culls** against the
  same dense-sampling oracle G5 used; the mutation control (windows shrunk 4%)
  is caught on 51 of them, so "0" is still a result.

### Workspace rules (G5.2) — a spawned disk's floor, the palette, and a workspace that survives a refresh

Three rules that all answer the same complaint: the workspace forgets, or goes
somewhere you did not ask it to go.

- **A spawned disk can never navigate above the node it came out of.** The node
  a drag-away was rooted at becomes that disk's **floor** (`DiskState.floorId`),
  fixed for the disk's whole life — it survives drilling in and re-rooting back
  out anywhere inside the subtree, because it is a property of the DISK, not of
  its current root. Without it a secondary disk walks up to the project root and
  becomes a second copy of the primary, or two disks end up pointing at the same
  root, while the tether still claims it came out of a wedge that is now above
  it. The floor is enforced in `setDiskRoot` — the one funnel every re-root goes
  through (the centre circle, Backspace, Enter, a card, ⌘P's drill-down) — as a
  containment test (`canRootAt`) rather than an equality one, so a root that
  somehow landed outside the subtree is refused rather than allowed to keep
  climbing. **At the floor there is simply nothing up:** the centre circle's
  `▲ <parent>` hint is absent, exactly as it is for the primary disk at the
  project root (both read the same `upTarget`), clicking the centre does
  nothing, and Backspace is a no-op — deliberately not "close the disk", since a
  key that navigates four times and then destroys what you were navigating is a
  key nobody can hold down. The primary disk has no floor; the project root
  already stops it.
- **⌘P matches on the NAME.** The `/api/search` index covers a node's qualified
  name and its file path as well, which is right for the `codegraph_explore`
  tool it also feeds and wrong for a palette: in a project with a `canvas/`
  directory, typing `canvas` returned every symbol under it and buried the thing
  actually called `canvas`. The list is filtered to `hit.name` matches, keeping
  the server's own flavour (case-insensitive substring, so the camel infix
  `profileInfo` still reaches `getProfileInfoV2`; a multi-word query needs every
  word somewhere in the name). Results are then **ordered by name**, not by
  relevance — a list you scan for a name you already know is easier to scan
  alphabetically than by a score you cannot see — and each row carries the
  node's **LoC** beside its kind, from the same `sizesOf` weights the centre
  circle's `N loc` reads.
- **Picking a result goes to the wedge that is already there.** If any disk
  renders the node — an arc that exists and is not switched off in the legend;
  the disk's own root always counts, since the centre is drawn whatever the
  filters say — that disk answers: select, pulse, and **pan the minimum
  distance** that brings the wedge on screen (`panIntoView`: a pure translation
  against the free viewport inset by `REVEAL_PAD_PX`, no zoom, no re-framing,
  and a no-op when it is already visible). Only when nothing renders it does ⌘P
  drill, and the disk that drills is the one whose root is the **deepest
  ancestor** of the target — the shortest way down, focused disk first on a tie.
  Because a disk only ever qualifies for a target inside its own subtree, that
  choice can never take a secondary disk above its floor.
- **The workspace is stored per project.** Which disks are open, each one's root
  and floor, and every disk's position (the primary's included) go to
  `localStorage` under `codegraph.ui.workspace.<hash of the project root path>`,
  debounced 300ms because dragging a disk moves it on every pointer frame. It is
  `localStorage` and not the URL for the same reason the panel widths are: it
  describes THIS browser's arrangement, not the view a link shares. **The hash
  still owns the primary disk's root, selection and camera, and on any conflict
  the hash wins** — only the primary's position is stored here. Restore happens
  once the model has arrived, with no animation and no camera move; a stored
  disk whose root no longer exists (a re-index can remove nodes) is dropped
  silently and the store is rewritten without it, and closing a disk updates it
  the same way. There is no "reset" affordance this round.
- Probed alongside the cull check: **400** spawned disks × 24 interleaved
  up-navigations each (`rootUp`, a direct re-root at the parent, a ⌘P reveal of
  a node outside the subtree, a drill-down) — **7,221 up-attempts, 0 escapes**
  from the floor's subtree and 0 disks offering a `▲` hint they should not,
  while the floorless primary still walks all the way back to the project root
  every time. Palette: **273** rows that match a query only through their path
  and **0** of them leak into the list, 120 name queries (whole name and a
  seven-character infix) with 0 misses, and 300 rows sorted with 0 out of order
  plus equal names keeping their input order.

### Performance round (G5.3) — incremental blit: move the last frame, paint only what moved

G5.2 is right about the 84ms and right about the cliff, and still leaves pan
juddering. This round puts a blit back — **viewport-sized only, and with the
region the move exposes filled live every frame**, so it has neither the memory
shape that broke G5.1 nor the black edge that broke G5.

- **The diagnosis G5.2 missed: culling makes a frame cheap in GEOMETRY, not in
  PIXELS.** On an accelerated 2D canvas the arc paths and the per-glyph curved
  labels are not drawn when they are issued — they rasterise at **commit**. A
  culled scene issues far fewer paths, but the ones it does issue still cover
  the viewport, so the compositor still rasterises megapixels every frame. That
  is the residual judder: it scales with the *area* the picture covers, and
  culling cannot reduce that area, because the area is what the user is looking
  at. The only way down is to stop producing the pixels — which is what a blit
  is for.
- **Pan, per frame.** ① One `drawImage` of the snapshot, shifted by the pan
  delta. ② The **exposed region** — the viewport minus the blit's landing rect,
  which for a pan is one or two thin edge strips. ③ Each strip is
  background-filled, **clipped**, and painted by the *ordinary* scene pass with
  the cull rect set to the strip: same arcs, same centres, same edges, same
  tethers, same layering, nothing special-cased — the cull rejects everything
  the pan did not uncover, so a strip is nearly free. ④ **Re-capture**: the
  composed visible canvas is copied back into the snapshot and the stored camera
  advances. That last step is what makes the cost O(*this frame's* delta) rather
  than O(the whole pan): next frame's exposure is only the next few pixels, so a
  drag that crosses three screens never pays more per frame than a drag that
  moves one pixel.
- **The rounded-camera no-drift rule.** Each frame's blit offset is rounded to
  whole **device** pixels, and the camera stored with the snapshot is that
  ROUNDED one — not the true camera. So every delta is measured against what the
  pixels actually show. The error against the true camera is at most **half a
  device pixel per axis and cannot accumulate**, however long the drag runs;
  storing the true camera instead compounds it without bound (the probe's
  mutation control drifts 285 device px over 600 steps). Strips are painted
  under the same rounded camera, so the seam is self-consistent, and the settled
  full redraw repaints exactly and re-captures.
- **Zoom is the other trade.** A wheel frame scales the last **settled**
  snapshot and deliberately **does not re-capture** — re-capturing a resampled
  image compounds its own blur frame over frame, which is how a soft picture
  becomes a wrong one. Zoom-in is soft until the settle window lands the real
  redraw (the same trade the label plan already makes); **zoom-out exposes a
  frame-shaped region around the scaled rect, and that region is filled live
  exactly like a pan strip**, so there is no black there either. Because nothing
  re-bases the snapshot mid-gesture, the accumulated ratio only grows, and past
  **3× either way** the blit is refused: the rest of that gesture is direct
  redraws. Softness has limits, and the limit falls out of the arithmetic rather
  than out of a flag.
- **The viewport-size hard limit.** The snapshot is *always* exactly the size of
  the visible backing store. G5.1's 2w × 2h scene canvas is what put the texture
  past the GPU cap and dropped the composite into software; the exposed region
  is filled live *precisely so* there is never a reason to paint anything off
  screen. Black edges are impossible by construction, not by budget: the blit's
  on-screen part and the exposed rects **tile the viewport exactly** — no gap, no
  overlap — and every exposed rect is background-filled before it is painted.
  That tiling is also what erases the previous frame's chrome without a clear.
- **Layering: capture before chrome.** The snapshot holds the scene only; the
  disk `×`, the tether affordance and the drag ghost are drawn fresh *after* the
  capture, on every frame, full or gesture. They are screen-space and cost two
  circles, and the `×` / tether dot are **hover-gated** while hover is frozen for
  the duration of a gesture — so baking them in would stamp a button the pointer
  has since left. Capturing first is the simplest layering that cannot go stale.
- **Invalidation is default-deny, unchanged in spirit from G5.** `requestDraw()`
  — what every mutation path already calls — marks the scene dirty, and a dirty
  scene is never blitted. **Exactly two sites opt out** (`requestCameraDraw`):
  the pan branch of the pointer-move handler and `onWheel`. So model/layout/root
  changes, a disk spawned, moved or closed, a wedge drag and its ghost, re-root
  transitions, hover, selection, cards, impact mode, legend and edge-kind
  filters, colour and sort modes, the ⌘P pulse, and resize / DPR changes all
  force a full direct redraw by construction; a future path that forgets is
  slower, never wrong. The deferred hover stays, and now schedules a frame
  *without* dirtying — parking a hover changes nothing on screen. A full redraw
  always ends by capturing a fresh snapshot with the exact camera, and the
  capture is skipped (and the snapshot dropped) on any animating or pulsing
  frame: a mid-animation snapshot must never be stamped back.
- **Labels: plan wide, paint narrow.** The label plan is built only at full
  passes; a gesture strip **replays** it and never rebuilds (a plan built from a
  strip would be a plan for the strip, and storing it would throw away every
  label on the rest of the screen). So a wedge a pan has just uncovered would
  arrive bare and be named at settle, ≤100ms later. To make a modest pan
  label-complete immediately, the full pass now builds the plan against the
  viewport **expanded by 200 CSS px per side** while PAINTING stays culled to the
  real rect — planning is one `measureText` pass, painting is the expensive part,
  and only the cheap one grows. The `planStillFits` replay gates are unchanged.
- Probed with a throwaway numeric probe over the real exported `planGestureBlit`
  and `exposedRegion`, bundled with esbuild. **Pan:** 400 random
  viewport/DPR/camera setups × 60 steps = **24,000** cases, with sub-pixel,
  whole-pixel and viewport-sized deltas — **0 gaps, 0 double-draws, 0 strips
  outside the viewport, 0 shape mismatches** against a scanline oracle that
  samples every rect edge and a 25 × 25 grid; strips averaged **8.2% of the
  viewport's area**. **No drift:** **182,921** consecutive rounded steps under a
  deliberately biased sub-pixel drift — **0 violations**, worst error **0.4999998
  device px** (the half-pixel bound, well inside the ≤1 the design asks for).
  **Zoom:** **8,000** cursor-anchored cases over a log-uniform ⅙…6× factor —
  **0 gaps, 0 overlapping strips, 0 outside**, the scaled rect matching the exact
  re-projection of the snapshot's corners, and the 3× refusal firing on exactly
  the 3,069 cases past the bound and no others. **Mutation controls:** storing
  the true camera instead of the rounded one is caught on **35,869 of 36,000**
  steps (worst drift 285 device px), and shrinking each strip by one pixel opens
  a gap on **2,000 of 2,000** cases — so the zeroes above are results, not
  tautologies.

### Code bubbles (B1) — source pinned to the workspace (additive; no contract item changed)

A disk answers *where* something is. A **bubble** answers *what it says*: a
scrollable, selectable, syntax-highlighted slice of source, pinned to the
workspace next to the wedge it came out of. It is the first thing on this canvas
that is **DOM rather than canvas**, and that is deliberate — text selection,
native scrolling and a highlighter are all things a 2D context does badly.

- **The model.** A bubble is `{ node, world x/y (its top-left), box w/h in CSS
  px, scrollTop, expanded }` plus the disk it was dragged from. Its ANCHOR is a
  world point (so it travels with the disk) while its SIZE is screen px (so its
  text is legible at any zoom) — that split is the whole of the hybrid-zoom rule
  below. There is no collision handling and no snapping: bubbles are placed
  where the user drops them, and overlapping two of them is a thing a user is
  allowed to do.
- **Spawn is the phase-G drag-away, forked by KIND.** A drag that starts on a
  wedge and crosses its disk's rim spawns a **bubble** when the node is a LEAF
  (nothing inside it, so a disk of it would be an empty centre circle and the
  code is what the user was reaching for) and a **disk** when it has children —
  phase G's behaviour, unchanged. **⌥ flips it in both directions**, live: hold
  it over a file or a class and the release makes a bubble of its source;
  hold it over a leaf and the release makes a one-node disk. The ghost follows
  the decision — the disk's dashed circle, or a rounded rectangle at exactly the
  size the bubble will read at — and swaps the instant ⌥ goes down or up, even
  with the pointer standing still (the controller listens for the modifier for
  the duration of the drag). A node with no source of its own (a directory)
  always spawns a disk, whatever ⌥ says.
- **Content.** `GET /api/source` for the node's `[startLine, endLine]`, rendered
  with a line-number gutter carrying the REAL file line numbers, highlighted
  through the same lazy `loadHighlighter()` the source panel uses and coloured by
  the same `hljs-code` theme — the two views must not disagree about what a
  keyword looks like. A `file` node's bubble is the whole file. A symbol
  bubble's header carries an **expand to file** toggle, which re-fetches the
  file and lands scrolled to the symbol's own first line (the file is context
  for the thing you dragged out, not a replacement for it). Loading is a muted
  spinner line, a failed fetch is muted red text **inside the bubble** — a file
  that cannot be read is one box's problem, never the canvas's.
- **Hybrid zoom, and the chip.** Screen scale is `min(camera.scale, 1.5)`: a
  bubble grows with the world until text stops being worth enlarging. Below
  `camera.scale = 0.5` the box would be unreadable at any size, so it collapses
  to a **title chip** (name · kind · loc) at a FIXED readable size, anchored at
  the same world point. The scale jumps at that threshold on purpose — the chip
  is a different affordance, not a smaller box. The maths is pure and exported
  (`bubbleScale` / `bubbleIsChip` / `bubblePresentation` / `clampBubbleSize` /
  `bubbleChipWidth` in `canvas-controller.ts`), so crossing the threshold is
  idempotent by construction; the body element is never rebuilt, so the scroll
  position and any selection in it survive a round trip.
- **The overlay does not exist as far as the renderer is concerned.** One
  `pointer-events: none` div over the canvas, one `pointer-events: auto` element
  per bubble, and the controller's only per-frame bubble work is **one CSS
  transform each** (`syncBubbles`, after the frame is painted). Nothing about a
  bubble is ever drawn into the canvas, so the G5.3 incremental blit is
  untouched: a bubble cannot dirty the scene by existing, cannot be baked into a
  snapshot, and adds no third `requestCameraDraw` call site. Its state changes
  (spawn, move, resize, close) go through the ordinary dirty path, exactly like
  a disk being moved. The wheel over a bubble's body scrolls the bubble
  (`stopPropagation` + `overscroll-behavior: contain`); dragging its header
  moves it in world units; a corner grip resizes it inside a clamped range; a
  press raises it above its siblings.
- **The tether is CHROME.** Each bubble draws a quiet cubic from its own edge to
  the centroid of the wedge it came from, in SCREEN space, in the chrome pass —
  after `captureSnapshot`, like the disk `×` and the tether dot — so it is never
  stamped into a blitted frame and follows a pan or zoom gesture live. It leaves
  the box along the line from the box's centre to the wedge and **arrives
  radially** at the wedge, the same convention the disk tether uses, and it
  wears the same direction dot at the code end. The geometry is one exported
  pure function (`bubbleTetherAnchor`), fed the rect that is actually painted
  this frame — box or chip — so the chip case needs no second code path. **If no
  disk renders the origin wedge** (the disk was closed, re-rooted away, or the
  legend made the wedge invisible) **nothing is drawn**: falling back to the
  disk's root would be a false claim about where the code is. Closing a disk
  therefore never closes a bubble; it only takes the thread away.
- **Persistence.** `StoredWorkspace` gains `bubbles: [{ nodeId, x, y, w, h,
  scrollTop, expanded }]`, riding the existing 300ms debounce and the same
  per-project `localStorage` key. The field is optional so a workspace stored
  before this phase restores unchanged. A stored bubble whose node id no longer
  resolves is dropped silently (the disks' rule), and every survivor **re-fetches
  its source** — the file on disk is the truth and a stored copy of it would be
  a stale one. A re-index does the same for the bubbles already on screen.
- **Interaction coherence.** Bubbles capture no keyboard: Escape keeps its
  single owner and its existing priority list, the arrows still drive the disk,
  and ⌘P is untouched. The canvas's own hit testing never sees a pointer event
  that landed on a bubble, so no gesture is ambiguous.
- **Explicit non-goals this phase.** No **call tethers between bubbles** (a
  bubble ties to its origin wedge and to nothing else — relations between two
  bubbles are a later round, and drawing half of them would be worse than
  drawing none). No collision, packing or auto-layout. No diff mode inside a
  bubble. And no **editing**: the recorded future direction is click-to-convert
  a bubble's body into editable text, written back through the editor jump the
  header already has — deliberately not attempted before the read path has been
  used in anger.

### Code bubbles (B2) — call tracing (additive; no contract item changed)

B1 pinned source to the workspace and tied each box to the wedge it came from.
B2 ties the boxes to **each other**, along the calls between them: a thread
leaves the exact line that makes the call, a marker in that line's gutter opens
the callee as the next bubble, and the workspace becomes something you can walk
a flow through rather than a set of quotations. B1's explicit non-goal ("no call
tethers between bubbles… drawing half of them would be worse than drawing none")
is retired here by drawing all three cases at once — bubble→bubble, bubble→wedge,
and the marker that turns the second into the first.

- **The caller anchor is a LINE, not a box.** A thread leaves the border facing
  the callee at the vertical centre of its call-site row: `content top + (line −
  first displayed line) × line-height × scale − scrollTop × scale`. Four
  regimes, each an honest answer rather than a degenerate case of the first —
  `line` (the row is displayed and on screen), `clamped` (the row is scrolled
  out of view or outside the displayed range: the anchor slides to the content's
  top or bottom edge and reports that it did), `header` (the edge carries no
  line — some resolvers do not record one — so the thread claims the BUBBLE and
  no position in it), and `chip` (collapsed: the chip is the whole affordance).
  The callee end is always the callee's header (or chip), and the direction dot
  sits there, so a thread is directed the way B1's tether already is. It is one
  exported pure function (`bubbleCallAnchor`), total over every input, because a
  NaN in a bezier blanks a frame.
- **The geometry it runs on is measured ONCE.** `BubbleView.bodyGeometry()`
  reads header height, gutter padding, row height, row count and first line out
  of the DOM on a content load, and the controller caches it. A frame does
  arithmetic over those numbers and nothing else: twenty threads on screen cost
  zero layout reads. A body that was a chip when its content landed has nothing
  to measure, so the one frame the chip opens back into a box re-measures the
  bubbles that still carry the fallback metrics.
- **The gutter marker plan is a pure mapping.** `mapBubbleCallSites(edges,
  spans, scope)` → `Map<displayed line, callee ids>`, built once per content
  load or expand and never per frame. Only `calls` edges: a marker that
  sometimes meant "this line mentions that" would make the whole column
  untrustworthy. The **containment rule** is what makes an expanded FILE bubble
  work — a file bubble displays many symbols and the outgoing calls belong to
  those symbols, not to the file node — so an edge counts when its source is the
  bubble's own node **or** a node whose file is this file and whose WHOLE span
  falls inside the displayed range. Partial overlap is excluded deliberately: a
  symbol half of which is off the top is a symbol whose call sites this bubble
  cannot honestly claim to be showing. The tethers apply the same rule through
  the same exported predicate (`bubbleCallSiteInScope`), so the marker column and
  the threads can never disagree about which edges a bubble owns.
- **Dedupe: by (caller bubble, callee bubble, kind, line).** Two call sites on
  different lines are two threads — that is the phase's whole claim — while the
  same relation recorded twice is one. Kind stays in the key because a `calls`
  and a `references` between the same pair are two relations, and the legend can
  switch one of them off independently. Threads are drawn for `calls` and
  `references` only: `references` earns its place because that is what the
  framework resolvers emit for a route reaching its handler, the flow developers
  trace most and the one with no `calls` edge to ride. Imports, extends and
  instantiates are structure rather than flow and stay with the disks.
- **Click a marker to open the callee.** It lands to the RIGHT of its caller,
  level with the call site, so a traced chain reads left to right the way the
  calls do. A callee that is already open is never duplicated — it is raised and
  its thread **flashes** for 900ms, which answers "where did that go" without
  putting a second copy of the same code on the canvas. Several callees on one
  line get a minimal picker (hand-rolled to the overlay's own rules: inline
  styles, no transition, dismissed by the next press anywhere), one callee opens
  straight away. A callee with **no source** — external, unresolved — is listed
  dim and inert, and its marker's title says why: a no-op with a reason, never
  an error.
- **The origin model gains a second case.** B1 knew one origin, the WEDGE a
  bubble was dragged out of. A bubble opened from a marker has a different one —
  the caller's own call site — and pointing it at a wedge would claim the disk
  sent it. Such a bubble therefore draws no wedge tether at all; its thread IS
  the call tether, which is drawn while both boxes are open and simply stops
  existing when the caller is closed. The caller is remembered by NODE id (with
  the line), so the link survives being written down and read back, where bubble
  ids do not; both fields are optional, so a pre-B2 workspace restores unchanged
  and a stored caller that no longer resolves demotes the bubble to an ordinary
  one instead of dropping it.
- **Bubble→wedge threads are SUBORDINATE, and capped.** A call whose callee is
  not open as a bubble but IS visible as a wedge (the legend-aware notion ⌘P
  uses; nearest wedge on screen when several disks show it) gets the same thread
  in a fainter, thinner amber, so the workspace reads as one system without the
  disk threads competing with the bubble-to-bubble ones. **At most 24 are drawn
  per frame, nearest first, chosen from at most 400 candidates per bubble**: a
  file bubble with eight hundred calls must not be able to wallpaper the canvas,
  and both bounds keep the per-frame cost independent of the file's size.
- **Still chrome, still invisible to the blit.** Every thread is drawn in the
  chrome pass, after `captureSnapshot`, in screen space, from the live camera —
  so it cannot be baked into a blitted frame and it tracks a pan, a zoom, a
  bubble drag and a bubble SCROLL live. Scrolling a body now marks the scene
  dirty (it did not in B1, where nothing on the canvas depended on the scroll
  offset): a scroll is not a camera gesture, so it must never reuse the
  snapshot. No third `requestCameraDraw` site, and the flash keeps the frame
  loop alive the way the ⌘P pulse does without ever blocking the blit.
- **Colour is the relation vocabulary, not the workspace one.** Unlike the
  expansion tether — which is the workspace saying "that subtree is over there"
  — a call thread IS a relation in the code, so it borrows the direction
  palette's OUTGOING amber (it leaves the caller) and the provenance rule that
  goes with it: a synthesized hop is **dashed** and carries its `synthesizedBy`
  name at the curve's midpoint, which is the one fact a dashed line cannot say
  on its own.
- Probed with throwaway numeric probes over the real exported helpers, bundled
  with esbuild. **Anchors:** 20,000 random rect × scale × metrics × scroll ×
  range × line cases — **0 violations** across finiteness, the side/border
  choice, the closed-form recheck of every in-range line, the top/bottom edge of
  every clamped one, the chip collapse and monotonicity in `line` (7,002 `line`,
  8,157 `clamped`, 2,500 `chip`, 2,341 `header` — every branch exercised).
  **Mapping:** 12,000 random synthetic edge/node sets against a brute-force
  oracle — **0 violations** over 68,020 marked lines and 71,038 callee entries,
  with no line outside the displayed range and no callee set differing from the
  oracle's. **Mutation controls**, each the real bundle with one operator
  changed: dropping the scroll term is caught on 7,434 of 20,000 anchor cases,
  clamping to the box top instead of the content top on 1,958, and counting the
  line the wrong way round on 8,999 (plus 123 monotonicity failures); loosening
  containment to overlap is caught on 7,093 of 12,000 mapping cases, dropping
  the kind filter on 10,823, and dropping the range filter on 5,430 — so the
  zeroes above are results, not tautologies.
- **Explicit non-goals this phase.** No **incoming** threads (a disk wedge
  calling into an open bubble draws nothing — outgoing only, so the direction
  the picture claims is always the direction it means). No **auto-layout of
  chains**: an opened callee is placed once, beside its caller, and is a normal
  bubble from that moment on — draggable, closable, persisted — because packing
  a traced chain would move boxes the user put somewhere on purpose. No
  editing, still: the read path goes first (B1's note stands).

### Code bubbles (B2.1) — fixed-frame presentation (additive; SUPERSEDES B1's hybrid scale and its chip)

B1 gave a bubble a world ANCHOR and a screen SIZE, then scaled that size with
the camera (`min(camera, 1.5)`) and collapsed it to a title chip below
`camera = 0.5`. This round replaces that presentation whole. Everything else
in B1 and B2 stands — the spawn gesture, the content, the tether rules, the
call threads, the gutter markers, the dedupe, the persistence story — and each
of them now runs against the model below. **The chip is gone as a code path,
not merely as a default**: there is no chip geometry, no chip width, no chip
anchor mode and no second rectangle a frame has to choose between.

- **The frame is FIXED in screen space.** A bubble's width and height are the
  user's own CSS px, and the camera only ever moves the frame around the
  screen — it never resizes it. Drag the corner 40px and the box is 40px
  wider, at every zoom, for good. The grip therefore needs no conversion at
  all (screen px *are* frame px), the drag-away ghost is drawn at exactly the
  size the release produces, and a spawn converts its half-extents through
  one number, the camera's scale, rather than through two.
- **Only the TEXT zooms.** The body's font-size and line-height are multiplied
  by the camera scale, keeping B1's upper clamp of **1.5×**: zoom out and the
  same box holds more, smaller lines; zoom in and it holds fewer, larger ones.
  It is applied as a font size rather than as a transform, so the text reflows
  inside a scrollport that has not moved. The header is chrome, not content,
  and does not zoom. The scale is **quantised to 5% steps**
  (`BUBBLE_TEXT_SCALE_STEP`) for one reason and with one consequence: a
  font-size write is a real layout of every row, so a wheel gesture re-lays a
  bubble out about twenty times across the whole range instead of once per
  frame — and because the SAME quantised number feeds the DOM and the anchor
  maths, the two can never disagree about how tall a row is.
- **The scroll-anchor rule is the CENTRE LINE.** A frame whose type changes
  size has to decide what stays still, and the only choice that survives
  zooming both ways is the line the eye is already on. So the content point at
  the frame's vertical centre is preserved: express it as a fractional line
  index `u = (scrollTop + viewportHeight / 2 − padTop) / (lineHeight ×
  fromScale)`, then put the same `u` back at the centre under `toScale`. Whatever
  was in the middle of the box before the zoom is in the middle of it after, and
  the text grows or shrinks around it. It is one exported pure function
  (`bubbleScrollForTextScale`), clamped to the range the browser itself would
  clamp to, so the one case it cannot honour — content too short to put `u` in
  the middle — ends at the edge rather than at a lie. The same scale in and out
  is the identity for any offset already in range, and re-applying the rule to
  its own output changes nothing.
- **Below the threshold the frame is RETAINED.** `camera < 0.5` (B1's number,
  unchanged) no longer shrinks anything: the full-size frame stays exactly
  where it is and the BODY is replaced by the node's **name, kind badge and
  LoC, centred in the middle of the frame** at a fixed readable size. The
  bubble keeps the space it holds in the layout the user built and says what it
  is instead of what it says. **The header row stays** — it is the drag handle
  and it carries close / expand / open-in-editor, and a box you cannot close or
  move at low zoom would be a trap — so the centred block is positioned over
  the whole frame and is `pointer-events: none`, which leaves the header under
  it fully live. The body is hidden with `visibility`, not `display`, so its
  scroll offset, any selection in it and its measured geometry all survive a
  round trip across the threshold untouched; B1's "re-measure the frame the
  chip opens back into a box" dance is therefore deleted rather than ported.
- **Anchors, restated against a fixed frame.** B1's origin tether
  (`bubbleTetherAnchor`) is unchanged in code and changed in meaning: the rect
  it is fed is now the frame, which is the same rectangle whichever face the
  bubble is showing, so the "box or chip" fork it used to serve is gone. B2's
  `bubbleCallAnchor` keeps its four regimes, with the fourth renamed and
  re-pointed: `line`, `clamped` and `header` keep their exact semantics, and
  `chip` becomes **`centered`** — the frame's own middle, on the border facing
  the other end, because there is no row to point at. The call-site formula
  becomes `content top + padTop + (line − firstLine) × lineHeight × textScale +
  half a row − scrollTop`, with no outer multiplication anywhere: **content
  space IS screen space inside an unscaled frame**, which is the single source
  of truth the whole round buys. `scrollTop` is plain CSS px of a fixed-size
  scrollport — what the DOM reports, what is stored and what the arithmetic
  subtracts are one number — and `lineHeight` is the row at text scale 1,
  measured sub-pixel (`getBoundingClientRect`, divided by the scale it was
  measured at) so a rounded `offsetTop` cannot put a few percent of error into
  a metric that then multiplies by the line number. **The camera is not an
  input**: everything it does to an anchor it does by moving the frame.
- **Everything downstream keeps working, and one thing is placed differently.**
  Gutter markers, the multi-callee picker (which now positions in plain frame
  px), the thread flash, bubble→wedge threads, the containment rule and the
  dedupe are all untouched. Click-to-open still lands the callee to the right
  of its caller and level with the call site, now in fixed-frame coordinates:
  the new frame's top is lifted by one header height so that its CONTENT, not
  its border, is level with the line that opened it.
- **Persistence is unchanged and needs no migration.** `w`/`h` are plainly CSS
  px, which is what they effectively already were; there was never a stored
  chip field to drop. Restore reads the fields it knows and ignores anything
  else it finds, so a layout written by an older build — describing a
  presentation that no longer exists — loads as the bubble it always was.
- **The blit is untouched, again.** Bubbles are still DOM in a
  `pointer-events: none` overlay, still never painted into the canvas, still
  drawn-around rather than drawn: threads and tethers remain chrome (after
  `captureSnapshot`, in screen space, from the live camera), snapshots are
  still viewport-sized, and there are still **exactly two** `requestCameraDraw`
  sites. The one new hazard the round introduced is closed explicitly: the
  centre-line rule writes `scrollTop` from code, the DOM answers with a scroll
  event, and a scroll event dirties the scene — which would take a wheel
  gesture off the blit for its whole duration. Such an echo is therefore
  reported as programmatic and updates state (the DOM's clamped answer always
  wins) **without** requesting a draw; the frame that caused it is already
  being drawn. Per-frame text work is a scale compare and nothing else.
- Probed with throwaway numeric probes over the real exported helpers, bundled
  with esbuild. **Anchors:** 20,000 random camera × frame × metrics × scroll ×
  range × line cases — **0 violations** across totality, the side/border
  choice, the anchor never leaving the frame, the closed-form recheck of every
  in-range row under that case's own text scale and scroll offset, the top /
  bottom edge of every clamped one, the centred-label collapse, monotonicity in
  `line` (4,652 checks), and **frame-position-only dependence on the camera** —
  14,484 pan cases where the anchor moved by exactly the frame's screen offset,
  plus 7,353 cases at two DIFFERENT camera scales that agree on the text scale,
  where it did the same. Every branch was exercised (5,010 `line`, 5,516
  `clamped`, 3,704 `header`, 5,770 `centered`). **Scroll anchor:** 15,000
  random (content, scrollTop, fromScale → toScale) cases — **0 violations**
  over 13,136 centre-line preservations, 1,158 clamped ones landing exactly on
  their boundary, 15,000 same-scale identities and 15,000 idempotence checks.
  **Mutation controls**, each the real bundle with one operator changed:
  dropping the scroll term is caught on 5,663 anchor cases, dropping the text
  scale from the row height on 5,100, and scaling the header (B1's rule, which
  is now wrong) on 10,230; re-projecting the scroll under the OLD scale is
  caught on 10,546 scroll cases and anchoring the top line instead of the
  centre one on 40,216 — so the zeroes above are results, not tautologies.

### Code bubbles (B2.2) — world-scaled zoom-out (additive; SUPERSEDES B2.1's fixed frame for camera < 1 ONLY)

B2.1 fixed the frame in screen space in both directions: the camera moved a
bubble and never resized it, at any zoom. Zooming IN that way is right — a box
of text does not get more useful for being enormous — but zooming OUT that way
is wrong, and looking at it settled the question: a full-size box floating over
a workspace of shrunken disks does not read as part of the same picture, and
five of them cover it. So the rule is now split at camera 1, by one number:

```
s = min(camera.scale, 1)          // the FRAME scale
```

- **camera ≥ 1 — B2.1, unchanged, to the letter.** `s = 1`. The frame is the
  user's own CSS px, the camera only moves it, the body's TYPE zooms through
  the quantised font mechanism up to the 1.5× clamp, and the centre-line
  scroll rule keeps the reading position. Nothing in this regime moved.
- **camera < 1 — the frame shrinks with the world.** `s = camera`, so the
  on-screen frame is the set size × `s`, still anchored at its world point.
  A bubble now behaves like a disk on the way out: the workspace zooms as one
  thing.

**The mechanism is a transform, not a re-layout.** `s` is a CSS `scale()` on
the bubble's ROOT (`transform-origin: 0 0`, composited, in the same string as
the translate that was already written every frame), so the whole frame —
header, gutter, source, call markers, scrollbars, the corner grip — shrinks in
exact proportion, and **nothing inside the frame reflows**: `width`/`height`
stay the user's own frame px, the scroll offset is untouched, a text selection
survives, and the content's geometry relative to the frame is constant at every
zoom. Per-frame cost is unchanged: still one transform string per bubble, still
one compare before the write.

**The two zoom mechanisms compose; they never multiply.** Inside a scaled frame
the transform IS the zoom, so the FONT-based text scale is **pinned at 1**
below camera 1 — scaling the type as well would shrink it twice. The composed
on-screen text height is therefore `s × textScale`, which is `camera × 1` below
1 and `1 × min(camera, 1.5)` above it. Both are exactly 1 at camera 1, so
crossing the seam produces **no pop**: the frame scale is continuous by
definition (`min` of two continuous functions), the composed text height is
continuous because the two regimes meet at 1, and the composed frame size is
monotone in the camera throughout. The readability threshold is continuous in
the same sense — the frame and the type do not change size there at all, only
the FACE does. One happy side effect: a wheel gesture anywhere below camera 1
now costs **zero** font writes and zero re-anchoring, where B2.1 re-laid every
row about twenty times across that range.

**The label counter-scales, because it is the one thing that must stay
readable.** Below `camera = 0.5` (B1's number, unchanged) the body is still
hidden with `visibility` and the node's **name, kind badge and LoC** are still
centred on the frame — but the label is now a child of the ROOT rather than of
the frame, carrying `scale(1 / s)`, which cancels the root's own scale exactly.
It reads at a fixed screen size at every zoom. At deep zoom-out it is therefore
LARGER than the frame it names, which is deliberate and is what a disk's own
labels do; it is not clipped, because it no longer sits under the frame's
`overflow: hidden`.

**Drag and close at low zoom: the label is the handle.** B2.1 kept the header
live under a `pointer-events: none` label because a box you cannot move or
shut is a trap. The header still exists and still works — but at camera 0.1 it
is drawn two pixels tall, so it cannot be the answer any more. The label's
BACKDROP stays inert (it covers rather more than the frame once counter-scaled,
and a handle that big would eat the canvas around a tiny bubble); its CONTENT —
the name/kind/LoC block — takes the pointer, is the drag handle, and carries a
close `×` of its own. Both are fixed-size, so the affordance a zoomed-out
bubble offers is exactly as big as the thing you can read. The corner grip is
not duplicated there: it shrinks with the frame, stays usable through the
0.5–1 band, and below the threshold resizing is simply a zoomed-in gesture.

**Interaction converts through `s`, in one direction each.**

- **Resize** — screen px in, frame px out: `w += dx / s`. Drag 40px at
  `s = 0.5` and the frame gains 80 frame px, which is 40px on screen, so the
  corner tracks the cursor 1:1 at every zoom; what changes with the zoom is how
  much box that buys. (B2.1 needed no conversion; `s = 1` is still that case.)
- **Header / label drag** — unchanged: screen px in, WORLD units out through
  the camera's own scale, because the anchor is a world point. That is 1:1 on
  screen in both regimes and needed no edit.
- **Wheel** — the wheel belongs to whatever is under the pointer, as before.
  Between 0.5 and 1 the shrunken scrollport still scrolls natively, and its
  `scrollTop` is still plain frame px (the browser converts; a transform does
  not change `scrollTop`'s units), so the anchor maths reads the same number it
  always did. Below the threshold the body is hidden, so there is nothing to
  scroll and the wheel is inert over the frame and its label — the same thing
  it has done over a bubble's header since B1.
- **Spawn** — a bubble spawned while zoomed out gets its DEFAULT size in FRAME
  px, so it appears at default × `s` and matches the bubbles already there
  rather than towering over them. The ghost is drawn at that same on-screen
  size, so the outline under the cursor is the box the release produces; the
  drop point crosses two factors (frame → screen through `s`, screen → world
  through the camera) instead of B2.1's one. Persistence is untouched: `w`/`h`
  are frame px, which is what they always were, and no migration exists or is
  needed.

**Anchors gain the factor, in one place each.** `bubbleScreenRect` now reports
`w × s`, `h × s` — it is the single rectangle every screen-space consumer is
built from, so the origin tether (`bubbleTetherAnchor`, still unchanged in
code) tracks the scaled frame for free. `bubbleCallAnchor` keeps its four
regimes (`line`, `clamped`, `header`, `centered`) with their exact meanings and
takes `frameScale` as an input: the header is subtracted as `headerHeight × s`
and the whole content offset — `padTop + (line − firstLine) × lineHeight ×
textScale + half a row − scrollTop`, all of it frame px — crosses `s` once, as
a unit. The result is that the anchor is **`s`-homothetic about the frame's
top-left**: same regime, same side, every offset exactly `s` times B2.1's, so
at `s = 1` it reproduces B2.1 term for term. Click-to-open still lands the
callee to the right of its caller and level with the call site, and its two
frame-px quantities (the gap, and the one-header lift that puts CONTENT rather
than border level with the line) now cross `s` before the camera — which makes
the whole placement pure WORLD arithmetic below camera 1, so a traced chain
keeps its spacing at any zoom.

**One source of truth for `s`.** `bubblePresentation(camera)` returns
`{ frameScale, textScale, label }` and `bubbleFrameScale` is the only place the
`min(camera, 1)` is written. The DOM transform, the screen rect the canvas
draws tethers from, the resize conversion, the spawn and the ghost all read it
from there, so the overlay and the canvas cannot disagree about how big a
bubble is.

**Two DOM reads had to learn the difference between a screen px and a frame
px**, and they are the only two: `getBoundingClientRect` answers in SCREEN px,
so the measured row height divides by `s` before it is cached (a row measured
while zoomed out would otherwise be reported short by exactly that factor, and
that number multiplies by the line number); and the multi-callee picker, which
positions in frame px inside the scaled root, divides its two screen
measurements back down before using them. `offsetTop` / `offsetHeight` are
layout px and a transform does not touch them, so they are read as they are.

**The blit is untouched, a third time.** Bubbles are still DOM in a
`pointer-events: none` overlay, never painted into the canvas; threads and
tethers are still chrome after `captureSnapshot`, in screen space, from the
live camera; snapshots are still viewport-sized; there are still **exactly
two** `requestCameraDraw` sites. The frame scale rides the transform that was
already being written, so this round adds no per-frame work at all.

- Probed with throwaway numeric probes over the real exported helpers, bundled
  with esbuild. **Presentation:** 12,000 random camera scales, log-uniform over
  0.005–8 with the seams and their neighbourhoods over-sampled — **0
  violations** across `frameScale === min(camera, 1)` exactly, the text-scale
  regime split (7,932 pinned below 1; 4,068 quantised above, of which 2,515 at
  the 1.5× clamp), the label threshold, totality, 34 continuity checks at
  camera 1 and at 0.5 (left and right limits of both the composed text height
  and the frame size, down to ε = 1e-12), and 20,000 monotonicity steps for
  each of the composed frame size and the composed text height. **Anchors:**
  18,000 random frame × `s` × metrics × scroll × range × line cases — **0
  violations** across totality, the side/border choice against the scaled
  frame, the anchor never leaving the scaled frame, the closed-form recheck of
  8,732 in-range rows under that case's own `s`, text scale and scroll offset,
  the clamp flag and the exact edge it lands on, 18,000 camera-translation
  cases (the whole picture panned, anchor moved rigidly with it), 18,000
  homothety checks (same regime at `s` and at 1, offsets exactly `s` times),
  and **18,000 / 18,000 cases reproducing B2.1's own formula EXACTLY at
  `s = 1`** — the guarantee that the zoom-in half of the model did not move.
  Every branch was exercised (3,096 `line`, 7,632 `clamped`, 2,792 `header`,
  4,480 `centered`). **Mutation controls**, each the real bundle with one
  operator changed: leaving the text scale unpinned below camera 1 (so the
  transform and the font both shrink it) is caught on 7,551 presentation cases,
  and letting the frame scale past 1 on 3,373; subtracting the header unscaled
  (B2.1's rule, now wrong) is caught on 15,061 anchor cases, dropping the frame
  scale from the content offset on 6,065, and clamping against the frame's
  unscaled height on 19,950 — and all three anchor mutants still reproduce
  B2.1 at `s = 1`, which is exactly what a zoom-out-only regression looks like.
  So the zeroes above are results, not tautologies.
- **Explicit non-goals this phase.** No lower bound on the frame scale: a
  bubble is allowed to become a speck, because that is what the disks do and a
  floor would put it back to being the thing that does not shrink. No
  level-of-detail switch beyond the existing label (no "fewer rows at small
  sizes" — the transform is uniform or it is not honest). No re-layout of the
  workspace on zoom, and no editing, still.


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
   Escape, transition-free DOM. **Round 2** (second manual review): radial
   fallback labels, flipped depth-by-kind, `+N` fold arcs, a centre circle that
   names the current root, no bottom band, collapsible left-hand panels, a
   provenance-free legend, `extended by`, and the settings `<label>` fix.
   **Round 3** (third manual review): per-branch radii (no whitespace between a
   wedge and its own children) with angle-first hit testing, label orientation
   picked by the wedge's longer extent, search + settings as icon buttons in the
   CODEGRAPH header, side-by-side node-panel edges, and browser Back/Forward as
   selection history. **Round 4** (fourth manual review): the inter-ring gap
   restored per branch, label-fit radial depth computed in the layout, a
   deferred label pass while the camera moves, change markers on the rim of
   edited files, a ⌘P landing pulse, an interactive (invisible-category) legend,
   per-node impact mode, keyboard navigation with a shortcut overlay, and the
   EDGES treatment moved to the legend with the node panel's lists stacked
   again.
7. **G — multi-disk workspace**: the canvas becomes a workspace of N disks over
   one shared camera. **G1** (built) is the geometry and the gesture — the pure
   `workspace.ts` layer, drag-away spawning with a ghost, disk move/close/focus,
   a global selection projected onto every disk, cross-disk relations drawn as
   single bowed curves while intra-disk ones keep their bundling, and a URL that
   still describes the primary disk only. **G2** (built) is the review round on
   top of it: a breadth-first, round-robin arc budget replacing the depth/size
   gating that silently dropped a small wedge's children, expanded wedges
   collapsed to a third-depth stub in the disk they came from (no children, no
   edges) with one always-visible tether to the disk that holds them, the close
   `×` moved to the disk's centre, and the keyboard overlay given the settings
   dialog's panel. **G3** (built) is the second review round: an expanded wedge
   stretched out to the rim as a full-height spoke, a cubic-Bézier tether that
   leaves and arrives radially, the close `×` moved onto the middle of that
   tether, hover and selection narrowed to a node's own relations (scoped to the
   active card's edge set inside a card view), and views made pure highlighters
   that never move the camera. **G4** (built) is the third review round: the
   legend's filter carried through to `+N` fold arcs (recounted at render time
   from the layout's folded-id metadata, and dropped when nothing they fold is
   left) and to relations (an edge with a hidden endpoint is never drawn),
   expanded wedges drawn hollow, a direction dot on the tether, a re-root that
   leaves the camera exactly where it is, Backspace as up-navigation, and a
   resizable right-hand column whose code panel can wrap. **Named saved views** — what makes a workspace
   survive a refresh — follow, along with the AI-composed flow views.

## House rules for every phase

- The customer/validation project's name must NEVER appear anywhere in this
  repo (code, comments, fixtures, docs). Use generic examples.
- No new runtime dependencies for the server. Frontend deps are devDependencies.
- Do not regress the MCP server, CLI, or index pipeline; `npm test` stays green.
- No UI test coverage required for v1 (explicit scope decision).
- CHANGELOG entry per phase under `[Unreleased]`, user-facing wording.
