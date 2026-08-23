/**
 * Cmd/Ctrl+P — fuzzy jump to any node in the graph.
 *
 * The disk only draws the rings below the current root, so search is the ONLY
 * way to reach a symbol buried twelve directories deep. Picking a result
 * therefore doesn't just select: it re-roots the disk so the node's arc is on
 * screen and opens its info panel (`CanvasController.reveal`).
 *
 * Queries go to `GET /api/search` (FTS + a camel-infix sweep server-side), one
 * in flight at a time, with the previous request aborted — a fast typist would
 * otherwise race stale responses onto the list.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, Search } from 'lucide-react';

import { colorForKind } from '@/graph/palette';
import { searchNodes, type SearchHit } from '@/lib/api';
import { iconForNode } from '@/lib/file-icons';
import { cn } from '@/lib/utils';

/** Keystroke settle time before a query goes out. */
const DEBOUNCE_MS = 120;

export interface CommandPaletteProps {
  open: boolean;
  onClose(): void;
  onPick(id: string): void;
}

export function CommandPalette({ open, onClose, onPick }: CommandPaletteProps) {
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [active, setActive] = useState(0);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setHits([]);
    setActive(0);
    // Focus after the overlay paints, or the browser drops it.
    const timer = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const trimmed = query.trim();
    if (!trimmed) {
      setHits([]);
      setLoading(false);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    const timer = window.setTimeout(() => {
      void searchNodes(trimmed, controller.signal)
        .then((results) => {
          if (controller.signal.aborted) return;
          setHits(results);
          setActive(0);
        })
        .catch(() => undefined)
        .finally(() => {
          if (!controller.signal.aborted) setLoading(false);
        });
    }, DEBOUNCE_MS);
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [query, open]);

  // Keep the keyboard cursor inside the scroll viewport.
  useEffect(() => {
    const node = listRef.current?.querySelector<HTMLElement>('[data-active="true"]');
    node?.scrollIntoView({ block: 'nearest' });
  }, [active, hits]);

  const pick = useCallback(
    (hit: SearchHit | undefined) => {
      if (!hit) return;
      onPick(hit.id);
      onClose();
    },
    [onPick, onClose]
  );

  // Escape is NOT handled here (phase F). It used to be, and that was the bug:
  // this handler only fires while the DOM focus sits inside the dialog, so any
  // state where it didn't left ⌘P un-closable. The shell owns Escape on the
  // window now, with a documented priority (palette first).
  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'ArrowDown' || (event.key === 'n' && event.ctrlKey)) {
      event.preventDefault();
      setActive((index) => (hits.length === 0 ? 0 : (index + 1) % hits.length));
      return;
    }
    if (event.key === 'ArrowUp' || (event.key === 'p' && event.ctrlKey)) {
      event.preventDefault();
      setActive((index) => (hits.length === 0 ? 0 : (index - 1 + hits.length) % hits.length));
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      pick(hits[active]);
    }
  };

  if (!open) return null;

  return (
    <div
      className="pointer-events-auto fixed inset-0 z-50 flex items-start justify-center bg-background/50 pt-[12vh] backdrop-blur-[2px]"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-label="Search nodes"
        onKeyDown={onKeyDown}
        className="w-[min(38rem,92vw)] overflow-hidden rounded-lg border border-border bg-surface/95 shadow-2xl backdrop-blur-md"
      >
        <div className="flex items-center gap-2 border-b border-border px-3 py-2.5">
          <Search className="h-3.5 w-3.5 shrink-0 text-muted" />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Find a symbol, file or directory…"
            data-testid="palette-input"
            className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted/70"
          />
          {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin text-muted" /> : null}
          <kbd className="rounded border border-border px-1.5 py-0.5 text-[10px] text-muted">
            esc
          </kbd>
        </div>

        <div ref={listRef} className="max-h-[46vh] overflow-y-auto" data-testid="palette-results">
          {hits.length === 0 ? (
            <p className="px-3 py-6 text-center text-[11px] text-muted">
              {query.trim() ? 'No matches.' : 'Type to search the graph.'}
            </p>
          ) : (
            hits.map((hit, index) => {
              const Icon = iconForNode(hit.kind, hit.file);
              return (
                <button
                  key={hit.id}
                  type="button"
                  data-active={index === active}
                  data-testid="palette-hit"
                  onMouseEnter={() => setActive(index)}
                  onClick={() => pick(hit)}
                  className={cn(
                    'flex w-full items-center gap-2 px-3 py-1.5 text-left',
                    index === active ? 'bg-accent/15' : 'hover:bg-accent/8'
                  )}
                >
                  {/* The row's type at a glance — a `.png` and a `.ts` no
                      longer read as the same thing. The hover/active tint is
                      the only "you are here" affordance the row needs; the
                      trailing ↵ arrow it used to grow was noise. */}
                  <Icon
                    className="h-3.5 w-3.5 shrink-0"
                    style={{ color: colorForKind(hit.kind) }}
                  />
                  <span className="shrink-0 font-mono text-xs text-foreground">{hit.name}</span>
                  <span className="min-w-0 flex-1 truncate text-[10px] text-muted" title={hit.file}>
                    {hit.file}
                  </span>
                  <span className="shrink-0 text-[10px] text-muted/70">
                    {hit.kind.replace(/_/g, ' ')}
                  </span>
                </button>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
