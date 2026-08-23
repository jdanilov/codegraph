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
 * The title bar carries what the body used to repeat: the line range, the
 * source/changes toggle and the WRAP toggle. Wrapping is opt-in (and off by
 * default) rather than a layout decision taken for the reader: most code is
 * read in its own columns, but one over-long line should not have to be
 * scrolled to — and when it does wrap, source and diff wrap the same way.
 * The column's width itself is draggable, so the panel is no longer stuck at
 * whatever width the shell chose.
 */
import { useState } from 'react';
import { Code2, GitCompare, WrapText } from 'lucide-react';

import { SourceBody, type SourceMode } from './source-view';
import { PanelButton, SidePanel } from './side-panel';
import type { ModelNode } from '@/graph/model';
import type { NodeDetail } from '@/lib/api';
import { useStoredState } from '@/lib/prefs';

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
  // Wrapping is OFF by default: code is the one thing here that means something
  // structurally in its columns, and a wrapped line is a line whose indentation
  // lies. It is a per-person reading preference, so it survives the session
  // (and the panel remounting on every selection) in `localStorage`.
  const [wrap, setWrap] = useStoredState('codeWrap', false);

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
            label={wrap ? 'Stop wrapping long lines' : 'Wrap long lines'}
            active={wrap}
            onClick={() => setWrap(!wrap)}
            data-testid="code-wrap"
          >
            <WrapText className="h-3.5 w-3.5" />
          </PanelButton>
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
          wrap={wrap}
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
