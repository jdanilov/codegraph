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
      {/* The live state belongs BESIDE the title, not on a row of its own
          (phase F): "watching" and the data version are one glance's worth of
          information, and a dedicated band for them pushed the project name
          and its path down the panel for nothing. */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[10px] uppercase tracking-[0.3em] text-muted">CodeGraph</span>
            {status?.watching ? (
              <Badge variant="accent" className="px-1.5 py-0 text-[9px]">
                <Activity className="h-2.5 w-2.5" /> watching
              </Badge>
            ) : (
              <Badge variant="muted" className="px-1.5 py-0 text-[9px]">
                not watching
              </Badge>
            )}
            {status?.indexed ? (
              <Badge variant="muted" className="px-1.5 py-0 text-[9px]">
                v{status.dataVersion}
              </Badge>
            ) : (
              <Badge variant="muted" className="px-1.5 py-0 text-[9px]">
                not indexed
              </Badge>
            )}
            {status?.watcherDegraded ? (
              <Badge variant="muted" className="px-1.5 py-0 text-[9px]">
                watcher degraded
              </Badge>
            ) : null}
          </div>
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
          className="shrink-0 rounded p-1 text-muted hover:text-foreground"
          aria-label={open ? 'Collapse details' : 'Expand details'}
        >
          {open ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
        </button>
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
