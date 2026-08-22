/**
 * Phase A's status shell, now a floating panel over the canvas (contract:
 * "the graph is the background; code panels / views float on top").
 *
 * It collapses to a single line once the graph is up — the numbers matter while
 * you are waiting for an index, not while you are reading the graph.
 */
import { useState } from 'react';
import { Activity, ChevronDown, ChevronUp, Loader2, Play } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import type { Status } from '@/lib/api';
import { cn, formatNumber } from '@/lib/utils';

export interface StatusPanelProps {
  status: Status | null;
  error: string | null;
  indexing: boolean;
  indexLog: string[];
  onIndex(): void;
}

export function StatusPanel({ status, error, indexing, indexLog, onIndex }: StatusPanelProps) {
  const [open, setOpen] = useState(false);
  const busy = indexing || Boolean(status?.indexing);
  const needsIndex = Boolean(status && !status.indexed);

  return (
    <Card className="pointer-events-auto w-[22rem] p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[10px] uppercase tracking-[0.3em] text-muted">CodeGraph</p>
          <h1 className="mt-0.5 truncate text-lg font-semibold tracking-tight">
            {status?.projectName ?? 'Loading…'}
          </h1>
          <p className="truncate font-mono text-[10px] text-muted" title={status?.root ?? ''}>
            {status?.root ?? ''}
          </p>
        </div>
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          className="rounded p-1 text-muted transition-colors hover:text-foreground"
          aria-label={open ? 'Collapse details' : 'Expand details'}
        >
          {open ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
        </button>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {status?.watching ? (
          <Badge variant="accent">
            <Activity className="h-3 w-3" /> watching
          </Badge>
        ) : (
          <Badge variant="muted">not watching</Badge>
        )}
        {status?.watcherDegraded ? <Badge variant="muted">watcher degraded</Badge> : null}
        {status?.indexed ? (
          <Badge variant="muted">v{status.dataVersion}</Badge>
        ) : (
          <Badge variant="muted">not indexed</Badge>
        )}
      </div>

      {open || needsIndex || error ? (
        <div className="mt-3 flex flex-col gap-3">
          <dl className="grid grid-cols-3 gap-2 text-center">
            <Stat label="nodes" value={status?.nodeCount ?? 0} />
            <Stat label="edges" value={status?.edgeCount ?? 0} />
            <Stat label="files" value={status?.fileCount ?? 0} />
          </dl>

          {error ? <p className="text-[11px] text-accent">{error}</p> : null}

          {needsIndex ? (
            <div className="flex flex-col gap-2">
              <p className="text-[11px] leading-relaxed text-muted">
                This project isn&apos;t indexed yet. Building the graph is local and
                deterministic — nothing leaves this machine.
              </p>
              <Button size="sm" onClick={onIndex} disabled={busy}>
                {busy ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Play className="h-3.5 w-3.5" />
                )}
                {busy ? 'Indexing…' : 'Index now'}
              </Button>
            </div>
          ) : null}

          {indexLog.length > 0 ? (
            <pre
              className={cn(
                'max-h-40 overflow-auto rounded-md border border-border bg-background/70 p-2',
                'font-mono text-[10px] leading-relaxed text-muted'
              )}
            >
              {indexLog.join('\n')}
            </pre>
          ) : null}
        </div>
      ) : null}
    </Card>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border border-border/60 py-1.5">
      <dd className="font-mono text-sm">{formatNumber(value)}</dd>
      <dt className="text-[9px] uppercase tracking-widest text-muted">{label}</dt>
    </div>
  );
}
