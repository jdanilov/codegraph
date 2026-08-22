/**
 * Hover tooltip for a relation edge.
 *
 * The reason this exists is provenance: a dashed edge was *synthesized* by a
 * dynamic-dispatch bridge rather than read out of the AST, and the only honest
 * way to render that is to name the synthesizer and the wiring site
 * (`synthesizedBy` + `registeredAt`) so the developer can go look.
 */
import { Sparkles } from 'lucide-react';

import type { EdgeTooltip as EdgeTooltipData } from '@/graph/canvas-controller';
import { colorForEdgeKind } from '@/graph/palette';

export function EdgeTooltip({ tooltip }: { tooltip: EdgeTooltipData }) {
  return (
    <div
      className="pointer-events-none absolute z-30 max-w-xs -translate-y-1/2 translate-x-3 rounded-md border border-border bg-surface/95 px-3 py-2 text-[11px] shadow-lg backdrop-blur-md"
      style={{ left: tooltip.x, top: tooltip.y }}
    >
      <div className="flex items-center gap-1.5">
        <span
          className="h-1.5 w-1.5 rounded-full"
          style={{ backgroundColor: colorForEdgeKind(tooltip.kind) }}
        />
        <span className="font-mono text-foreground">{tooltip.kind}</span>
        {tooltip.heuristic ? (
          <span className="flex items-center gap-1 text-accent">
            <Sparkles className="h-3 w-3" /> synthesized
          </span>
        ) : null}
      </div>
      <p className="mt-1 truncate font-mono text-muted">
        {tooltip.sourceName} → {tooltip.targetName}
        {tooltip.line !== undefined ? `:${tooltip.line}` : ''}
      </p>
      {tooltip.heuristic ? (
        <dl className="mt-1.5 flex flex-col gap-0.5 text-[10px] text-muted">
          {tooltip.synthesizedBy ? (
            <div className="flex gap-1.5">
              <dt className="w-16 shrink-0">by</dt>
              <dd className="font-mono text-foreground/80">{tooltip.synthesizedBy}</dd>
            </div>
          ) : null}
          {tooltip.registeredAt ? (
            <div className="flex gap-1.5">
              <dt className="w-16 shrink-0">wired at</dt>
              <dd className="truncate font-mono text-foreground/80">{tooltip.registeredAt}</dd>
            </div>
          ) : null}
        </dl>
      ) : null}
    </div>
  );
}
