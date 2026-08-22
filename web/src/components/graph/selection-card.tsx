/**
 * Minimal selection readout.
 *
 * Phase B left this as a stub (name / kind / file); phase C filled the body with
 * the real info panel (`GET /api/node/:id`: contained nodes, in/out edges,
 * source, editor jump) through `renderDetail` on `<GraphCanvas>`. The selection
 * lifecycle, positioning and dismissal are unchanged — only the frame grew: a
 * card carrying a body gets more width and a bounded, scrollable height, since
 * a source view inside 20rem would be unreadable.
 */
import { X } from 'lucide-react';
import type { ReactNode } from 'react';

import { Card } from '@/components/ui/card';
import { DIRECTORY_KIND, type ModelNode } from '@/graph/model';
import { colorForKind } from '@/graph/palette';
import { cn } from '@/lib/utils';

export interface SelectionCardProps {
  node: ModelNode;
  onClose(): void;
  /** Phase C: richer body rendered in place of the stub fields. */
  children?: ReactNode;
}

export function SelectionCard({ node, onClose, children }: SelectionCardProps) {
  const isDirectory = node.kind === DIRECTORY_KIND;
  return (
    <Card
      className={cn(
        'pointer-events-auto flex flex-col p-4',
        children ? 'max-h-[calc(100vh-10rem)] w-[27rem]' : 'w-80'
      )}
    >
      <div className="flex shrink-0 items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span
              className="h-2.5 w-2.5 shrink-0 rounded-full"
              style={{ backgroundColor: colorForKind(node.kind) }}
            />
            <span className="text-[10px] uppercase tracking-[0.2em] text-muted">
              {node.kind.replace(/_/g, ' ')}
            </span>
          </div>
          <h2 className="mt-1 truncate text-sm font-medium" title={node.qualifiedName || node.name}>
            {node.name}
          </h2>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded p-1 text-muted transition-colors hover:text-foreground"
          aria-label="Close"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {children ? (
        <div className="min-h-0 flex-1 overflow-y-auto pr-0.5">{children}</div>
      ) : (
        <dl className="mt-3 flex flex-col gap-1.5 text-[11px]">
          <Row label={isDirectory ? 'path' : 'file'} value={node.file || '(project root)'} />
          {!isDirectory ? (
            <Row label="lines" value={`${node.startLine}–${node.endLine}`} />
          ) : null}
          {node.layer ? <Row label="layer" value={node.layer} /> : null}
          <Row label={isDirectory ? 'loc' : 'span'} value={String(node.weight)} />
          <Row label="children" value={String(node.children.length)} />
        </dl>
      )}

      <p className="mt-3 shrink-0 text-[10px] leading-relaxed text-muted">
        Click a directory arc to open it, double-click a file to see its symbols, and use the centre
        circle or the breadcrumb to come back up.
      </p>
    </Card>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-2">
      <dt className="w-14 shrink-0 text-muted">{label}</dt>
      <dd className="min-w-0 flex-1 truncate font-mono text-foreground/90" title={value}>
        {value}
      </dd>
    </div>
  );
}
