/**
 * Whole-graph payload for `GET /api/graph`.
 *
 * Shape rules from the design contract (`docs/design/visualizer.md`):
 *
 *   - `contains` is the BACKBONE and is expressed through each node's `parent`
 *     field — it never appears in `edges`. The backbone continues past the
 *     files the graph knows about: a file's parent is its directory, and
 *     directories chain up to the project root, so the client can draw one
 *     connected tree without inventing structure.
 *   - `dirs` rolls file counts and lines of code up every ancestor directory,
 *     because directory circles are sized by aggregate LoC.
 *   - `layer` is the filename-suffix layer a file belongs to, derived from the
 *     project's own `plugins.layer-chain` vocabulary in `codegraph.json`.
 *     Projects without that config get no `layer` at all (the client then
 *     hides the layer color mode).
 */
import * as path from 'path';
import type { SqliteDatabase } from '../db/sqlite-adapter';
import { loadPluginsConfig } from '../project-config';

/** Prefix that distinguishes synthetic directory ids from real node ids. */
export const DIR_ID_PREFIX = 'dir:';

export interface GraphNode {
  id: string;
  kind: string;
  name: string;
  qualifiedName: string;
  file: string;
  startLine: number;
  endLine: number;
  /** Backbone parent: a node id, or `dir:<path>` for a file's directory. */
  parent: string | null;
  layer?: string;
}

export interface GraphEdge {
  source: string;
  target: string;
  kind: string;
  provenance?: string;
  /** Synthesizer that created a `provenance: 'heuristic'` edge. */
  synthesizedBy?: string;
  /** Where the synthesizer saw the wiring (file:line), for the tooltip. */
  registeredAt?: string;
  line?: number;
}

export interface GraphDir {
  /** `dir:<path>` — the id other nodes point at through `parent`. */
  id: string;
  /** Project-relative POSIX path; the project root is the empty string. */
  path: string;
  /** Parent directory id, or null for the project root. */
  parent: string | null;
  /** Files anywhere beneath this directory. */
  fileCount: number;
  /** Lines of code anywhere beneath this directory. */
  loc: number;
}

export interface GraphPayload {
  indexed: boolean;
  dataVersion: number;
  root: string;
  projectName: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  dirs: GraphDir[];
  /** Layer vocabulary from `plugins.layer-chain`; empty when not configured. */
  layers: string[];
}

interface NodeRow {
  id: string;
  kind: string;
  name: string;
  qualified_name: string;
  file_path: string;
  start_line: number;
  end_line: number;
}

interface EdgeRow {
  source: string;
  target: string;
  kind: string;
  provenance: string | null;
  line: number | null;
  metadata: string | null;
}

/** Normalize a path to POSIX separators (Windows writes `\` into some rows). */
function toPosix(filePath: string): string {
  return filePath.replace(/\\/g, '/');
}

/**
 * The layer tags a filename declares, using the project's `layer-chain`
 * vocabulary — `widget.bs.ps.ts` with `["bs","ps"]` is layer `bs.ps`. Mirrors
 * the plugin's own parsing: tags are the contiguous trailing run of declared
 * segments before the extension, and the stem always keeps a segment.
 */
export function layerOf(filePath: string, vocabulary: ReadonlySet<string>): string | undefined {
  if (vocabulary.size === 0) return undefined;
  const base = toPosix(filePath).split('/').pop() ?? '';
  const parts = base.split('.');
  if (parts.length < 2) return undefined;
  const segments = parts.slice(0, -1);
  if (segments.length === 0 || !segments[0]) return undefined;
  const tags: string[] = [];
  let end = segments.length;
  while (end > 1) {
    const tag = (segments[end - 1] ?? '').toLowerCase();
    if (!vocabulary.has(tag)) break;
    if (!tags.includes(tag)) tags.unshift(tag);
    end--;
  }
  return tags.length > 0 ? tags.join('.') : undefined;
}

/** The `plugins.layer-chain.layers` vocabulary, or an empty set. */
export function layerVocabulary(projectRoot: string): Set<string> {
  const vocabulary = new Set<string>();
  try {
    const options = loadPluginsConfig(projectRoot).options['layer-chain'];
    const layers = options?.['layers'];
    if (Array.isArray(layers)) {
      for (const entry of layers) {
        if (typeof entry === 'string' && entry.trim()) vocabulary.add(entry.trim().toLowerCase());
      }
    }
  } catch {
    // A malformed config must never break the graph view.
  }
  return vocabulary;
}

/** Directory id for a project-relative directory path (`''` = project root). */
export function dirId(dirPath: string): string {
  return `${DIR_ID_PREFIX}${dirPath}`;
}

/** Parent directory of a project-relative file/dir path (`''` at the root). */
function parentDirOf(relPath: string): string {
  const idx = relPath.lastIndexOf('/');
  return idx === -1 ? '' : relPath.slice(0, idx);
}

/**
 * Build the full graph payload. One pass over `nodes`, one over `edges`, one
 * over `files` — everything else is in-memory bookkeeping.
 */
export function buildGraphPayload(
  db: SqliteDatabase,
  projectRoot: string,
  projectName: string,
  dataVersion: number
): GraphPayload {
  const vocabulary = layerVocabulary(projectRoot);

  const nodeRows = db
    .prepare(
      'SELECT id, kind, name, qualified_name, file_path, start_line, end_line FROM nodes'
    )
    .all() as NodeRow[];

  const fileNodeIdByPath = new Map<string, string>();
  const locByFile = new Map<string, number>();
  for (const row of nodeRows) {
    if (row.kind !== 'file') continue;
    const file = toPosix(row.file_path);
    fileNodeIdByPath.set(file, row.id);
    locByFile.set(file, Math.max(0, Number(row.end_line) || 0));
  }

  // Backbone: contains edges give parent → child; everything else is a real edge.
  const parentById = new Map<string, string>();
  const edges: GraphEdge[] = [];
  const edgeRows = db
    .prepare('SELECT source, target, kind, provenance, line, metadata FROM edges')
    .iterate() as IterableIterator<EdgeRow>;
  for (const row of edgeRows) {
    if (row.kind === 'contains') {
      if (!parentById.has(row.target)) parentById.set(row.target, row.source);
      continue;
    }
    const edge: GraphEdge = { source: row.source, target: row.target, kind: row.kind };
    if (row.provenance) edge.provenance = row.provenance;
    if (row.line !== null && row.line !== undefined) edge.line = row.line;
    if (row.provenance === 'heuristic' && row.metadata) {
      try {
        const meta = JSON.parse(row.metadata) as Record<string, unknown>;
        if (typeof meta['synthesizedBy'] === 'string') edge.synthesizedBy = meta['synthesizedBy'];
        if (typeof meta['registeredAt'] === 'string') edge.registeredAt = meta['registeredAt'];
      } catch {
        /* metadata is advisory */
      }
    }
    edges.push(edge);
  }

  const nodes: GraphNode[] = nodeRows.map((row) => {
    const file = toPosix(row.file_path);
    const node: GraphNode = {
      id: row.id,
      kind: row.kind,
      name: row.name,
      qualifiedName: row.qualified_name,
      file,
      startLine: Number(row.start_line) || 0,
      endLine: Number(row.end_line) || 0,
      parent: null,
    };
    if (row.kind === 'file') {
      node.parent = dirId(parentDirOf(file));
    } else {
      // A symbol hangs off its `contains` parent; when extraction produced no
      // containment edge (rare, and always for top-level symbols in some
      // languages) fall back to the file so the backbone never breaks.
      node.parent = parentById.get(row.id) ?? fileNodeIdByPath.get(file) ?? dirId(parentDirOf(file));
    }
    const layer = layerOf(file, vocabulary);
    if (layer) node.layer = layer;
    return node;
  });

  // Directory roll-up over every tracked file (including files that produced
  // no nodes — they still occupy the tree).
  const filePaths = new Set<string>(fileNodeIdByPath.keys());
  try {
    const fileRows = db.prepare('SELECT path FROM files').all() as Array<{ path: string }>;
    for (const row of fileRows) filePaths.add(toPosix(row.path));
  } catch {
    /* files table is always present; be defensive anyway */
  }

  const dirs = new Map<string, GraphDir>();
  const ensureDir = (dirPath: string): GraphDir => {
    let dir = dirs.get(dirPath);
    if (!dir) {
      dir = {
        id: dirId(dirPath),
        path: dirPath,
        parent: dirPath === '' ? null : dirId(parentDirOf(dirPath)),
        fileCount: 0,
        loc: 0,
      };
      dirs.set(dirPath, dir);
      if (dirPath !== '') ensureDir(parentDirOf(dirPath));
    }
    return dir;
  };
  ensureDir('');

  for (const file of filePaths) {
    const loc = locByFile.get(file) ?? 0;
    let dirPath = parentDirOf(file);
    for (;;) {
      const dir = ensureDir(dirPath);
      dir.fileCount++;
      dir.loc += loc;
      if (dirPath === '') break;
      dirPath = parentDirOf(dirPath);
    }
  }

  return {
    indexed: true,
    dataVersion,
    root: projectRoot,
    projectName,
    nodes,
    edges,
    dirs: [...dirs.values()].sort((a, b) => a.path.localeCompare(b.path)),
    layers: [...vocabulary].sort(),
  };
}

/** The empty payload served for a root that has not been indexed yet. */
export function emptyGraphPayload(
  projectRoot: string,
  projectName: string,
  dataVersion: number
): GraphPayload {
  return {
    indexed: false,
    dataVersion,
    root: projectRoot,
    projectName,
    nodes: [],
    edges: [],
    dirs: [],
    layers: [],
  };
}

/** Project-relative POSIX path for an absolute path inside the root. */
export function relativePosix(projectRoot: string, absolutePath: string): string {
  return toPosix(path.relative(projectRoot, absolutePath));
}
