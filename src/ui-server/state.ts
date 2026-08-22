/**
 * Server-side state for the visualizer: one CodeGraph instance per project
 * root, a live file watcher, and a cheap `dataVersion` the frontend polls.
 *
 * The server owns the graph as a WRITER (the watcher syncs into it), so every
 * route reads through this object rather than opening its own connection.
 * A root with no `.codegraph/` is a normal, supported state — the graph stays
 * null, `/api/status` reports `indexed: false`, and the UI offers to index.
 */
import * as fs from 'fs';
import * as path from 'path';
import type CodeGraphType from '../index';
import { isInitialized } from '../directory';
import { resetExploreHandler } from './explore';

/** What `GET /api/status` returns. */
export interface UiStatus {
  indexed: boolean;
  root: string;
  projectName: string;
  dataVersion: number;
  fileCount: number;
  nodeCount: number;
  edgeCount: number;
  watching: boolean;
  /** True while `POST /api/index` is running a subprocess for this root. */
  indexing: boolean;
  /** Live watching gave up (OS watch limits, lock contention); index is frozen. */
  watcherDegraded: boolean;
}

export class UiServerState {
  readonly projectRoot: string;
  private graph: CodeGraphType | null = null;
  private version = 1;
  private signature: string | null = null;
  private indexing = false;
  /** Bumped by in-process sync completions, which never move `data_version`. */
  private localWrites = 0;

  constructor(projectRoot: string) {
    this.projectRoot = path.resolve(projectRoot);
  }

  /** Absolute path of the project's SQLite database (may not exist yet). */
  private get dbPath(): string {
    return path.join(this.projectRoot, '.codegraph', 'codegraph.db');
  }

  /** Human-readable project name (the root directory's basename). */
  get projectName(): string {
    return path.basename(this.projectRoot) || this.projectRoot;
  }

  /** True when the root has an initialized `.codegraph/` database. */
  isIndexed(): boolean {
    return isInitialized(this.projectRoot);
  }

  /**
   * The open CodeGraph instance, opening (and starting the watcher) on first
   * use once the project is initialized. Returns null for an un-indexed root —
   * callers must handle that rather than throwing at the user.
   */
  async graphOrNull(): Promise<CodeGraphType | null> {
    if (this.graph) {
      // Heal a `.codegraph/` that was removed and recreated underneath us.
      try {
        this.graph.reopenIfReplaced();
      } catch {
        /* best-effort: the existing handle keeps serving */
      }
      return this.graph;
    }
    if (this.indexing || !this.isIndexed()) return null;
    const { default: CodeGraph } = await import('../index');
    const graph = await CodeGraph.open(this.projectRoot);
    this.graph = graph;
    this.startWatching();
    return graph;
  }

  /** Start auto-sync watching; harmless (and idempotent) if already active. */
  private startWatching(): void {
    if (!this.graph) return;
    try {
      this.graph.watch({
        onSyncComplete: () => {
          this.localWrites++;
        },
      });
    } catch {
      // Watching is a convenience; a project on a filesystem that can't watch
      // still serves a (static) graph.
    }
  }

  /** True while an `/api/index` subprocess owns the database. */
  isIndexing(): boolean {
    return this.indexing;
  }

  /**
   * Release the database so an external `codegraph index` subprocess can
   * recreate it. The next `graphOrNull()` after {@link endIndexing} reopens.
   */
  beginIndexing(): void {
    this.indexing = true;
    this.closeGraph();
  }

  /** Re-open the graph after an external index run finished. */
  endIndexing(): void {
    this.indexing = false;
    this.localWrites++;
  }

  /** Close (but keep the state usable — the next request reopens). */
  private closeGraph(): void {
    const graph = this.graph;
    this.graph = null;
    // The explore handler holds this instance; a cached one would keep
    // querying a closed database after an index run swapped it out.
    resetExploreHandler();
    if (!graph) return;
    try {
      graph.unwatch();
    } catch {
      /* ignore */
    }
    try {
      graph.close();
    } catch {
      /* ignore */
    }
  }

  /** Shut down for good (server close). */
  close(): void {
    this.closeGraph();
  }

  /**
   * A monotonically increasing version that changes whenever the index could
   * have changed. Cheap enough to poll every second: two `stat` calls plus one
   * `PRAGMA data_version` (which catches commits from other processes; our own
   * in-process syncs are covered by `localWrites`).
   */
  dataVersion(): number {
    const signature = this.computeSignature();
    if (this.signature === null) {
      this.signature = signature;
    } else if (signature !== this.signature) {
      this.signature = signature;
      this.version++;
    }
    return this.version;
  }

  private computeSignature(): string {
    const parts: string[] = [String(this.localWrites)];
    for (const file of [this.dbPath, `${this.dbPath}-wal`]) {
      try {
        const stat = fs.statSync(file);
        parts.push(`${stat.mtimeMs}:${stat.size}`);
      } catch {
        parts.push('-');
      }
    }
    if (this.graph) {
      try {
        parts.push(String(this.graph.getDatabase().getDb().pragma('data_version', { simple: true })));
      } catch {
        parts.push('-');
      }
    }
    return parts.join('|');
  }

  /** The `/api/status` payload. */
  async status(): Promise<UiStatus> {
    const graph = await this.graphOrNull();
    const base: UiStatus = {
      indexed: this.isIndexed(),
      root: this.projectRoot,
      projectName: this.projectName,
      dataVersion: this.dataVersion(),
      fileCount: 0,
      nodeCount: 0,
      edgeCount: 0,
      watching: false,
      indexing: this.indexing,
      watcherDegraded: false,
    };
    if (!graph) return base;

    const db = graph.getDatabase().getDb();
    const counts = db
      .prepare(
        'SELECT (SELECT count(*) FROM nodes) AS nodes, (SELECT count(*) FROM edges) AS edges, (SELECT count(*) FROM files) AS files'
      )
      .get() as { nodes?: number; edges?: number; files?: number } | undefined;

    return {
      ...base,
      nodeCount: Number(counts?.nodes ?? 0),
      edgeCount: Number(counts?.edges ?? 0),
      fileCount: Number(counts?.files ?? 0),
      watching: graph.isWatching(),
      watcherDegraded: graph.isWatcherDegraded(),
    };
  }
}
