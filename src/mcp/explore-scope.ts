/**
 * Optional subtree scope for `codegraph_explore`.
 *
 * `codegraph_explore` ranks over the whole index. On a monorepo — or any repo
 * where the same symbol names recur per package — that means the agent's precise
 * symbol bag still competes with same-named symbols in the wrong subtree. The
 * `path` argument narrows the search to one directory (or glob) so the answer
 * comes from where the agent already knows to look.
 *
 * Design rules this file exists to keep:
 *
 * - **Omitted `path` changes nothing.** Every caller keeps `scope === null` and
 *   takes the exact code path it took before, so an unscoped call is
 *   byte-identical to the pre-scope build.
 * - **A bad scope is guidance, not an error.** An `isError: true` response
 *   teaches an agent to stop calling codegraph for the rest of the session
 *   (see `NotIndexedError` in `tools.ts`), so a path that is malformed, escapes
 *   the project or matches nothing indexed comes back as a SUCCESS-shaped
 *   message telling the agent how to spell it. {@link scopeGuidance} builds
 *   that text.
 * - **Pure string matching against the index.** Scoping never touches the
 *   filesystem: it matches project-relative paths exactly as the index stores
 *   them, so it is deterministic and cannot be used to probe outside the root.
 */
import * as path from 'path';
import picomatch from 'picomatch';

/** Longest `path` argument accepted — matches the tool surface's path cap. */
const MAX_SCOPE_LENGTH = 1000;

/** Characters that make a `path` argument a glob rather than a directory prefix. */
const GLOB_CHARS = /[*?[\]{}!]/;

/** A resolved `path` argument: a predicate over project-relative file paths. */
export interface ExploreScope {
  /** The argument as the caller spelled it — used in messages only. */
  raw: string;
  /** Normalized project-relative prefix or glob (forward slashes, no `./`). */
  pattern: string;
  /** True when a project-relative file path lies under this scope. */
  matches(filePath: string): boolean;
}

/** Either a usable scope, or the guidance text to answer the call with. */
export type ExploreScopeParse =
  | { ok: true; scope: ExploreScope }
  | { ok: false; guidance: string };

/** Normalize a caller-supplied path to the spelling the index uses. */
function toProjectRelative(raw: string, projectRoot: string): string | null {
  let value = raw.trim().replace(/\\/g, '/');
  if (value.length === 0 || value.includes('\0')) return null;

  // An absolute path is accepted only when it is inside the project — the agent
  // often has the absolute path in hand and re-spelling it is friction.
  if (path.isAbsolute(value) || /^[A-Za-z]:\//.test(value)) {
    const rel = path.relative(projectRoot, value.replace(/\//g, path.sep));
    if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
    value = rel.split(path.sep).join('/');
  }

  // Collapse `./` and `a/../b`. `path.posix.normalize` keeps a leading `../`,
  // which is exactly the escape we then refuse.
  value = path.posix.normalize(value).replace(/^\.\//, '');
  if (value === '.' || value === './' || value === '') return '';
  if (value.startsWith('../') || value === '..' || value.startsWith('/')) {
    return value.startsWith('/') ? value.replace(/^\/+/, '') : null;
  }
  return value.replace(/\/+$/, '');
}

/**
 * Resolve the `path` argument of an explore call.
 *
 * `indexedFiles` is the project-relative path of every indexed file; it is what
 * decides whether a syntactically fine scope actually selects anything, which is
 * the difference between "you typoed the directory" and "that directory holds no
 * indexed code" — two different things to tell the agent.
 */
export function parseExploreScope(
  value: unknown,
  projectRoot: string,
  indexedFiles: readonly string[]
): ExploreScopeParse {
  if (typeof value !== 'string') {
    return { ok: false, guidance: scopeGuidance(String(value), 'is not a string', indexedFiles) };
  }
  if (value.length > MAX_SCOPE_LENGTH) {
    return { ok: false, guidance: scopeGuidance(`${value.slice(0, 60)}…`, 'is too long', indexedFiles) };
  }

  const relative = toProjectRelative(value, projectRoot);
  if (relative === null) {
    return { ok: false, guidance: scopeGuidance(value, 'is outside the project', indexedFiles) };
  }
  // An empty scope ("", ".", "/") means the project root, i.e. no narrowing at
  // all. Answering it as the whole project is friendlier than refusing it.
  if (relative === '') {
    return { ok: true, scope: { raw: value, pattern: '', matches: () => true } };
  }

  const isGlob = GLOB_CHARS.test(relative);
  let matches: (filePath: string) => boolean;
  if (isGlob) {
    let isMatch: (input: string) => boolean;
    try {
      // `dot: true` so a scope can reach into `.github/**` and friends; a bare
      // `src/**` should also select `src/a.ts`, which picomatch already does.
      isMatch = picomatch(relative, { dot: true });
    } catch {
      return { ok: false, guidance: scopeGuidance(value, 'is not a valid glob', indexedFiles) };
    }
    matches = (filePath: string) => isMatch(filePath);
  } else {
    const prefix = `${relative}/`;
    // A directory prefix, or the single file itself when `path` names one.
    matches = (filePath: string) => filePath === relative || filePath.startsWith(prefix);
  }

  const hits = indexedFiles.reduce((n, f) => (matches(f) ? n + 1 : n), 0);
  if (hits === 0) {
    return { ok: false, guidance: scopeGuidance(value, 'matches no indexed file', indexedFiles) };
  }

  return { ok: true, scope: { raw: value, pattern: relative, matches } };
}

/** Up to `limit` top-level directories of the index, for the guidance message. */
function topLevelDirs(indexedFiles: readonly string[], limit = 12): string[] {
  const dirs = new Set<string>();
  for (const f of indexedFiles) {
    const slash = f.indexOf('/');
    if (slash > 0) dirs.add(f.slice(0, slash));
    if (dirs.size > 200) break;
  }
  return [...dirs].sort().slice(0, limit);
}

/**
 * The SUCCESS-shaped answer for a `path` that cannot be used.
 *
 * It names the problem, shows the spellings that work, and lists the project's
 * own top-level directories — everything the agent needs to fix the call in one
 * retry instead of abandoning the tool.
 */
export function scopeGuidance(
  raw: string,
  /** Predicate completing "the `path` scope `x` …" — e.g. "is outside the project". */
  reason: string,
  indexedFiles: readonly string[]
): string {
  const dirs = topLevelDirs(indexedFiles);
  const lines = [
    `No results: the \`path\` scope \`${raw}\` ${reason}.`,
    '',
    '`path` is a PROJECT-RELATIVE directory (`src/mcp`) or glob (`src/**/*.ts`).',
    'Re-run codegraph_explore with a corrected `path`, or omit `path` to search the whole project.',
  ];
  if (dirs.length > 0) {
    lines.push('', `Top-level directories in this project: ${dirs.map((d) => `\`${d}\``).join(', ')}.`);
  }
  return lines.join('\n');
}

/**
 * A `Map` that silently drops nodes outside the scope.
 *
 * `handleExplore` gathers into `subgraph.nodes` from half a dozen places (the
 * relevance search, pinned files, call-graph glue, named-symbol seeding, the
 * change-surface rescue). Swapping the map for this one scopes every one of
 * them by construction, so a later gather step cannot reintroduce a file the
 * scope excluded — the failure mode a hand-placed filter per call site invites.
 */
export class ScopedNodeMap<V extends { filePath: string }> extends Map<string, V> {
  private readonly scope: ExploreScope;

  constructor(scope: ExploreScope, entries?: Iterable<readonly [string, V]>) {
    // Entries are added in the BODY, never handed to `super`: the Map
    // constructor calls the overridden `set`, which would run before `scope`
    // is assigned and throw.
    super();
    this.scope = scope;
    if (entries) for (const [k, v] of entries) this.set(k, v);
  }

  override set(key: string, value: V): this {
    if (!this.scope.matches(value.filePath)) return this;
    return super.set(key, value);
  }
}
