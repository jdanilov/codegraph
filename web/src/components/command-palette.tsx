/**
 * Cmd/Ctrl+P — fuzzy jump to any node in the graph.
 *
 * The disk only draws the rings below the current root, so search is the ONLY
 * way to reach a symbol buried twelve directories deep. Picking a result
 * therefore doesn't just select: it jumps the canvas to the node's wedge, or
 * drills a disk down to it when nothing is showing it yet
 * (`CanvasController.reveal`).
 *
 * Queries go to `GET /api/search` (FTS + a camel-infix sweep server-side), one
 * in flight at a time, with the previous request aborted — a fast typist would
 * otherwise race stale responses onto the list.
 *
 * **The list is filtered to NAME matches** (round G5.2). The server's index
 * covers a node's qualified name and its file path too, which is right for the
 * `codegraph_explore` tool it also feeds and wrong here: typing `canvas` in a
 * project with a `canvas/` directory returned every symbol in that directory,
 * dozens of rows deep, and the thing actually called `canvas` was somewhere in
 * the middle of it. A palette is a name picker, so the haystack is the name —
 * the server's own matching flavour is kept (case-insensitive, substring, so a
 * camel infix like `profileInfo` still reaches `getProfileInfoV2`), just
 * applied to `hit.name` and nothing else. Results are then ordered by name
 * rather than by relevance, because a list you scan for a name you already know
 * is easier to scan alphabetically than by a score you cannot see.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, Search } from 'lucide-react';

import type { GraphModel } from '@/graph/model';
import { colorForKind } from '@/graph/palette';
import { sizesOf } from '@/graph/sunburst';
import { searchNodes, type SearchHit } from '@/lib/api';
import { iconForNode } from '@/lib/file-icons';
import { cn, formatNumber } from '@/lib/utils';

/** Keystroke settle time before a query goes out. */
const DEBOUNCE_MS = 120;

/**
 * Does this node's NAME match the query?
 *
 * Every whitespace-separated word of the query has to appear somewhere in the
 * name, case-insensitively — which is the single-word substring test in the
 * common case, and lets a multi-word query ("scroll bottom") reach the
 * identifier that contains both (`scrollFeedToBottom`) without matching on
 * anything outside the name. A path fragment therefore matches nothing: that is
 * the whole point.
 */
export function nameMatches(name: string, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const haystack = name.toLowerCase();
  return words.every((word) => haystack.includes(word));
}

/** Case-insensitive by name; equal names keep the server's order (stable sort). */
export function byNameThenStable(a: SearchHit, b: SearchHit): number {
  return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
}

export interface CommandPaletteProps {
  open: boolean;
  /** Where a row's LoC comes from — the same weights the disk is drawn from. */
  model: GraphModel | null;
  onClose(): void;
  onPick(id: string): void;
}

export function CommandPalette({ open, model, onClose, onPick }: CommandPaletteProps) {
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

  /** LoC per node id — the aggregate the centre circle's `N loc` also reads. */
  const sizes = useMemo(() => (model ? sizesOf(model) : null), [model]);

  /** What the list actually shows: name matches only, in name order. */
  const shown = useMemo(() => {
    const trimmed = query.trim();
    if (!trimmed) return [];
    return hits.filter((hit) => nameMatches(hit.name, trimmed)).sort(byNameThenStable);
  }, [hits, query]);

  // Typing narrows the list under the cursor, so the cursor comes back to the
  // top rather than pointing past the end of it.
  useEffect(() => {
    setActive((index) => (index < shown.length ? index : 0));
  }, [shown.length]);

  // Keep the keyboard cursor inside the scroll viewport.
  useEffect(() => {
    const node = listRef.current?.querySelector<HTMLElement>('[data-active="true"]');
    node?.scrollIntoView({ block: 'nearest' });
  }, [active, shown]);

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
      setActive((index) => (shown.length === 0 ? 0 : (index + 1) % shown.length));
      return;
    }
    if (event.key === 'ArrowUp' || (event.key === 'p' && event.ctrlKey)) {
      event.preventDefault();
      setActive((index) => (shown.length === 0 ? 0 : (index - 1 + shown.length) % shown.length));
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      pick(shown[active]);
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
          {shown.length === 0 ? (
            <p className="px-3 py-6 text-center text-[11px] text-muted">
              {query.trim() ? 'No matches.' : 'Type to search the graph.'}
            </p>
          ) : (
            shown.map((hit, index) => {
              const Icon = iconForNode(hit.kind, hit.file);
              const loc = sizes?.get(hit.id) ?? 0;
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
                  {/* How big the thing is, beside what it is — the two numbers
                      the centre circle already pairs. Absent rather than "0"
                      for a node the model doesn't weigh. */}
                  {loc > 0 ? (
                    <span className="shrink-0 tabular-nums text-[10px] text-muted/70">
                      {formatNumber(loc)} loc
                    </span>
                  ) : null}
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
