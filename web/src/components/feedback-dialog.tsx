/**
 * Feedback export — turn what is on screen into a message an agent can act on.
 *
 * The output is deliberately plain markdown with `path:startLine-endLine`
 * spans: that is the shape an agent can resolve without any codegraph-specific
 * knowledge, and the shape a human can read in a pull-request comment. It is
 * assembled entirely client-side from state the app already holds — the active
 * card (or the Changes view), the current canvas selection, and a free-text
 * note — so nothing is sent anywhere.
 */
import { useEffect, useMemo, useState } from 'react';
import { Check, Copy, Share2, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card as Surface } from '@/components/ui/card';

/** One node in the export — everything needed to cite it. */
export interface FeedbackNode {
  id: string;
  name: string;
  kind: string;
  file: string;
  startLine: number;
  endLine: number;
}

export interface FeedbackDialogProps {
  open: boolean;
  onClose(): void;
  /** What the user was looking at: a card question or a standing view name. */
  context: string;
  /** The active card's summary, if it has one. */
  summary?: string;
  /** Nodes the user selected on the canvas (may be empty). */
  selected: FeedbackNode[];
  /** Nodes the active card resolved to (the fallback when nothing is selected). */
  resultNodes: FeedbackNode[];
  projectName?: string;
}

/** Result nodes listed when the user hasn't selected anything specific. */
const MAX_RESULT_NODES = 40;

export function FeedbackDialog({
  open,
  onClose,
  context,
  summary,
  selected,
  resultNodes,
  projectName,
}: FeedbackDialogProps) {
  const [note, setNote] = useState('');
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (open) setCopied(false);
  }, [open]);

  const markdown = useMemo(
    () => buildFeedbackMarkdown({ context, summary, selected, resultNodes, note, projectName }),
    [context, summary, selected, resultNodes, note, projectName]
  );

  if (!open) return null;

  const copy = async (): Promise<void> => {
    const ok = await copyText(markdown);
    setCopied(ok);
  };

  return (
    <div
      className="pointer-events-auto fixed inset-0 z-50 flex items-start justify-center bg-background/50 pt-[12vh] backdrop-blur-[2px]"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <Surface className="flex w-[min(44rem,94vw)] flex-col p-5" data-testid="feedback-dialog">
        <div className="flex items-start justify-between gap-3">
          <h2 className="flex items-center gap-2 text-sm font-medium">
            <Share2 className="h-3.5 w-3.5 text-accent" /> Export feedback
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded p-1 text-muted hover:text-foreground"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        <label className="mt-4 flex flex-col gap-1">
          <span className="text-[11px] font-medium">Note</span>
          <textarea
            value={note}
            onChange={(event) => setNote(event.target.value)}
            rows={3}
            placeholder="What should be changed, and why?"
            data-testid="feedback-note"
            className="w-full resize-y rounded-md border border-border bg-background/60 px-2.5 py-1.5 text-xs outline-none placeholder:text-muted/70 focus:border-accent"
          />
          <span className="text-[10px] text-muted">
            {selected.length > 0
              ? `${selected.length} selected node${selected.length === 1 ? '' : 's'} included.`
              : `No selection — the active view's ${Math.min(resultNodes.length, MAX_RESULT_NODES)} node(s) are included.`}
          </span>
        </label>

        <pre
          data-testid="feedback-preview"
          className="mt-3 max-h-[38vh] overflow-auto rounded-md border border-border/70 bg-background/40 px-3 py-2 font-mono text-[10px] leading-relaxed text-foreground/85"
        >
          {markdown}
        </pre>

        <div className="mt-4 flex items-center justify-end gap-3">
          {copied ? (
            <span className="flex items-center gap-1 text-[11px] text-accent">
              <Check className="h-3 w-3" /> copied
            </span>
          ) : null}
          <Button size="sm" variant="outline" onClick={onClose}>
            Close
          </Button>
          <Button size="sm" onClick={() => void copy()} data-testid="feedback-copy">
            <Copy className="mr-1.5 h-3 w-3" /> Copy markdown
          </Button>
        </div>
      </Surface>
    </div>
  );
}

/**
 * Assemble the markdown. Exported so it can be reasoned about (and tested)
 * without a DOM: the format IS the feature.
 */
export function buildFeedbackMarkdown(input: {
  context: string;
  summary?: string;
  selected: FeedbackNode[];
  resultNodes: FeedbackNode[];
  note: string;
  projectName?: string;
}): string {
  const nodes =
    input.selected.length > 0 ? input.selected : input.resultNodes.slice(0, MAX_RESULT_NODES);
  const lines: string[] = [];

  lines.push(`## ${input.context}`);
  if (input.projectName) lines.push(`Project: \`${input.projectName}\``);
  if (input.summary) lines.push('', input.summary);

  lines.push('', '### Code');
  if (nodes.length === 0) {
    lines.push('- (no nodes selected)');
  } else {
    for (const node of nodes) {
      const span = node.startLine > 0 ? `:${node.startLine}-${node.endLine}` : '';
      lines.push(`- \`${node.file}${span}\` — ${node.name} (${node.kind.replace(/_/g, ' ')})`);
    }
  }

  lines.push('', '### Note', input.note.trim() || '(none)');
  return lines.join('\n') + '\n';
}

/** Clipboard write with a `document.execCommand` fallback for insecure origins. */
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the legacy path */
  }
  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(area);
    return ok;
  } catch {
    return false;
  }
}
