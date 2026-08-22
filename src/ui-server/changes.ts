/**
 * `GET /api/changes` — the Changes standing view.
 *
 * What changed since `HEAD`, expressed on the GRAPH rather than on files: git's
 * hunks are intersected with each node's line span, so the answer is "these
 * symbols changed", and `getImpactRadius` then says which untouched symbols
 * depend on them. That pairing is the whole point of the view — reviewing
 * agent-written code is mostly about what the edit *reaches*, not what it
 * touched.
 *
 * Cost control (a browser polls this):
 *
 *  - **two** git invocations for the whole tree (`status --porcelain` and one
 *    `diff HEAD`), not two per file; only untracked files fall back to the
 *    per-file path, since they have no `HEAD` side to diff.
 *  - `MAX_FILES` changed files, `MAX_IMPACT_SEEDS` symbols seeded into the
 *    impact walk, and `MAX_IMPACT_NODES` impacted ids. Every cap is reported in
 *    the payload (`truncated`) rather than silently applied.
 *
 * A **deleted** file usually has no nodes left in the index (the watcher drops
 * them), so it can't appear in `changedNodes` at all. It is represented at file
 * level in `changedFiles` with `nodeId: null` — the client renders the file
 * row, and there is simply nothing to highlight on the canvas. When the index
 * has not caught up yet, its nodes ARE still present and are reported with
 * `status: "deleted"`.
 */
import type CodeGraphType from '../index';
import type { Node } from '../types';
import { isGitWorkTree, parseUnifiedDiff, readSourceDiff, runGit, type DiffHunk } from './diff';

/** Changed files reported before the payload is truncated. */
export const MAX_FILES = 200;

/** Untracked files we will read from disk to synthesize "all new" hunks. */
export const MAX_UNTRACKED_READS = 40;

/** Hunks carried per file, and in total — an untracked 5 MB file is one hunk. */
export const MAX_HUNKS_PER_FILE = 25;
export const MAX_HUNK_LINES = 6000;

/** Changed symbols seeded into the impact walk. */
export const MAX_IMPACT_SEEDS = 200;

/** Impacted ids returned (the union is capped, not the per-seed walk). */
export const MAX_IMPACT_NODES = 2000;

/** How far `getImpactRadius` walks out from each changed symbol. */
export const IMPACT_DEPTH = 2;

/** How a file (or a node inside it) relates to `HEAD`. */
export type ChangeStatus = 'added' | 'modified' | 'deleted' | 'untracked';

/** A changed symbol — an id that resolves against `GET /api/graph`. */
export interface ChangedNode {
  id: string;
  status: 'added' | 'modified' | 'deleted';
  file: string;
  name: string;
  kind: string;
  startLine: number;
  endLine: number;
}

/** File-level truth, including files whose nodes are gone from the index. */
export interface ChangedFile {
  path: string;
  status: ChangeStatus;
  /** The file node's id, or null when the index no longer holds the file. */
  nodeId: string | null;
  /** How many of this file's symbols intersect a hunk. */
  nodeCount: number;
  hunkCount: number;
  binary: boolean;
}

/** A hunk, tagged with the file it belongs to (hunks are flat, not nested). */
export type FileHunk = DiffHunk & { file: string };

export interface ChangesPayload {
  changedNodes: ChangedNode[];
  changedFiles: ChangedFile[];
  impactedNodeIds: string[];
  hunks: FileHunk[];
  git: boolean;
  /** True when a cap above was hit; the payload is a prefix, not the whole. */
  truncated: boolean;
}

export const EMPTY_CHANGES: ChangesPayload = {
  changedNodes: [],
  changedFiles: [],
  impactedNodeIds: [],
  hunks: [],
  git: false,
  truncated: false,
};

export type ChangesOutcome =
  | { ok: true; payload: ChangesPayload }
  | { ok: false; reason: 'not_git'; message: string };

/** One entry of `git status --porcelain`. */
interface StatusEntry {
  path: string;
  status: ChangeStatus;
}

/**
 * Compute the changes payload for a project root.
 *
 * `graph` may be null (un-indexed project): the git half still answers, so the
 * user sees their edits even before the first index.
 */
export function collectChanges(
  projectRoot: string,
  graph: CodeGraphType | null
): ChangesOutcome {
  if (!isGitWorkTree(projectRoot)) {
    return {
      ok: false,
      reason: 'not_git',
      message: 'The project root is not inside a git work tree, so there is nothing to compare.',
    };
  }

  // A codegraph project can be a SUBDIRECTORY of the git repo. git prints
  // porcelain/diff paths relative to the repo ROOT, so everything git says has
  // to be re-based onto the project root before it can meet a node's filePath.
  const prefix = (runGit(projectRoot, ['rev-parse', '--show-prefix']) ?? '').trim();

  const entries = readStatus(projectRoot, prefix);
  let truncated = entries.length > MAX_FILES;
  const files = entries.slice(0, MAX_FILES);

  const patches = readTreeDiff(projectRoot, prefix);
  let hunkLines = 0;
  const hunks: FileHunk[] = [];
  const changedFiles: ChangedFile[] = [];
  const changedNodes: ChangedNode[] = [];
  const changedIds = new Set<string>();
  let untrackedReads = 0;

  for (const entry of files) {
    const patch = patches.get(entry.path);
    let fileHunks: DiffHunk[] = patch?.hunks ?? [];
    let binary = patch?.binary ?? false;

    if (!patch && entry.status === 'untracked') {
      // No HEAD side: the whole file is new. Reading it is the only way to say
      // so, which is why it is capped separately from everything else.
      if (untrackedReads < MAX_UNTRACKED_READS) {
        untrackedReads++;
        const result = readSourceDiff(projectRoot, entry.path);
        if (result.ok) {
          fileHunks = result.diff.hunks;
          binary = result.diff.binary;
        }
      } else {
        truncated = true;
      }
    }

    // Bound the payload: a browser polls this route, and one untracked file
    // can be a whole megabyte of "add" lines. Whole hunks are dropped, never
    // sliced — a half hunk is a lie about its own line numbering.
    for (const hunk of fileHunks.slice(0, MAX_HUNKS_PER_FILE)) {
      if (hunkLines + hunk.lines.length > MAX_HUNK_LINES) {
        truncated = true;
        break;
      }
      hunkLines += hunk.lines.length;
      hunks.push({ ...hunk, file: entry.path });
    }
    if (fileHunks.length > MAX_HUNKS_PER_FILE) truncated = true;

    const nodes = graph ? safeNodesInFile(graph, entry.path) : [];
    const fileNode = nodes.find((node) => node.kind === 'file') ?? null;
    const nodeStatus: ChangedNode['status'] =
      entry.status === 'deleted' ? 'deleted' : entry.status === 'modified' ? 'modified' : 'added';

    let matched = 0;
    for (const node of nodes) {
      if (node.kind === 'import' || node.kind === 'export') continue;
      // A whole-file status (added / deleted / untracked) applies to every
      // symbol in it; a modified file only marks the symbols a hunk lands in.
      const touched =
        entry.status !== 'modified' || fileHunks.some((hunk) => intersects(hunk, node));
      if (!touched) continue;
      if (changedIds.has(node.id)) continue;
      changedIds.add(node.id);
      matched++;
      changedNodes.push({
        id: node.id,
        status: nodeStatus,
        file: node.filePath,
        name: node.name,
        kind: node.kind,
        startLine: node.startLine,
        endLine: node.endLine,
      });
    }

    changedFiles.push({
      path: entry.path,
      status: entry.status,
      nodeId: fileNode?.id ?? null,
      nodeCount: matched,
      hunkCount: fileHunks.length,
      binary,
    });
  }

  const impactedNodeIds = graph ? impactOf(graph, changedNodes, changedIds) : [];
  if (impactedNodeIds.length >= MAX_IMPACT_NODES) truncated = true;
  if (changedNodes.length > MAX_IMPACT_SEEDS) truncated = true;

  return {
    ok: true,
    payload: { changedNodes, changedFiles, impactedNodeIds, hunks, git: true, truncated },
  };
}

/**
 * True when a hunk's actually-CHANGED lines fall inside a node's span.
 *
 * Deliberately not the hunk's whole range: a hunk carries three context lines
 * on each side, and counting those would mark the symbol above and below every
 * edit as changed — which on the canvas is a halo on code nobody touched.
 * A deletion has no new-side line of its own, so it is attributed to the seam
 * it left behind (the lines either side of it).
 */
function intersects(hunk: DiffHunk, node: Node): boolean {
  const nodeEnd = Math.max(node.endLine, node.startLine);
  let line = hunk.newStart;
  for (const entry of hunk.lines) {
    if (entry.type === 'add') {
      if (line >= node.startLine && line <= nodeEnd) return true;
      line++;
    } else if (entry.type === 'del') {
      if (line - 1 <= nodeEnd && line >= node.startLine) return true;
    } else {
      line++;
    }
  }
  return false;
}

/** Nodes of a file; a path the index doesn't know is simply empty. */
function safeNodesInFile(graph: CodeGraphType, filePath: string): Node[] {
  try {
    return graph.getNodesInFile(filePath);
  } catch {
    return [];
  }
}

/**
 * Everything within {@link IMPACT_DEPTH} hops of a changed symbol, minus the
 * changed symbols themselves. File nodes are not seeded — a file's impact
 * radius is the union of its members' and would dominate the cap.
 */
function impactOf(
  graph: CodeGraphType,
  changed: ChangedNode[],
  changedIds: Set<string>
): string[] {
  const impacted = new Set<string>();
  const seeds = changed.filter((node) => node.kind !== 'file').slice(0, MAX_IMPACT_SEEDS);
  for (const seed of seeds) {
    if (impacted.size >= MAX_IMPACT_NODES) break;
    try {
      const radius = graph.getImpactRadius(seed.id, IMPACT_DEPTH);
      for (const id of radius.nodes.keys()) {
        if (changedIds.has(id) || impacted.has(id)) continue;
        impacted.add(id);
        if (impacted.size >= MAX_IMPACT_NODES) break;
      }
    } catch {
      /* a node the traverser can't walk simply contributes nothing */
    }
  }
  return [...impacted];
}

/**
 * `git status --porcelain -z`, NUL-separated so paths with spaces, quotes or
 * newlines survive. A rename yields two records: the new path (modified) and
 * the old one (deleted), which is what a graph view wants to show.
 */
function readStatus(projectRoot: string, prefix: string): StatusEntry[] {
  const raw = runGit(projectRoot, [
    'status',
    '--porcelain',
    '-z',
    '--untracked-files=all',
    // Limit to this project even when it is a subdirectory of the repo.
    '--',
    '.',
  ]);
  if (raw === null) return [];

  const tokens = raw.split('\0');
  const entries: StatusEntry[] = [];
  const seen = new Set<string>();
  const push = (raw: string, status: ChangeStatus): void => {
    const path = rebase(raw, prefix);
    if (!path || seen.has(path)) return;
    seen.add(path);
    entries.push({ path, status });
  };

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (!token || token.length < 4) continue;
    const index = token[0]!;
    const worktree = token[1]!;
    const path = token.slice(3);

    if (index === 'R' || index === 'C') {
      // `XY new\0old` — the source path is the next NUL-separated token.
      const from = tokens[++i];
      if (from) push(from, index === 'R' ? 'deleted' : 'modified');
      push(path, 'modified');
      continue;
    }
    if (index === '?' || worktree === '?') {
      push(path, 'untracked');
      continue;
    }
    if (index === 'D' || worktree === 'D') {
      push(path, 'deleted');
      continue;
    }
    if (index === 'A') {
      push(path, 'added');
      continue;
    }
    push(path, 'modified');
  }

  return entries;
}

/**
 * One `git diff HEAD` for the whole tree, split back into per-file patches.
 *
 * Doing this per file would cost several git spawns per changed file on a route
 * the browser refreshes; the split is the price of doing it once.
 */
function readTreeDiff(
  projectRoot: string,
  prefix: string
): Map<string, { hunks: DiffHunk[]; binary: boolean }> {
  const out = new Map<string, { hunks: DiffHunk[]; binary: boolean }>();
  const patch = runGit(projectRoot, [
    'diff',
    'HEAD',
    '--no-color',
    '--no-ext-diff',
    '--no-textconv',
    '-U3',
    '--',
    '.',
  ]);
  if (!patch) return out;

  // `diff --git` starts each file section; everything up to the first one is
  // preamble (there is none for `git diff`, but be safe).
  const sections = patch.split(/^diff --git /m).slice(1);
  for (const section of sections) {
    const body = `diff --git ${section}`;
    const raw = pathOfSection(body);
    if (!raw) continue;
    const path = rebase(raw, prefix);
    if (!path) continue;
    const binary = /^(?:Binary files|GIT binary patch)/m.test(body);
    out.set(path, { hunks: binary ? [] : parseUnifiedDiff(body), binary });
  }
  return out;
}

/**
 * The project-relative path a `diff --git` section is about — taken from the
 * `+++ b/…` line, falling back to `--- a/…` for a deleted file.
 */
function pathOfSection(section: string): string | null {
  const plus = /^\+\+\+ (.+)$/m.exec(section);
  const minus = /^--- (.+)$/m.exec(section);
  const pick = (value: string | undefined): string | null => {
    if (!value || value === '/dev/null') return null;
    const trimmed = value.replace(/\t.*$/, '');
    const unquoted = unquotePath(trimmed);
    return unquoted.startsWith('a/') || unquoted.startsWith('b/') ? unquoted.slice(2) : unquoted;
  };
  return pick(plus?.[1]) ?? pick(minus?.[1]);
}

/**
 * Re-base a repo-root-relative path onto the project root, or return '' when
 * it falls outside the project (a sibling directory of the same repository).
 */
function rebase(path: string, prefix: string): string {
  if (!prefix) return path;
  return path.startsWith(prefix) ? path.slice(prefix.length) : '';
}

/** git quotes paths with unusual bytes as C strings; undo the common cases. */
function unquotePath(value: string): string {
  if (!value.startsWith('"') || !value.endsWith('"')) return value;
  const inner = value.slice(1, -1);
  return inner.replace(/\\(x[0-9a-fA-F]{2}|[0-7]{3}|.)/g, (match, escape: string) => {
    if (escape.startsWith('x')) return String.fromCharCode(Number.parseInt(escape.slice(1), 16));
    if (/^[0-7]{3}$/.test(escape)) return String.fromCharCode(Number.parseInt(escape, 8));
    switch (escape) {
      case 'n': return '\n';
      case 't': return '\t';
      case 'r': return '\r';
      case '\\': return '\\';
      case '"': return '"';
      default: return match;
    }
  });
}
