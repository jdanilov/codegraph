/**
 * In-memory model of `GET /api/graph`, indexed for the canvas.
 *
 * The payload is 15k+ nodes on a real project and the renderer budget is 2k, so
 * the model deliberately lives OUTSIDE sigma: it owns the whole graph, and the
 * canvas mounts only the slice the user has expanded (see `view.ts`).
 *
 * Two structures matter here:
 *
 *   - the **backbone**, rebuilt from `dirs[]` + each node's `parent` (the API
 *     never ships `contains` as an edge). Directories, files and symbols end up
 *     in one `Map` so the canvas treats them uniformly.
 *   - an **adjacency index** over the non-contains edges, so "the edges of node
 *     X" is an array lookup rather than a scan of 30k edges on every hover.
 */
import type { GraphPayload } from '@/lib/api';

/** Id of the project root directory (contract: `dirs[]` root is `path: ""`). */
export const ROOT_ID = 'dir:';

/** Synthetic kind for `dirs[]` entries — the API has no node row for them. */
export const DIRECTORY_KIND = 'directory';

/**
 * Edge kinds the contract exposes as toggle chips, in the order they are
 * displayed. Any other kind found in the payload is appended after these.
 */
export const PRIMARY_EDGE_KINDS = [
  'calls',
  'imports',
  'references',
  'extends',
  'instantiates',
] as const;

export interface ModelNode {
  id: string;
  /** `directory` for `dirs[]` entries, otherwise the raw NodeKind. */
  kind: string;
  /** Display name: directory basename, filename, or symbol name. */
  name: string;
  qualifiedName: string;
  /** Project-relative file path; the directory path for directories. */
  file: string;
  startLine: number;
  endLine: number;
  parent: string | null;
  /** Child ids, pre-ordered by name (A first → Z last). */
  children: string[];
  layer?: string;
  /** LoC for directories/files, span length for symbols. Drives node size. */
  weight: number;
  /** Distance from the project root along the backbone. */
  depth: number;
}

export interface ModelEdge {
  /** Stable key: same edge across refetches keeps its identity. */
  key: string;
  source: string;
  target: string;
  kind: string;
  /** `provenance: 'heuristic'` — rendered dashed, with a wiring tooltip. */
  heuristic: boolean;
  synthesizedBy?: string;
  registeredAt?: string;
  line?: number;
}

/** Name-first ordering; A ends up at the top of an expanded fan. */
function byName(a: ModelNode, b: ModelNode): number {
  const compared = a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  return compared !== 0 ? compared : a.id.localeCompare(b.id);
}

export class GraphModel {
  readonly nodes = new Map<string, ModelNode>();
  readonly edges: ModelEdge[] = [];
  /** node id → indices into `edges`. Both endpoints of an edge are indexed. */
  readonly edgesByNode = new Map<string, number[]>();
  /** `ModelEdge.key` → edge, so a hover tooltip is a lookup, not a scan. */
  readonly edgeByKey = new Map<string, ModelEdge>();
  readonly layers: string[];
  /** Non-contains edge kinds actually present, contract kinds first. */
  readonly edgeKinds: string[] = [];
  readonly dataVersion: number;
  readonly projectName: string;
  readonly root: string;

  constructor(payload: GraphPayload) {
    this.dataVersion = payload.dataVersion;
    this.projectName = payload.projectName;
    this.root = payload.root;
    this.layers = [...payload.layers];

    for (const dir of payload.dirs) {
      const name = dir.path === '' ? payload.projectName || 'project' : basename(dir.path);
      this.nodes.set(dir.id, {
        id: dir.id,
        kind: DIRECTORY_KIND,
        name,
        qualifiedName: dir.path,
        file: dir.path,
        startLine: 0,
        endLine: 0,
        parent: dir.parent,
        children: [],
        weight: dir.loc,
        depth: 0,
      });
    }
    // Defensive: a payload with no dirs (empty project) still needs a root.
    if (!this.nodes.has(ROOT_ID)) {
      this.nodes.set(ROOT_ID, {
        id: ROOT_ID,
        kind: DIRECTORY_KIND,
        name: payload.projectName || 'project',
        qualifiedName: '',
        file: '',
        startLine: 0,
        endLine: 0,
        parent: null,
        children: [],
        weight: 0,
        depth: 0,
      });
    }

    for (const node of payload.nodes) {
      const span = Math.max(1, node.endLine - node.startLine + 1);
      const entry: ModelNode = {
        id: node.id,
        kind: node.kind,
        name: node.name || basename(node.file) || node.id,
        qualifiedName: node.qualifiedName,
        file: node.file,
        startLine: node.startLine,
        endLine: node.endLine,
        parent: node.parent,
        children: [],
        weight: node.kind === 'file' ? Math.max(1, node.endLine) : span,
        depth: 0,
      };
      if (node.layer) entry.layer = node.layer;
      this.nodes.set(node.id, entry);
    }

    // Wire the backbone. A dangling parent reference re-roots the node rather
    // than dropping it — an orphan is still worth showing.
    for (const node of this.nodes.values()) {
      if (node.id === ROOT_ID) {
        node.parent = null;
        continue;
      }
      if (!node.parent || !this.nodes.has(node.parent) || node.parent === node.id) {
        node.parent = ROOT_ID;
      }
    }
    this.breakCycles();
    for (const node of this.nodes.values()) {
      if (node.parent) this.nodes.get(node.parent)?.children.push(node.id);
    }
    for (const node of this.nodes.values()) {
      node.children.sort((a, b) => byName(this.nodes.get(a)!, this.nodes.get(b)!));
    }
    this.assignDepths();

    const kindsSeen = new Set<string>();
    for (const edge of payload.edges) {
      if (edge.kind === 'contains') continue;
      if (!this.nodes.has(edge.source) || !this.nodes.has(edge.target)) continue;
      const index = this.edges.length;
      const entry: ModelEdge = {
        key: `${edge.kind}|${edge.source}|${edge.target}|${edge.line ?? ''}`,
        source: edge.source,
        target: edge.target,
        kind: edge.kind,
        heuristic: edge.provenance === 'heuristic',
      };
      if (edge.synthesizedBy) entry.synthesizedBy = edge.synthesizedBy;
      if (edge.registeredAt) entry.registeredAt = edge.registeredAt;
      if (edge.line !== undefined) entry.line = edge.line;
      this.edges.push(entry);
      this.edgeByKey.set(entry.key, entry);
      kindsSeen.add(edge.kind);
      pushIndex(this.edgesByNode, edge.source, index);
      if (edge.target !== edge.source) pushIndex(this.edgesByNode, edge.target, index);
    }
    for (const kind of PRIMARY_EDGE_KINDS) {
      if (kindsSeen.delete(kind)) this.edgeKinds.push(kind);
    }
    this.edgeKinds.push(...[...kindsSeen].sort());
  }

  get(id: string): ModelNode | undefined {
    return this.nodes.get(id);
  }

  childrenOf(id: string): string[] {
    return this.nodes.get(id)?.children ?? [];
  }

  /** The edge behind a rendered edge key. */
  edge(key: string): ModelEdge | undefined {
    return this.edgeByKey.get(key);
  }

  /** Edges touching `id`, as model edges (adjacency lookup, never a scan). */
  edgesOf(id: string): ModelEdge[] {
    const indices = this.edgesByNode.get(id);
    if (!indices) return [];
    return indices.map((index) => this.edges[index]!);
  }

  /** Every id beneath `id` on the backbone, `id` excluded. */
  descendants(id: string): string[] {
    const out: string[] = [];
    const stack = [...this.childrenOf(id)];
    while (stack.length > 0) {
      const current = stack.pop()!;
      out.push(current);
      stack.push(...this.childrenOf(current));
    }
    return out;
  }

  /** Ancestor chain from the node's parent up to the root, nearest first. */
  ancestors(id: string): string[] {
    const out: string[] = [];
    let current = this.nodes.get(id)?.parent ?? null;
    while (current && out.length < 64) {
      out.push(current);
      current = this.nodes.get(current)?.parent ?? null;
    }
    return out;
  }

  /**
   * A cycle in `parent` would hang every tree walk. Re-root any node whose
   * ancestry doesn't terminate at the root.
   */
  private breakCycles(): void {
    const state = new Map<string, 0 | 1 | 2>();
    for (const node of this.nodes.values()) {
      if (state.get(node.id) === 2) continue;
      const path: string[] = [];
      let current: ModelNode | undefined = node;
      while (current && state.get(current.id) !== 2) {
        if (state.get(current.id) === 1) {
          current.parent = ROOT_ID;
          break;
        }
        state.set(current.id, 1);
        path.push(current.id);
        current = current.parent ? this.nodes.get(current.parent) : undefined;
      }
      for (const id of path) state.set(id, 2);
    }
  }

  private assignDepths(): void {
    const queue: string[] = [ROOT_ID];
    const seen = new Set<string>(queue);
    this.nodes.get(ROOT_ID)!.depth = 0;
    while (queue.length > 0) {
      const id = queue.shift()!;
      const depth = this.nodes.get(id)!.depth;
      for (const child of this.childrenOf(id)) {
        if (seen.has(child)) continue;
        seen.add(child);
        this.nodes.get(child)!.depth = depth + 1;
        queue.push(child);
      }
    }
  }
}

function pushIndex(map: Map<string, number[]>, key: string, value: number): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

function basename(filePath: string): string {
  const index = filePath.lastIndexOf('/');
  return index === -1 ? filePath : filePath.slice(index + 1);
}
