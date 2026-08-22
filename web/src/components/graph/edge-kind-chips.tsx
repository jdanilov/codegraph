/**
 * Edge-kind toggle chips.
 *
 * Contract: calls / imports / references / extends / instantiates are
 * toggleable; `contains` never is — it IS the backbone. `GraphModel` already
 * orders the kinds it found with the contract's five first, so any extra kind a
 * language emits (`implements`, `overrides`, …) appears after them rather than
 * being silently undrawable.
 */
import { cn } from '@/lib/utils';
import { colorForEdgeKind } from '@/graph/palette';

export interface EdgeKindChipsProps {
  kinds: string[];
  enabled: ReadonlySet<string>;
  onToggle(kind: string): void;
}

export function EdgeKindChips({ kinds, enabled, onToggle }: EdgeKindChipsProps) {
  if (kinds.length === 0) return null;
  return (
    <div className="pointer-events-auto flex flex-wrap items-center gap-1.5 rounded-lg border border-border bg-surface/70 p-2 shadow-sm backdrop-blur-md">
      <span className="px-1 text-[10px] uppercase tracking-[0.2em] text-muted">edges</span>
      {kinds.map((kind) => {
        const on = enabled.has(kind);
        return (
          <button
            key={kind}
            type="button"
            onClick={() => onToggle(kind)}
            className={cn(
              'flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[11px] transition-colors',
              on
                ? 'border-border bg-background/60 text-foreground'
                : 'border-border/50 text-muted/60 hover:text-muted'
            )}
          >
            <span
              className="h-1.5 w-1.5 rounded-full"
              style={{ backgroundColor: on ? colorForEdgeKind(kind) : 'transparent',
                       boxShadow: on ? 'none' : `inset 0 0 0 1px ${colorForEdgeKind(kind)}` }}
            />
            {kind}
          </button>
        );
      })}
    </div>
  );
}
