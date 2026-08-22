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
| Graph rendering | **sigma.js (WebGL)**; budget ≤2k simultaneously visible nodes |
| Build | `npm run build` also builds `web/` → `dist/ui-web/`, served statically; git-URL installs build it via the existing `prepare` hook |
| Question box | Floor: raw text → explore (deterministic, always works). Optional: LLM refine (Anthropic API, key entered in UI settings) |
| Persistence | Cards + UI state: `.codegraph/ui/` in the project (gitignored). User prefs (editor command, API key): `~/.codegraph/ui.json` |
| Editor jump | Command template from `~/.codegraph/ui.json` (e.g. `cursor -g {file}:{line}`), run server-side; client-side `vscode://` URL-scheme fallback when unset |
| Design | Minimal + light futuristic; graph is the background; code panels / views float on top |
| Out of scope v1 | Commit-history / time animation (no gource time axis), auth, UI test coverage, mobile |

## Visual language (locked)

- **Backbone = `contains`, drawn as structure, never as an edge list.** Each
  directory/file/symbol is a circle. A collapsed parent shows its children as
  small satellites hugging it (atom/nucleus). Shift+click expands: the child
  moves away along a **straight** line; shift+click again collapses.
- **Non-contains edges are slightly curved lines**; backbone lines are straight.
- **Provenance renders**: parsed edges solid, `provenance:'heuristic'` edges
  **dashed**, tooltip shows `metadata.synthesizedBy` + the wiring site.
- **Edge-kind toggles**: calls / imports / references / extends / instantiates
  (contains is never toggleable — it IS the backbone).
- **Node encoding**: color = switchable mode (① node kind ② layer — derived
  from filename layer suffixes, read from the project's `plugins.layer-chain`
  config when present, else hidden); size = LoC for files/dirs (aggregate),
  span length for symbols; border style reserved.
- **Layout**: radial from the project root, growing **left-to-right in a ~120°
  wedge**. Expanded children are force-laid on the RIGHT of the parent, never
  the left, pre-ordered vertically by name (A top → Z bottom). Dragging pins a
  node; a quick wobble drag unpins it.
- **Hover** shows a node's edges; **click** opens the info panel.
- **Auto-expansion for a card/view**: expand every ancestor of the result
  nodes; leave siblings collapsed.
- **URL = state**: expanded set + active card encoded in the URL.

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
| `GET/PUT /api/settings` | `~/.codegraph/ui.json`: `{ editorCommand?, anthropicApiKey?, model? }`. The key is never echoed back in full (masked) |

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

- **Sigma's y axis points UP on screen.** The layout therefore gives the FIRST
  child (A) the most POSITIVE angle so it lands at the top. Anything that
  computes positions must use the same convention or the graph renders Z→A.
- **Initial view** is the root EXPANDED with every top-level directory
  collapsed, so the first paint is already a wedge of atoms rather than a
  single blob.
- **Mount budget split.** Of the ≤2k budget, at most 1,200 are force-laid
  "primaries"; the rest are satellites, allocated fair-share across collapsed
  parents with a per-parent cap. A parent whose children were elided shows
  `+N` in its label, and the toolbar reports `capped`.
- **Shift+click on a satellite** expands it *and* every ancestor, so a drill-in
  from a collapsed atom is one click. Collapsing removes the whole subtree from
  the expansion set.
- **The hover rule** for edges: a relation whose far endpoint is inside a
  collapsed subtree is drawn, only while hovering, against the nearest MOUNTED
  ancestor of that endpoint. Without it a collapsed directory reads as
  unconnected. These lifted edges never persist past the hover.
- **Edge-kind chips** are the contract's five in the contract's order, followed
  by any other non-`contains` kind actually present in the payload (e.g.
  `implements`, `overrides`) — an edge that is drawn is always toggleable.
- **Camera framing.** A custom bounding box is pinned at the first fit so
  sigma never re-normalizes the coordinate frame when the graph grows; without
  it every expansion yanks the viewport. After an expansion the camera zooms
  OUT only, and only when the new family doesn't fit.
- **Phase C mount point**: `<GraphCanvas renderDetail={…} onSelect={…} />`.
  `renderDetail(node)` replaces the stub body of the floating selection card;
  `onSelect` publishes the canvas selection to the shell.

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
   color modes, edge-kind toggles.
3. **C — panels**: node info panel, source full/diff, editor jump, Cmd+P
   fuzzy search, settings UI.
4. **D — questions + changes**: cards, explore/ask endpoints (structured
   explore refactor), Changes view with badges + impact radius,
   auto-expansion, feedback export, URL state.

## House rules for every phase

- The customer/validation project's name must NEVER appear anywhere in this
  repo (code, comments, fixtures, docs). Use generic examples.
- No new runtime dependencies for the server. Frontend deps are devDependencies.
- Do not regress the MCP server, CLI, or index pipeline; `npm test` stays green.
- No UI test coverage required for v1 (explicit scope decision).
- CHANGELOG entry per phase under `[Unreleased]`, user-facing wording.
