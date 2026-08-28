/**
 * LEGEND — what the colours on the disk mean.
 *
 * Phase F moved this out of the top-right corner (it was the COLOR panel there)
 * and into the left column beside the questions, because the right-hand side is
 * now reserved for the selection: the node panel and the code panel and nothing
 * else. The `Fit` control came with it — re-fitting the disk is a navigation
 * action, and navigation lives on the left.
 *
 * The panel carries the two colour vocabularies:
 *
 *  - **arcs** — the active colour mode's swatches, listing only what is
 *    actually mounted, so it shrinks as you drill in. A swatch is also a
 *    FILTER (round 4): clicking one makes that category invisible on the disk
 *    — not dimmed, absent — while the layout stays exactly as it was, so
 *    nothing moves under the cursor. A switched-off row is drawn muted.
 *  - **edges** — direction, as one compact row: `EDGES ● incoming ● outgoing`.
 *    This is where the side-by-side treatment belongs; the node panel's own
 *    incoming/outgoing lists are stacked, one after the other (round 4).
 *
 * Every value is imported from `@/graph/palette`, never re-typed here: the
 * canvas paints from the same tables, so the legend cannot drift from the disk.
 *
 * Its header is also where the disk's own switches live — the colour mode,
 * `fit`, and (round B4) the **changes** toggle that replaced the standing
 * Changes card. They are all the same kind of control: how the disk in front of
 * you is drawn, as opposed to where you are standing in it.
 *
 * What is NOT here: the wedge/budget count, the ring count and the
 * edges-rendered readout — that was renderer telemetry, no question a developer
 * reading a codebase actually asks (phase F, "no renderer telemetry on screen")
 * — and, from round 2, the solid/dashed PROVENANCE rows. The canvas still
 * dashes a synthesized relation; a legend row explaining it cost four lines of
 * a panel that has to fit under the questions, for a distinction the node panel
 * already spells out in words on the relation itself.
 *
 * Like the two right-hand panels, the legend COLLAPSES to its title bar rather
 * than closing (round 2) — the same affordance, in the same place.
 */
import { ChevronDown, ChevronRight, Crosshair, FileDiff, Palette } from 'lucide-react';

import { PanelButton } from '@/components/graph/side-panel';
import { Card } from '@/components/ui/card';
import { EDGE_DIRECTION_LEGEND, legendEntries, type ColorMode } from '@/graph/palette';
import { cn } from '@/lib/utils';

export interface LegendPanelProps {
  mode: ColorMode;
  onModeChange(mode: ColorMode): void;
  /** Layer vocabulary from `/api/graph`; empty hides the layer mode. */
  layers: string[];
  /** Kinds (or layers) present in the mounted slice. */
  present: string[];
  /** Categories currently switched OFF — invisible on the disk. */
  hidden: string[];
  /** Toggle one category's visibility. */
  onToggleKey(key: string): void;
  /** Reset zoom and centre the disk. */
  onFit(): void;
  /**
   * Uncommitted work shown on the disk and in the bubbles, or not (round B4).
   *
   * This replaced the standing "Changes" CARD: what a reader wanted from it was
   * never a place to go — it was an overlay to have on or off while they read
   * whatever they were already reading. It lives here rather than in the
   * questions panel because that is what this panel is: the switches for how
   * the disk is drawn, beside the colour mode and `fit`.
   */
  changesShown: boolean;
  onToggleChanges(): void;
  /** Why changes are unavailable (not a git tree, read failed) — a tooltip. */
  changesHint?: string | null;
  collapsed: boolean;
  onToggleCollapsed(): void;
}

export function LegendPanel({
  mode,
  onModeChange,
  layers,
  present,
  hidden,
  onToggleKey,
  onFit,
  changesShown,
  onToggleChanges,
  changesHint,
  collapsed,
  onToggleCollapsed,
}: LegendPanelProps) {
  const off = new Set(hidden);
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
            onClick={onToggleChanges}
            data-testid="toggle-changes"
            aria-pressed={changesShown}
            title={
              changesHint ??
              (changesShown
                ? 'Hide uncommitted changes on the disk'
                : 'Show uncommitted changes on the disk')
            }
            className={cn(
              'flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px]',
              changesShown
                ? 'border-accent/60 bg-accent/15 text-accent'
                : 'border-border text-muted hover:border-accent/60 hover:text-foreground'
            )}
          >
            <FileDiff className="h-3 w-3" /> changes
          </button>
          <button
            type="button"
            onClick={onFit}
            data-testid="fit-view"
            title="Reset zoom and centre the disk"
            className="flex items-center gap-1 rounded-md border border-border px-1.5 py-0.5 text-[10px] text-muted hover:border-accent/60 hover:text-foreground"
          >
            <Crosshair className="h-3 w-3" /> fit
          </button>
          <PanelButton
            onClick={onToggleCollapsed}
            label={collapsed ? 'Expand panel' : 'Collapse panel'}
            data-testid="legend-collapse"
          >
            {collapsed ? (
              <ChevronRight className="h-3.5 w-3.5" />
            ) : (
              <ChevronDown className="h-3.5 w-3.5" />
            )}
          </PanelButton>
        </div>
      </div>

      {collapsed ? null : (
        <>
          {/* ~30px taller than the phase F cap: on a project with a dozen kinds
              the list was cut mid-row, which reads as "that's all of them". */}
          <ul className="mt-2.5 flex max-h-[14rem] flex-col gap-0.5 overflow-auto">
            {entries.map((entry) => {
              const isOff = off.has(entry.key);
              return (
                <li key={entry.key}>
                  <button
                    type="button"
                    onClick={() => onToggleKey(entry.key)}
                    data-testid="legend-swatch"
                    data-off={isOff}
                    title={isOff ? `Show ${entry.label}` : `Hide ${entry.label}`}
                    className={cn(
                      'flex w-full items-center gap-2 rounded px-1 py-[2px] text-left text-[11px]',
                      isOff ? 'text-muted/40' : 'text-muted hover:bg-accent/10 hover:text-foreground'
                    )}
                  >
                    <span
                      className={cn('h-2.5 w-2.5 shrink-0 rounded-full', isOff && 'opacity-25')}
                      style={{ backgroundColor: entry.color }}
                    />
                    <span className={cn('truncate', isOff && 'line-through')}>{entry.label}</span>
                  </button>
                </li>
              );
            })}
            {entries.length === 0 ? (
              <li className="text-[11px] text-muted">nothing mounted</li>
            ) : null}
          </ul>

          {/* EDGES — one compact row, which is where the side-by-side
              incoming|outgoing treatment lives (round 4). */}
          <div className="mt-2.5 flex items-center gap-3 border-t border-border/60 pt-2">
            <span className="text-[9px] uppercase tracking-[0.18em] text-muted">edges</span>
            {EDGE_DIRECTION_LEGEND.map((entry) => (
              <span
                key={entry.key}
                className="flex items-center gap-1.5 text-[11px] text-muted"
                title={entry.meaning}
              >
                <span
                  className="h-2 w-2 shrink-0 rounded-full"
                  style={{ backgroundColor: entry.color }}
                />
                {entry.label}
              </span>
            ))}
          </div>
        </>
      )}
    </Card>
  );
}
