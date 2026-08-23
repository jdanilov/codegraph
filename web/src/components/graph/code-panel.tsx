/**
 * The CODE panel — the selected node's source (or its diff), on its own.
 *
 * Phase F pulled the code out of the node panel and gave it a panel of its own,
 * directly below it. The reason is width: code is the one thing in this UI that
 * cannot be wrapped or truncated without becoming unreadable, and inside the
 * node panel it was competing with label columns, relation lists and a
 * line-number gutter for the same 27rem. Here it gets the panel's whole width
 * at minimal padding, and it collapses independently of the node panel — so a
 * developer walking relations can fold the code away, and one reading code can
 * fold the metadata away, without either of them losing the selection.
 *
 * The title bar carries what the body used to repeat: the line range and the
 * source/changes toggle.
 */
import { useState } from 'react';
import { Code2, GitCompare } from 'lucide-react';

import { SourceBody, type SourceMode } from './source-view';
import { PanelButton, SidePanel } from './side-panel';
import type { ModelNode } from '@/graph/model';
import type { NodeDetail } from '@/lib/api';

export interface CodePanelProps {
  node: ModelNode;
  /** `/api/node/:id`, which already carries the span's source. */
  detail: NodeDetail | null;
  loading: boolean;
  /** Which mode to open in — "changes" when the Changes view is active. */
  initialMode?: SourceMode;
  collapsed: boolean;
  onToggleCollapsed(): void;
}

export function CodePanel({
  node,
  detail,
  loading,
  initialMode,
  collapsed,
  onToggleCollapsed,
}: CodePanelProps) {
  const [mode, setMode] = useState<SourceMode>(initialMode ?? 'full');

  const file = detail?.node.file || node.file;
  const startLine = detail?.node.startLine || node.startLine || 1;
  const endLine = detail?.node.endLine || node.endLine || startLine;

  return (
    <SidePanel
      data-testid="code-panel"
      title="code"
      meta={`${startLine}–${endLine}`}
      collapsed={collapsed}
      onToggleCollapsed={onToggleCollapsed}
      className={collapsed ? 'shrink-0' : 'min-h-[6rem] flex-1'}
      bodyClassName="bg-background/40"
      actions={
        <>
          <PanelButton
            label="Source"
            active={mode === 'full'}
            onClick={() => setMode('full')}
            data-testid="code-mode-source"
          >
            <Code2 className="h-3.5 w-3.5" />
          </PanelButton>
          <PanelButton
            label="Changes vs HEAD"
            active={mode === 'diff'}
            onClick={() => setMode('diff')}
            data-testid="code-mode-diff"
          >
            <GitCompare className="h-3.5 w-3.5" />
          </PanelButton>
        </>
      }
    >
      {detail ? (
        <SourceBody
          key={`${detail.node.id}|${mode}`}
          file={file}
          startLine={startLine}
          endLine={endLine}
          mode={mode}
          initial={mode === 'full' ? detail.source : null}
        />
      ) : (
        <p className="px-2 py-3 text-[11px] text-muted">
          {loading ? 'loading…' : 'No source for this entry.'}
        </p>
      )}
    </SidePanel>
  );
}
