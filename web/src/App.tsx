import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Activity, Boxes, FileCode2, GitBranch, Loader2, Play } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  fetchGraph,
  fetchStatus,
  startIndexing,
  type GraphPayload,
  type Status,
} from '@/lib/api';
import { cn, formatNumber } from '@/lib/utils';

/** How often the shell polls `/api/status` for a `dataVersion` change. */
const POLL_MS = 2000;

export default function App() {
  const [status, setStatus] = useState<Status | null>(null);
  const [graph, setGraph] = useState<GraphPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [indexLog, setIndexLog] = useState<string[]>([]);
  const [indexing, setIndexing] = useState(false);
  const loadedVersion = useRef<number | null>(null);

  // Poll status; refetch the graph only when the data version moves.
  useEffect(() => {
    let cancelled = false;

    const tick = async () => {
      try {
        const next = await fetchStatus();
        if (cancelled) return;
        setStatus(next);
        setError(null);
        if (next.indexed && loadedVersion.current !== next.dataVersion) {
          loadedVersion.current = next.dataVersion;
          const payload = await fetchGraph();
          if (!cancelled) setGraph(payload);
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
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
      await startIndexing((event) => {
        const line =
          event.type === 'log'
            ? (event.line ?? '')
            : event.type === 'start'
              ? `— ${event.step}`
              : event.type === 'error'
                ? `error: ${event.message ?? ''}`
                : `done (exit ${event.code ?? 0})`;
        setIndexLog((previous) => [...previous.slice(-200), line]);
      });
      loadedVersion.current = null;
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIndexing(false);
    }
  }, []);

  const busy = indexing || Boolean(status?.indexing);

  return (
    <div className="min-h-full w-full px-6 py-10 sm:px-10">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-8">
        <header className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-xs uppercase tracking-[0.3em] text-muted">CodeGraph</p>
            <h1 className="mt-1 text-3xl font-semibold tracking-tight">
              {status?.projectName ?? 'Loading…'}
            </h1>
            <p className="mt-1 font-mono text-xs text-muted">{status?.root ?? ''}</p>
          </div>
          <div className="flex items-center gap-2">
            {status?.watching ? (
              <Badge variant="accent">
                <Activity className="h-3 w-3" /> watching
              </Badge>
            ) : (
              <Badge variant="muted">not watching</Badge>
            )}
            {status?.watcherDegraded ? <Badge variant="muted">watcher degraded</Badge> : null}
          </div>
        </header>

        {error ? (
          <Card className="border-accent/40">
            <CardContent className="p-5 text-sm text-muted">{error}</CardContent>
          </Card>
        ) : null}

        {status && !status.indexed ? (
          <Card>
            <CardHeader>
              <CardTitle>This project isn&apos;t indexed yet</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <p className="text-sm text-muted">
                Build the graph to explore it here. Indexing is local and deterministic — nothing
                leaves this machine.
              </p>
              <div>
                <Button onClick={() => void runIndex()} disabled={busy}>
                  {busy ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <Play className="h-4 w-4" />
                  )}
                  {busy ? 'Indexing…' : 'Index now'}
                </Button>
              </div>
              {indexLog.length > 0 ? <IndexLog lines={indexLog} /> : null}
            </CardContent>
          </Card>
        ) : null}

        <section className="grid gap-4 sm:grid-cols-3">
          <Stat
            icon={<Boxes className="h-4 w-4" />}
            label="Nodes"
            value={graph?.nodes.length ?? status?.nodeCount ?? 0}
          />
          <Stat
            icon={<GitBranch className="h-4 w-4" />}
            label="Edges"
            value={graph?.edges.length ?? status?.edgeCount ?? 0}
            hint={graph ? 'excludes contains (the backbone)' : undefined}
          />
          <Stat
            icon={<FileCode2 className="h-4 w-4" />}
            label="Files"
            value={status?.fileCount ?? 0}
          />
        </section>

        {graph ? (
          <Card>
            <CardHeader>
              <CardTitle>Graph loaded</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-2 text-sm text-muted">
              <p>
                {formatNumber(graph.dirs.length)} directories · data version{' '}
                {graph.dataVersion}
                {graph.layers.length > 0 ? ` · layers: ${graph.layers.join(', ')}` : ''}
              </p>
              <p className="text-xs">The interactive canvas arrives in the next phase.</p>
            </CardContent>
          </Card>
        ) : null}

        {status?.indexed && indexLog.length > 0 ? <IndexLog lines={indexLog} /> : null}
      </div>
    </div>
  );
}

function Stat({
  icon,
  label,
  value,
  hint,
}: {
  icon: ReactNode;
  label: string;
  value: number;
  hint?: string;
}) {
  return (
    <Card>
      <CardContent className="flex flex-col gap-1 p-5">
        <span className="flex items-center gap-2 text-xs uppercase tracking-widest text-muted">
          {icon}
          {label}
        </span>
        <span className="font-mono text-2xl">{formatNumber(value)}</span>
        {hint ? <span className="text-xs text-muted">{hint}</span> : null}
      </CardContent>
    </Card>
  );
}

function IndexLog({ lines }: { lines: string[] }) {
  return (
    <pre
      className={cn(
        'max-h-64 overflow-auto rounded-md border border-border bg-background/70 p-3',
        'font-mono text-xs leading-relaxed text-muted'
      )}
    >
      {lines.join('\n')}
    </pre>
  );
}
