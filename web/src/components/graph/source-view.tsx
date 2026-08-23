/**
 * The BODY of the code panel — source or diff, no chrome of its own.
 *
 * Two modes, driven by the panel's title-bar toggle (phase F moved the switch
 * up there, along with the file name and the line range, so the code itself
 * gets the panel's full width):
 *
 *  - **source** — the node's full span (`GET /api/source?mode=full`, or the
 *    `source` block the node payload already carried, so opening a panel costs
 *    zero extra requests). Highlighted as one block, which is what keeps a
 *    multi-line string or block comment coloured correctly.
 *  - **changes** — only the hunks of that span versus `HEAD`
 *    (`GET /api/source?mode=diff`). Highlighted per LINE here on purpose: a
 *    hunk interleaves the old and new sides, so there is no single coherent
 *    text to tokenize. Multi-line constructs degrade to plain text, everything
 *    on one line still colours.
 *
 * **No line-number gutter** (phase F). It cost 3–4 characters of every line for
 * a number nobody was reading: the span's range is in the panel title, and a
 * hunk's `@@` header already carries its own. The width goes to the code.
 */
import { useEffect, useMemo, useState } from 'react';
import { Loader2 } from 'lucide-react';

import { fetchSource, fetchSourceDiff, type SourceDiff, type SourceSpan } from '@/lib/api';
import { escapeHtml, highlightWith, loadHighlighter } from '@/lib/highlight';
import { cn } from '@/lib/utils';

type Engine = Awaited<ReturnType<typeof loadHighlighter>>;

export type SourceMode = 'full' | 'diff';

export interface SourceBodyProps {
  file: string;
  startLine: number;
  endLine: number;
  /** Controlled by the code panel's title-bar toggle. */
  mode: SourceMode;
  /**
   * Wrap long lines instead of scrolling them horizontally — the other
   * title-bar toggle, off by default and remembered per browser. It applies to
   * BOTH views: a diff's lines wrap exactly like the source's, so switching
   * between them never changes how the same line reads.
   */
  wrap?: boolean;
  /** The span the node payload already shipped, if any. */
  initial?: SourceSpan | null;
}

/** Load the highlighter once per mount and re-render when it lands. */
function useHighlighter(): Engine {
  const [engine, setEngine] = useState<Engine>(null);
  useEffect(() => {
    let live = true;
    void loadHighlighter().then((loaded) => {
      if (live) setEngine(loaded);
    });
    return () => {
      live = false;
    };
  }, []);
  return engine;
}

export function SourceBody({
  file,
  startLine,
  endLine,
  mode,
  wrap = false,
  initial,
}: SourceBodyProps) {
  // Seeded from the node payload's own span — opening a panel costs no extra
  // request. The caller remounts this component per node (`key`), so there is
  // deliberately no "reset on prop change" effect to race the in-flight fetch.
  const [span, setSpan] = useState<SourceSpan | null>(initial ?? null);
  const [diff, setDiff] = useState<SourceDiff | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const engine = useHighlighter();

  useEffect(() => {
    // Already have this mode's payload. `setLoading(false)` is not redundant:
    // the previous run's `finally` is skipped once its controller aborts, and
    // without this the pane would sit on "loading…" forever after a request
    // that resolved and aborted in the same tick.
    if (mode === 'full' ? span : diff) {
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    const request =
      mode === 'full'
        ? fetchSource(file, startLine, endLine, controller.signal).then(setSpan)
        : fetchSourceDiff(file, startLine, endLine, controller.signal).then(setDiff);
    void request
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [mode, file, startLine, endLine, span, diff]);

  if (loading) {
    return (
      <p className="flex items-center gap-2 px-2 py-3 text-[11px] text-muted">
        <Loader2 className="h-3 w-3 animate-spin" /> loading…
      </p>
    );
  }
  if (error) return <p className="px-2 py-3 text-[11px] text-red-400">{error}</p>;
  return mode === 'full' ? (
    <FullSource span={span} file={file} engine={engine} wrap={wrap} />
  ) : (
    <DiffSource diff={diff} file={file} engine={engine} wrap={wrap} />
  );
}

function FullSource({
  span,
  file,
  engine,
  wrap,
}: {
  span: SourceSpan | null;
  file: string;
  engine: Engine;
  wrap: boolean;
}) {
  const html = useMemo(
    () => (span ? (highlightWith(engine, span.content, file) ?? escapeHtml(span.content)) : ''),
    [span, file, engine]
  );
  if (!span) return <p className="px-2 py-3 text-[11px] text-muted">No source available.</p>;

  return (
    <>
      <pre
        className={cn(
          'px-2 py-1.5 font-mono text-[11px] leading-[1.55]',
          wrap && 'whitespace-pre-wrap break-words'
        )}
      >
        <code className="hljs-code" dangerouslySetInnerHTML={{ __html: html }} />
      </pre>
      {span.truncated ? (
        <p className="px-2 pb-1.5 text-[10px] text-accent">truncated</p>
      ) : null}
    </>
  );
}

function DiffSource({
  diff,
  file,
  engine,
  wrap,
}: {
  diff: SourceDiff | null;
  file: string;
  engine: Engine;
  wrap: boolean;
}) {
  if (!diff) return <p className="px-2 py-3 text-[11px] text-muted">No diff available.</p>;

  if (!diff.git) {
    return (
      <p className="px-2 py-3 text-[11px] text-muted">
        Not a git work tree — there is nothing to compare against.
      </p>
    );
  }
  if (diff.binary) {
    return <p className="px-2 py-3 text-[11px] text-muted">Binary file.</p>;
  }
  if (diff.hunks.length === 0) {
    return (
      <p className="px-2 py-3 text-[11px] text-muted">
        No uncommitted changes in these lines
        {diff.hunksOutsideSpan > 0 ? ` (${diff.hunksOutsideSpan} elsewhere in the file)` : ''}.
      </p>
    );
  }

  return (
    <div className="text-[11px] leading-[1.55]">
      <div className="flex items-center gap-2 px-2 pt-1.5 text-[10px] uppercase tracking-[0.18em] text-muted">
        {diff.status} vs HEAD
        {diff.hunksOutsideSpan > 0 ? (
          <span className="normal-case tracking-normal">
            · {diff.hunksOutsideSpan} more hunk(s) outside this span
          </span>
        ) : null}
      </div>
      {diff.hunks.map((hunk, index) => (
        <div key={index} className="mt-1.5 border-t border-border/50 first:border-t-0">
          <div className="bg-accent/10 px-2 py-0.5 font-mono text-[10px] text-accent">
            @@ -{hunk.oldStart},{hunk.oldLines} +{hunk.newStart},{hunk.newLines} @@
            {hunk.heading ? ` ${hunk.heading}` : ''}
          </div>
          {renderHunkLines(hunk, file, engine, wrap)}
        </div>
      ))}
    </div>
  );
}

function renderHunkLines(
  hunk: SourceDiff['hunks'][number],
  file: string,
  engine: Engine,
  wrap: boolean
): React.ReactNode {
  return hunk.lines.map((line, index) => {
    const html = highlightWith(engine, line.text, file) ?? escapeHtml(line.text);
    return (
      <div
        key={index}
        className={cn(
          'flex font-mono',
          // Unwrapped, the row is as wide as its longest line (never narrower
          // than the panel), so the add/del tint covers the whole line when the
          // pane is scrolled sideways instead of stopping at the fold.
          wrap ? '' : 'w-max min-w-full',
          line.type === 'add' && 'bg-emerald-500/12',
          line.type === 'del' && 'bg-rose-500/12'
        )}
      >
        <span
          className={cn(
            'w-3 shrink-0 select-none text-center',
            line.type === 'add' && 'text-emerald-400',
            line.type === 'del' && 'text-rose-400',
            line.type === 'ctx' && 'text-muted/40'
          )}
        >
          {line.type === 'add' ? '+' : line.type === 'del' ? '−' : ' '}
        </span>
        <span
          className={cn(
            'hljs-code flex-1 pr-2',
            wrap ? 'min-w-0 whitespace-pre-wrap break-words' : 'whitespace-pre'
          )}
          dangerouslySetInnerHTML={{ __html: html || '&nbsp;' }}
        />
      </div>
    );
  });
}
