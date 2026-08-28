/**
 * Typed client for the `codegraph ui` HTTP API.
 *
 * Shapes mirror `docs/design/visualizer.md`; keep them in sync with
 * `src/ui-server/` when the contract grows.
 */
import type { SortMode } from '@/graph/sunburst';

export interface Status {
  indexed: boolean;
  root: string;
  projectName: string;
  dataVersion: number;
  fileCount: number;
  nodeCount: number;
  edgeCount: number;
  watching: boolean;
  indexing: boolean;
  watcherDegraded: boolean;
}

export interface GraphNode {
  id: string;
  kind: string;
  name: string;
  qualifiedName: string;
  file: string;
  startLine: number;
  endLine: number;
  parent: string | null;
  layer?: string;
}

export interface GraphEdge {
  source: string;
  target: string;
  kind: string;
  provenance?: string;
  synthesizedBy?: string;
  registeredAt?: string;
  line?: number;
}

export interface GraphDir {
  id: string;
  path: string;
  parent: string | null;
  fileCount: number;
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
  layers: string[];
}

export interface IndexEvent {
  type: 'start' | 'log' | 'done' | 'error';
  step?: 'init' | 'index';
  stream?: 'stdout' | 'stderr';
  line?: string;
  message?: string;
  code?: number;
  ok?: boolean;
}

/** A node as it appears in `/api/node/:id` (both the subject and its relatives). */
export interface NodeRef {
  id: string;
  kind: string;
  name: string;
  qualifiedName: string;
  file: string;
  startLine: number;
  endLine: number;
}

/** One relation of the selected node, with the node at the other end resolved. */
export interface NodeRelation extends GraphEdge {
  node: NodeRef | null;
}

export interface SourceSpan {
  file: string;
  startLine: number;
  endLine: number;
  mode: 'full';
  content: string;
  truncated: boolean;
  totalLines: number;
}

export interface NodeDetail {
  node: NodeRef & {
    language?: string;
    signature: string | null;
    docstring: string | null;
    visibility: string | null;
    isExported: boolean;
    parent: string | null;
    layer?: string;
  };
  contains: NodeRef[];
  outgoing: NodeRelation[];
  incoming: NodeRelation[];
  source: SourceSpan | null;
}

export type DiffLineType = 'ctx' | 'add' | 'del';

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  heading?: string;
  lines: Array<{ type: DiffLineType; text: string }>;
}

/**
 * `GET /api/source?mode=diff`. A non-git root answers 409 but still carries
 * this shape with `git: false`, so there is one parse path for both.
 */
export interface SourceDiff {
  file: string;
  mode: 'diff';
  startLine?: number;
  endLine?: number;
  status: 'modified' | 'added' | 'deleted' | 'untracked' | 'unchanged';
  hunks: DiffHunk[];
  hunksOutsideSpan: number;
  binary: boolean;
  truncated: boolean;
  git: boolean;
}

export interface SearchHit {
  id: string;
  name: string;
  qualifiedName: string;
  kind: string;
  file: string;
}

/** `GET /api/settings` — the API key only ever comes back masked. */
export interface SettingsView {
  editorCommand: string | null;
  model: string | null;
  /** Sibling order on the disk: `structural` (default) or `size`. */
  sortMode: SortMode;
  anthropicApiKey: string | null;
  anthropicApiKeySet: boolean;
}

/** One hop of an explore result's flow: `from` reaches `to` via `via`. */
export interface FlowHop {
  from: string;
  to: string;
  /** The synthesizer that wired a heuristic hop, else the edge kind. */
  via: string;
}

export interface EdgeRef {
  source: string;
  target: string;
  kind: string;
  provenance?: string;
  synthesizedBy?: string;
}

/** `POST /api/explore` — the structured twin of the `codegraph_explore` tool. */
export interface ExploreResult {
  nodeIds: string[];
  edgeRefs: EdgeRef[];
  flow: FlowHop[];
  summary: string;
  /**
   * The two numbers `summary` quotes, derived from `nodeIds` — so the list a
   * card renders and the sentence above it can never disagree. Optional
   * because cards saved before this shipped don't carry them.
   */
  symbolCount?: number;
  fileCount?: number;
  /** Present on `/api/ask` answers: the symbol bag the model produced. */
  symbolBag?: string;
}

export const EMPTY_EXPLORE_RESULT: ExploreResult = {
  nodeIds: [],
  edgeRefs: [],
  flow: [],
  summary: '',
};

/** A saved question and the answer it produced. */
export interface Card {
  id: string;
  question: string;
  createdAt: number;
  result?: ExploreResult;
}

export type ChangeStatus = 'added' | 'modified' | 'deleted' | 'untracked';

export interface ChangedNode {
  id: string;
  status: 'added' | 'modified' | 'deleted';
  file: string;
  name: string;
  kind: string;
  startLine: number;
  endLine: number;
}

export interface ChangedFile {
  path: string;
  status: ChangeStatus;
  /** null when the index no longer holds the file (a deleted one, usually). */
  nodeId: string | null;
  nodeCount: number;
  hunkCount: number;
  /**
   * Lines gained / lost against HEAD, over ALL of the file's hunks — the ones
   * the payload's caps dropped included. This is what the canvas sizes a
   * changed wedge's green/red sub-wedges from; counting `hunks` here instead
   * would under-report exactly the biggest edits.
   */
  addedLines: number;
  removedLines: number;
  binary: boolean;
}

export type FileHunk = DiffHunk & { file: string };

/** `GET /api/changes`. A non-git root answers 409 carrying this same shape. */
export interface ChangesPayload {
  changedNodes: ChangedNode[];
  changedFiles: ChangedFile[];
  impactedNodeIds: string[];
  hunks: FileHunk[];
  git: boolean;
  truncated: boolean;
}

async function getJson<T>(
  path: string,
  signal?: AbortSignal,
  cache?: RequestCache
): Promise<T> {
  const init: RequestInit = { headers: { Accept: 'application/json' } };
  if (signal) init.signal = signal;
  if (cache) init.cache = cache;
  const response = await fetch(path, init);
  if (!response.ok) {
    throw new Error(`${path} failed: ${response.status}`);
  }
  return (await response.json()) as T;
}

export function fetchStatus(): Promise<Status> {
  return getJson<Status>('/api/status');
}

/**
 * The graph.
 *
 * `/api/graph` is the one route that is allowed to be cached (it revalidates
 * against an ETag, which is what makes the poll cheap). `fresh` bypasses that
 * cache: the caller has evidence the stored copy describes a DIFFERENT project
 * and wants the bytes from the server, not from the browser.
 */
export function fetchGraph(fresh = false): Promise<GraphPayload> {
  return getJson<GraphPayload>('/api/graph', undefined, fresh ? 'reload' : undefined);
}

export function fetchNode(id: string, signal?: AbortSignal): Promise<NodeDetail> {
  return getJson<NodeDetail>(`/api/node/${encodeURIComponent(id)}`, signal);
}

export function fetchSource(
  file: string,
  start?: number,
  end?: number,
  signal?: AbortSignal
): Promise<SourceSpan> {
  return getJson<SourceSpan>(`/api/source?${spanQuery(file, start, end)}&mode=full`, signal);
}

/**
 * Diff hunks for a span. A root without git answers 409 *with* the diff shape,
 * which is a real answer ("no version control here") rather than a failure —
 * so it is read out of the error body instead of thrown.
 */
export async function fetchSourceDiff(
  file: string,
  start?: number,
  end?: number,
  signal?: AbortSignal
): Promise<SourceDiff> {
  const url = `/api/source?${spanQuery(file, start, end)}&mode=diff`;
  const response = await fetch(url, { headers: { Accept: 'application/json' }, signal });
  const body = (await response.json().catch(() => null)) as (SourceDiff & ApiErrorBody) | null;
  if (response.ok && body) return body;
  if (response.status === 409 && body && Array.isArray(body.hunks)) return body;
  throw new Error(body?.error?.message ?? `${url} failed: ${response.status}`);
}

export function searchNodes(query: string, signal?: AbortSignal): Promise<SearchHit[]> {
  return getJson<SearchHit[]>(`/api/search?q=${encodeURIComponent(query)}`, signal);
}

export function fetchSettings(): Promise<SettingsView> {
  return getJson<SettingsView>('/api/settings');
}

/**
 * Persist settings. Absent fields are left alone server-side, and a masked key
 * echoed back unchanged is ignored — so the form never overwrites a real key
 * with the bullets it displayed.
 */
export async function saveSettings(patch: Record<string, string | null>): Promise<SettingsView> {
  const response = await fetch('/api/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as ApiErrorBody | null;
    throw new Error(body?.error?.message ?? `Saving settings failed (${response.status})`);
  }
  return (await response.json()) as SettingsView;
}

export type OpenResult =
  | { ok: true }
  /** No editor command configured (409) — the caller falls back to `vscode://`. */
  | { ok: false; reason: 'unconfigured' }
  | { ok: false; reason: 'failed'; message: string };

export async function openInEditor(file: string, line: number): Promise<OpenResult> {
  try {
    const response = await fetch('/api/open', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ file, line }),
    });
    if (response.ok) return { ok: true };
    if (response.status === 409) return { ok: false, reason: 'unconfigured' };
    const body = (await response.json().catch(() => null)) as ApiErrorBody | null;
    return {
      ok: false,
      reason: 'failed',
      message: body?.error?.message ?? `Open failed (${response.status})`,
    };
  } catch (err) {
    return { ok: false, reason: 'failed', message: err instanceof Error ? err.message : String(err) };
  }
}

interface ApiErrorBody {
  error?: { code?: string; message?: string };
}

/** Raw text → explore. Always available; needs no API key. */
export async function exploreQuery(query: string, signal?: AbortSignal): Promise<ExploreResult> {
  const response = await fetch('/api/explore', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
    signal,
  });
  const body = (await response.json().catch(() => null)) as (ExploreResult & ApiErrorBody) | null;
  if (response.ok && body) return body;
  throw new Error(body?.error?.message ?? `Explore failed (${response.status})`);
}

export type AskOutcome =
  | { ok: true; result: ExploreResult }
  /** No API key configured (501) — the caller keeps the plain explore answer. */
  | { ok: false; reason: 'unconfigured'; message: string }
  | { ok: false; reason: 'failed'; message: string };

/**
 * Question → model → symbol bag → the same explore.
 *
 * Both failure modes are reported rather than thrown, because the client's
 * response to either is identical: keep the deterministic answer it already has.
 */
export async function askQuestion(question: string, signal?: AbortSignal): Promise<AskOutcome> {
  try {
    const response = await fetch('/api/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question }),
      signal,
    });
    const body = (await response.json().catch(() => null)) as (ExploreResult & ApiErrorBody) | null;
    if (response.ok && body) return { ok: true, result: body };
    const message = body?.error?.message ?? `Ask failed (${response.status})`;
    if (response.status === 501) return { ok: false, reason: 'unconfigured', message };
    return { ok: false, reason: 'failed', message };
  } catch (err) {
    return { ok: false, reason: 'failed', message: err instanceof Error ? err.message : String(err) };
  }
}

export function fetchCards(): Promise<Card[]> {
  return getJson<Card[]>('/api/cards');
}

/** Persist the whole card list (the endpoint is a replace, not a patch). */
export async function saveCards(cards: Card[]): Promise<Card[]> {
  const response = await fetch('/api/cards', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cards),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as ApiErrorBody | null;
    throw new Error(body?.error?.message ?? `Saving cards failed (${response.status})`);
  }
  return (await response.json()) as Card[];
}

/**
 * `GET /api/changes`. A project outside git answers 409 *with* the payload
 * (`git: false`), which is an answer — "nothing to compare" — not a failure.
 */
export async function fetchChanges(signal?: AbortSignal): Promise<ChangesPayload> {
  const response = await fetch('/api/changes', {
    headers: { Accept: 'application/json' },
    signal,
  });
  const body = (await response.json().catch(() => null)) as (ChangesPayload & ApiErrorBody) | null;
  if (response.ok && body) return body;
  if (response.status === 409 && body && Array.isArray(body.changedNodes)) return body;
  throw new Error(body?.error?.message ?? `Changes failed (${response.status})`);
}

function spanQuery(file: string, start?: number, end?: number): string {
  const params = new URLSearchParams({ file });
  if (start !== undefined && start > 0) params.set('start', String(start));
  if (end !== undefined && end > 0) params.set('end', String(end));
  return params.toString();
}

/**
 * Kick off an index build, streaming the server's newline-delimited progress
 * events to `onEvent` until the run finishes.
 */
export async function startIndexing(onEvent: (event: IndexEvent) => void): Promise<void> {
  const response = await fetch('/api/index', { method: 'POST' });
  if (!response.ok || !response.body) {
    const detail = await response.text().catch(() => '');
    throw new Error(detail || `Indexing failed to start (${response.status})`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        onEvent(JSON.parse(line) as IndexEvent);
      } catch {
        /* a partial line is never fatal */
      }
    }
  }
}
