/**
 * Hover readout for a sunburst arc.
 *
 * The disk encodes size as ANGLE, which is readable in the large and vague in
 * the small — so the tooltip carries the exact number (LoC for a directory or
 * file, span length for a symbol) plus what the arc is and, when it is a
 * `+N` fold arc, how to reach what it folded away.
 */
import { Layers3 } from 'lucide-react';

import type { ArcTooltip as ArcTooltipData } from '@/graph/canvas-controller';
import { colorForKind } from '@/graph/palette';
import { formatNumber } from '@/lib/utils';

export function ArcTooltip({ tooltip }: { tooltip: ArcTooltipData }) {
  return (
    <div
      className="pointer-events-none absolute z-30 max-w-xs -translate-y-1/2 translate-x-3 rounded-md border border-border bg-surface/95 px-3 py-2 text-[11px] shadow-lg backdrop-blur-md"
      style={{ left: tooltip.x, top: tooltip.y }}
    >
      <div className="flex items-center gap-1.5">
        <span
          className="h-1.5 w-1.5 rounded-full"
          style={{ backgroundColor: colorForKind(tooltip.kind) }}
        />
        <span className="truncate font-medium text-foreground">{tooltip.name}</span>
      </div>
      <p className="mt-1 flex items-center gap-2 text-[10px] uppercase tracking-[0.18em] text-muted">
        <span>{tooltip.kind.replace(/_/g, ' ')}</span>
        {tooltip.layer ? <span className="text-accent">{tooltip.layer}</span> : null}
      </p>
      {tooltip.path ? (
        <p className="mt-1 truncate font-mono text-[10px] text-muted" title={tooltip.path}>
          {tooltip.path}
        </p>
      ) : null}
      <p className="mt-1 text-[10px] text-muted">
        {formatNumber(tooltip.loc)} {tooltip.aggregate ? 'loc folded away' : 'loc'}
        {tooltip.hiddenChildren > 0 && !tooltip.aggregate
          ? ` · ${formatNumber(tooltip.hiddenChildren)} hidden`
          : ''}
      </p>
      {tooltip.aggregate ? (
        <p className="mt-1.5 flex items-start gap-1.5 text-[10px] leading-relaxed text-muted">
          <Layers3 className="mt-0.5 h-3 w-3 shrink-0" />
          Click to open its parent, or find an entry directly with ⌘P.
        </p>
      ) : null}
    </div>
  );
}
