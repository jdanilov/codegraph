/**
 * Data plumbing for the canvas: poll `/api/status`, refetch `/api/graph` when
 * `dataVersion` moves, and hand back a built `GraphModel`.
 *
 * Liveness is the point of the poll: the server auto-starts a watcher, so a
 * file saved in the editor bumps `dataVersion` and the canvas reconciles. The
 * hook deliberately reports a *new model object* rather than mutating in place
 * — the canvas controller diffs it against what is mounted and keeps the user's
 * current root, selection and zoom (`setModel(model, sameProject)`).
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import { fetchGraph, fetchStatus, startIndexing, type IndexEvent, type Status } from '@/lib/api';
import { GraphModel } from './model';

/** How often the shell polls `/api/status` for a `dataVersion` change. */
const POLL_MS = 2000;

export interface GraphData {
  status: Status | null;
  model: GraphModel | null;
  error: string | null;
  indexing: boolean;
  indexLog: string[];
  runIndex(): Promise<void>;
}

export function useGraphData(): GraphData {
  const [status, setStatus] = useState<Status | null>(null);
  const [model, setModel] = useState<GraphModel | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [indexing, setIndexing] = useState(false);
  const [indexLog, setIndexLog] = useState<string[]>([]);
  const loadedVersion = useRef<number | null>(null);
  const inFlight = useRef(false);

  useEffect(() => {
    let cancelled = false;

    const tick = async (): Promise<void> => {
      if (inFlight.current) return;
      inFlight.current = true;
      try {
        const next = await fetchStatus();
        if (cancelled) return;
        setStatus(next);
        setError(null);
        if (next.indexed && loadedVersion.current !== next.dataVersion) {
          const payload = await fetchGraph();
          if (cancelled) return;
          loadedVersion.current = payload.dataVersion;
          setModel(new GraphModel(payload));
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        inFlight.current = false;
      }
    };

    void tick();
    const timer = window.setInterval(() => void tick(), POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  const runIndex = useCallback(async () => {
    setIndexing(true);
    setIndexLog([]);
    try {
      await startIndexing((event) => setIndexLog((lines) => [...lines.slice(-200), describe(event)]));
      loadedVersion.current = null;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIndexing(false);
    }
  }, []);

  return { status, model, error, indexing, indexLog, runIndex };
}

function describe(event: IndexEvent): string {
  switch (event.type) {
    case 'log':
      return event.line ?? '';
    case 'start':
      return `— ${event.step}`;
    case 'error':
      return `error: ${event.message ?? ''}`;
    default:
      return `done (exit ${event.code ?? 0})`;
  }
}
