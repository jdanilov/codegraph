/**
 * Colour legend + mode switch.
 *
 * Contract: colour is a switchable mode (node kind / layer) and the layer mode
 * is hidden entirely when the project has no layer vocabulary. The legend only
 * lists values that occur in the currently mounted slice, so it shrinks as you
 * drill in rather than showing a wall of kinds that aren't on screen.
 */
import { Palette } from 'lucide-react';

import { cn } from '@/lib/utils';
import { legendEntries, type ColorMode } from '@/graph/palette';

export interface LegendProps {
  mode: ColorMode;
  onModeChange(mode: ColorMode): void;
  /** Layer vocabulary from `/api/graph`; empty hides the layer mode. */
  layers: string[];
  /** Kinds (or layers) present in the mounted slice. */
  present: string[];
}

export function Legend({ mode, onModeChange, layers, present }: LegendProps) {
  const entries = legendEntries(mode, new Set(present), layers);
  const canSwitch = layers.length > 0;

  return (
    <div className="pointer-events-auto w-52 rounded-lg border border-border bg-surface/70 p-3 shadow-sm backdrop-blur-md">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-[10px] uppercase tracking-[0.2em] text-muted">
          <Palette className="h-3 w-3" /> colour
        </span>
        {canSwitch ? (
          <div className="flex rounded-md border border-border p-0.5">
            {(['kind', 'layer'] as const).map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => onModeChange(option)}
                className={cn(
                  'rounded px-2 py-0.5 text-[10px] font-medium transition-colors',
                  mode === option
                    ? 'bg-accent text-accent-foreground'
                    : 'text-muted hover:text-foreground'
                )}
              >
                {option}
              </button>
            ))}
          </div>
        ) : (
          <span className="text-[10px] text-muted">kind</span>
        )}
      </div>

      <ul className="mt-2.5 flex max-h-64 flex-col gap-1 overflow-auto">
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
    </div>
  );
}
