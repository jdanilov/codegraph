/**
 * Typed client for the `codegraph ui` HTTP API.
 *
 * Shapes mirror `docs/design/visualizer.md`; keep them in sync with
 * `src/ui-server/` when the contract grows.
 */

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
  anthropicApiKey: string | null;
  anthropicApiKeySet: boolean;
}

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(path, { headers: { Accept: 'application/json' }, signal });
  if (!response.ok) {
    throw new Error(`${path} failed: ${response.status}`);
  }
  return (await response.json()) as T;
}

export function fetchStatus(): Promise<Status> {
  return getJson<Status>('/api/status');
}

export function fetchGraph(): Promise<GraphPayload> {
  return getJson<GraphPayload>('/api/graph');
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
