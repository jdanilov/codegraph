/**
 * LEGEND — what the colours on the disk mean.
 *
 * Phase F moved this out of the top-right corner (it was the COLOR panel there)
 * and into the left column beside the questions, because the right-hand side is
 * now reserved for the selection: the node panel and the code panel and nothing
 * else. The `Fit` control came with it — re-fitting the disk is a navigation
 * action, and navigation lives on the left.
 *
 * The panel carries BOTH colour vocabularies:
 *
 *  - **arcs** — the active colour mode's swatches, listing only what is
 *    actually mounted, so it shrinks as you drill in;
 *  - **edges** — direction (incoming green, outgoing amber) and provenance
 *    (solid parsed, dashed synthesized).
 *
 * Every value is imported from `@/graph/palette`, never re-typed here: the
 * canvas paints from the same tables, so the legend cannot drift from the disk.
 *
 * What is NOT here any more: the wedge/budget count, the ring count and the
 * edges-rendered readout. That was renderer telemetry — no question a developer
 * reading a codebase actually asks (phase F, "no renderer telemetry on screen").
 */
import { Crosshair, Palette } from 'lucide-react';

import { Card } from '@/components/ui/card';
import {
  EDGE_DIRECTION_LEGEND,
  EDGE_PROVENANCE_LEGEND,
  legendEntries,
  type ColorMode,
} from '@/graph/palette';
import { cn } from '@/lib/utils';

export interface LegendPanelProps {
  mode: ColorMode;
  onModeChange(mode: ColorMode): void;
  /** Layer vocabulary from `/api/graph`; empty hides the layer mode. */
  layers: string[];
  /** Kinds (or layers) present in the mounted slice. */
  present: string[];
  /** Reset zoom and centre the disk. */
  onFit(): void;
}

export function LegendPanel({ mode, onModeChange, layers, present, onFit }: LegendPanelProps) {
  const entries = legendEntries(mode, new Set(present), layers);
  const canSwitch = layers.length > 0;

  return (
    <Card className="pointer-events-auto flex flex-col p-3" data-testid="legend-panel">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-[10px] uppercase tracking-[0.2em] text-muted">
          <Palette className="h-3 w-3" /> legend
        </span>
        <div className="flex items-center gap-1.5">
          {canSwitch ? (
            <div className="flex rounded-md border border-border p-0.5">
              {(['kind', 'layer'] as const).map((option) => (
                <button
                  key={option}
                  type="button"
                  onClick={() => onModeChange(option)}
                  className={cn(
                    'rounded px-2 py-0.5 text-[10px] font-medium',
                    mode === option
                      ? 'bg-accent text-accent-foreground'
                      : 'text-muted hover:text-foreground'
                  )}
                >
                  {option}
                </button>
              ))}
            </div>
          ) : null}
          <button
            type="button"
            onClick={onFit}
            data-testid="fit-view"
            title="Reset zoom and centre the disk"
            className="flex items-center gap-1 rounded-md border border-border px-1.5 py-0.5 text-[10px] text-muted hover:border-accent/60 hover:text-foreground"
          >
            <Crosshair className="h-3 w-3" /> fit
          </button>
        </div>
      </div>

      <ul className="mt-2.5 flex max-h-48 flex-col gap-1 overflow-auto">
        {entries.map((entry) => (
          <li key={entry.key} className="flex items-center gap-2 text-[11px] text-muted">
            <span
              className="h-2.5 w-2.5 shrink-0 rounded-full"
              style={{ backgroundColor: entry.color }}
            />
            <span className="truncate">{entry.label}</span>
          </li>
        ))}
        {entries.length === 0 ? <li className="text-[11px] text-muted">nothing mounted</li> : null}
      </ul>

      <div className="mt-2.5 border-t border-border/60 pt-2">
        <span className="text-[9px] uppercase tracking-[0.18em] text-muted">edges</span>
        <ul className="mt-1 flex flex-col gap-1">
          {EDGE_DIRECTION_LEGEND.map((entry) => (
            <li
              key={entry.key}
              className="flex items-center gap-2 text-[11px] text-muted"
              title={entry.meaning}
            >
              <span
                className="h-0.5 w-3.5 shrink-0 rounded-full"
                style={{ backgroundColor: entry.color }}
              />
              <span className="truncate">{entry.label}</span>
            </li>
          ))}
          {EDGE_PROVENANCE_LEGEND.map((entry) => (
            <li
              key={entry.key}
              className="flex items-center gap-2 text-[11px] text-muted"
              title={entry.meaning}
            >
              <span
                className={cn(
                  'w-3.5 shrink-0 border-t',
                  entry.dashed ? 'border-dashed border-muted' : 'border-solid border-muted'
                )}
              />
              <span className="truncate">{entry.label}</span>
            </li>
          ))}
        </ul>
      </div>
    </Card>
  );
}
