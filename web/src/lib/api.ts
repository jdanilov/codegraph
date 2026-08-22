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

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(path, { headers: { Accept: 'application/json' } });
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
