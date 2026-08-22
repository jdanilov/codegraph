/**
 * Minimal selection readout.
 *
 * PHASE C MOUNT POINT — this is the stub the contract asks phase B to leave
 * behind: name / kind / file only. Phase C replaces the body with the real info
 * panel (`GET /api/node/:id`: contained nodes, in/out edges, source, editor
 * jump) by passing `renderDetail` to `<GraphCanvas>`; the selection lifecycle,
 * positioning and dismissal below stay as they are.
 */
import { X } from 'lucide-react';
import type { ReactNode } from 'react';

import { Card } from '@/components/ui/card';
import { DIRECTORY_KIND, type ModelNode } from '@/graph/model';
import { colorForKind } from '@/graph/palette';

export interface SelectionCardProps {
  node: ModelNode;
  onClose(): void;
  /** Phase C: richer body rendered in place of the stub fields. */
  children?: ReactNode;
}

export function SelectionCard({ node, onClose, children }: SelectionCardProps) {
  const isDirectory = node.kind === DIRECTORY_KIND;
  return (
    <Card className="pointer-events-auto w-80 p-4">
      <div className="flex items-start justify-between gap-3">
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

      {children ?? (
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

      <p className="mt-3 text-[10px] leading-relaxed text-muted">
        Shift+click a node to expand or collapse it. Drag to pin, wobble to release.
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
