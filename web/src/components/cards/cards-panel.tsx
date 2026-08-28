/**
 * The cards panel — the question surface of the visualizer.
 *
 * Two kinds of entry live in one list, in a deliberate order:
 *
 *  1. **Project** — the whole graph from its root, always first;
 *  2. saved **question cards**, newest first.
 *
 * There used to be a third — a standing **Changes** view that lit up
 * everything uncommitted. It is gone (round B4): what a reader wanted from it
 * was not a place to go but an overlay to have on, so it became a toggle in the
 * legend panel's header and the change annotation is now drawn on whatever view
 * you are already in.
 *
 * The ask box has a floor and a ceiling (contract): pressing Enter always runs
 * the deterministic explore — it needs no key and always answers — and, when an
 * API key is configured, the card additionally offers "refine with AI", which
 * lets the model rewrite the question into symbol names and re-runs the same
 * explore. The instant answer is never withheld waiting for the model.
 */
import { useState } from 'react';
import {
  Braces,
  ChevronDown,
  ChevronRight,
  Files,
  FolderTree,
  Loader2,
  MessageSquare,
  Send,
  Sparkles,
  Share2,
  Trash2,
} from 'lucide-react';

import { PanelButton } from '@/components/graph/side-panel';
import { Card as Surface } from '@/components/ui/card';
import { DIRECTORY_KIND, type GraphModel } from '@/graph/model';
import { colorForKind } from '@/graph/palette';
import type { Card, ExploreResult } from '@/lib/api';
import { iconForNode } from '@/lib/file-icons';
import { distinctFiles, qualifiedLabel } from '@/lib/qualify';
import { cn } from '@/lib/utils';

/** Id of the standing view. Client-side, and never persisted. */
export const PROJECT_VIEW_ID = 'view:project';

/** Rows shown before a list collapses behind "+N more". */
const LIST_PREVIEW = 8;

export interface CardsPanelProps {
  cards: Card[];
  activeId: string;
  model: GraphModel | null;
  /** True while a question is being answered. */
  busy: boolean;
  /** True when an API key is configured — gates the "refine with AI" action. */
  askAvailable: boolean;
  error: string | null;
  onActivate(id: string): void;
  onAsk(question: string): void;
  onRefine(card: Card): void;
  onDelete(id: string): void;
  onNavigate(id: string): void;
  onExport(): void;
  /** Folded to its title bar — same affordance as every other panel (round 2). */
  collapsed: boolean;
  onToggleCollapsed(): void;
}

export function CardsPanel({
  cards,
  activeId,
  model,
  busy,
  askAvailable,
  error,
  onActivate,
  onAsk,
  onRefine,
  onDelete,
  onNavigate,
  onExport,
  collapsed,
  onToggleCollapsed,
}: CardsPanelProps) {
  const [question, setQuestion] = useState('');
  const activeCard = cards.find((card) => card.id === activeId) ?? null;

  const submit = (): void => {
    const trimmed = question.trim();
    if (!trimmed || busy) return;
    setQuestion('');
    onAsk(trimmed);
  };

  // Folded: the title bar and nothing else, and — the point of folding — the
  // column's height goes back to the legend under it.
  if (collapsed) {
    return (
      <Surface className="pointer-events-auto flex shrink-0 flex-col p-3" data-testid="cards-panel">
        <PanelHeader collapsed onToggleCollapsed={onToggleCollapsed} />
      </Surface>
    );
  }

  // Sized by the column, not by the viewport (phase F): the legend now sits
  // under this panel, so a fixed `max-h` against `100vh` could push it off the
  // bottom of a short window. `flex-1 min-h-0` lets it give room back.
  return (
    <Surface
      className="pointer-events-auto flex min-h-0 flex-1 flex-col p-3"
      data-testid="cards-panel"
    >
      <PanelHeader collapsed={false} onToggleCollapsed={onToggleCollapsed} />

      <div className="mt-2 flex shrink-0 items-center gap-1.5">
        <input
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              submit();
            }
          }}
          placeholder="Ask about this codebase…"
          data-testid="ask-input"
          spellCheck={false}
          className="min-w-0 flex-1 rounded-md border border-border bg-background/60 px-2.5 py-1.5 text-[11px] outline-none placeholder:text-muted/70 focus:border-accent"
        />
        <button
          type="button"
          onClick={submit}
          disabled={busy || question.trim().length === 0}
          aria-label="Ask"
          data-testid="ask-submit"
          className="rounded-md border border-border p-1.5 text-muted hover:border-accent/60 hover:text-accent disabled:opacity-40"
        >
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}
        </button>
      </div>
      {error ? <p className="mt-1.5 shrink-0 text-[10px] text-red-400">{error}</p> : null}

      <div className="mt-2 min-h-0 flex-1 overflow-y-auto pr-0.5">
        <div className="flex flex-col gap-0.5">
          <StandingRow
            id={PROJECT_VIEW_ID}
            label="Project"
            hint="everything"
            active={activeId === PROJECT_VIEW_ID}
            onClick={() => onActivate(PROJECT_VIEW_ID)}
          >
            <FolderTree className="h-3 w-3" />
          </StandingRow>

          {cards.map((card) => (
            <QuestionRow
              key={card.id}
              card={card}
              model={model}
              active={card.id === activeId}
              onClick={() => onActivate(card.id)}
              onDelete={() => onDelete(card.id)}
            />
          ))}
        </div>

        {activeCard ? (
          <div className="mt-2 border-t border-border/60 pt-2">
            <ResultBody
              result={activeCard.result}
              model={model}
              onNavigate={onNavigate}
              onRefine={askAvailable && !busy ? () => onRefine(activeCard) : null}
            />
          </div>
        ) : null}
      </div>

      <button
        type="button"
        onClick={onExport}
        data-testid="open-feedback"
        className="mt-2 flex shrink-0 items-center justify-center gap-1.5 rounded-md border border-border/70 py-1 text-[10px] text-muted hover:border-accent/60 hover:text-accent"
      >
        <Share2 className="h-3 w-3" /> export feedback
      </button>
    </Surface>
  );
}

/** Title bar — the panel's name and the collapse toggle, nothing else. */
function PanelHeader({
  collapsed,
  onToggleCollapsed,
}: {
  collapsed: boolean;
  onToggleCollapsed(): void;
}) {
  return (
    <div className="flex shrink-0 items-center gap-2 text-[10px] uppercase tracking-[0.2em] text-muted">
      <MessageSquare className="h-3 w-3" />
      <span className="flex-1">questions</span>
      <PanelButton
        onClick={onToggleCollapsed}
        label={collapsed ? 'Expand panel' : 'Collapse panel'}
        data-testid="cards-collapse"
      >
        {collapsed ? (
          <ChevronRight className="h-3.5 w-3.5" />
        ) : (
          <ChevronDown className="h-3.5 w-3.5" />
        )}
      </PanelButton>
    </div>
  );
}

function StandingRow({
  id,
  label,
  hint,
  active,
  onClick,
  children,
}: {
  id: string;
  label: string;
  hint: string;
  active: boolean;
  onClick(): void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={`card-row-${id}`}
      data-active={active}
      className={cn(
        'flex w-full items-center gap-2 rounded px-1.5 py-1 text-left',
        active ? 'bg-accent/15 text-accent' : 'text-foreground/85 hover:bg-accent/10'
      )}
    >
      {children}
      <span className="flex-1 truncate text-[11px] font-medium">{label}</span>
      <span className="shrink-0 truncate text-[9px] text-muted">{hint}</span>
    </button>
  );
}

/**
 * One saved question.
 *
 * The counts are the card's whole answer in two numbers — how many symbols, in
 * how many files — and they are drawn with icons rather than the letters `s`
 * and `f`, which read as units of something. On hover they give their place to
 * the delete button: a row this narrow cannot afford both, and a delete control
 * that is always visible on every card invites the accident it enables.
 */
function QuestionRow({
  card,
  model,
  active,
  onClick,
  onDelete,
}: {
  card: Card;
  model: GraphModel | null;
  active: boolean;
  onClick(): void;
  onDelete(): void;
}) {
  const counts = resultCounts(card.result, model);
  return (
    <div
      className={cn(
        'group flex items-center gap-1 rounded pr-1',
        active ? 'bg-accent/15' : 'hover:bg-accent/10'
      )}
    >
      <button
        type="button"
        onClick={onClick}
        title={card.question}
        data-testid="card-row"
        data-active={active}
        className="flex min-w-0 flex-1 items-center gap-2 px-1.5 py-1 text-left"
      >
        <MessageSquare className={cn('h-3 w-3 shrink-0', active ? 'text-accent' : 'text-muted')} />
        <span className={cn('flex-1 truncate text-[11px]', active && 'text-accent')}>
          {card.question}
        </span>
      </button>
      <span
        className="flex shrink-0 items-center gap-1.5 pr-1 text-[9px] text-muted group-hover:hidden"
        title={`${counts.symbols} symbol(s) across ${counts.files} file(s)`}
        data-testid="card-counts"
      >
        <span className="flex items-center gap-0.5">
          <Braces className="h-2.5 w-2.5" />
          {counts.symbols}
        </span>
        <span className="flex items-center gap-0.5">
          <Files className="h-2.5 w-2.5" />
          {counts.files}
        </span>
      </span>
      <button
        type="button"
        onClick={onDelete}
        aria-label="Delete card"
        className="hidden shrink-0 rounded p-1 text-muted hover:text-red-400 group-hover:block"
      >
        <Trash2 className="h-3 w-3" />
      </button>
    </div>
  );
}

/**
 * The counts a card advertises — and the same two numbers the answer's own
 * summary sentence quotes.
 *
 * They used to disagree (99 rows in the list under "Found 98 symbols across 7
 * files"): the sentence counted only the symbols of the files whose SOURCE
 * survived the response budget, while the list also carries the flow spine,
 * which can reach into a file that did not survive. The server now derives both
 * from the same ids; these fallbacks keep cards saved before that fix honest by
 * counting what the card actually shows.
 */
function resultCounts(
  result: ExploreResult | undefined,
  model: GraphModel | null
): { symbols: number; files: number } {
  const ids = result?.nodeIds ?? [];
  return {
    symbols: result?.symbolCount ?? ids.length,
    files: result?.fileCount ?? distinctFiles(model, ids),
  };
}

/** A question card's answer: the flow first, then everything it surfaced. */
function ResultBody({
  result,
  model,
  onNavigate,
  onRefine,
}: {
  result: ExploreResult | undefined;
  model: GraphModel | null;
  onNavigate(id: string): void;
  onRefine: (() => void) | null;
}) {
  const [all, setAll] = useState(false);
  if (!result) {
    return <p className="px-1 text-[10px] text-muted">No answer stored for this card.</p>;
  }
  const nodes = result.nodeIds;
  const shown = all ? nodes : nodes.slice(0, LIST_PREVIEW);

  return (
    <div className="flex flex-col gap-2">
      {result.summary ? (
        <p className="px-1 text-[10px] leading-relaxed text-muted">{result.summary}</p>
      ) : null}
      {result.symbolBag ? (
        <p className="px-1 font-mono text-[9px] leading-relaxed text-accent/80" title="symbols the model proposed">
          {result.symbolBag}
        </p>
      ) : null}

      {result.flow.length > 0 ? (
        <div>
          <SectionLabel>flow</SectionLabel>
          <div className="flex flex-col">
            {flowChain(result.flow).map((step, index) => (
              <button
                key={`${step.id}-${index}`}
                type="button"
                onClick={() => onNavigate(step.id)}
                className="flex items-center gap-1.5 rounded px-1.5 py-[3px] text-left hover:bg-accent/10"
              >
                <span className="w-3 shrink-0 text-[9px] text-muted/70">{index + 1}</span>
                <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-foreground/90">
                  {qualifiedLabel(model, step.id)}
                </span>
                {step.via ? (
                  <span className="shrink-0 text-[9px] italic text-accent/80">{step.via}</span>
                ) : null}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {nodes.length > 0 ? (
        <div>
          <SectionLabel>symbols · {nodes.length}</SectionLabel>
          <div className="flex flex-col">
            {shown.map((id) => (
              <NodeRow key={id} id={id} model={model} onNavigate={onNavigate} />
            ))}
            {!all && nodes.length > shown.length ? (
              <button
                type="button"
                onClick={() => setAll(true)}
                className="px-1.5 py-[3px] text-left text-[10px] text-accent/80 hover:text-accent"
              >
                +{nodes.length - shown.length} more
              </button>
            ) : null}
          </div>
        </div>
      ) : (
        <p className="px-1 text-[10px] text-muted">Nothing matched this question.</p>
      )}

      {onRefine ? (
        <button
          type="button"
          onClick={onRefine}
          data-testid="refine-with-ai"
          className="flex items-center justify-center gap-1.5 rounded-md border border-border/70 py-1 text-[10px] text-muted hover:border-accent/60 hover:text-accent"
        >
          <Sparkles className="h-3 w-3" /> refine with AI
        </button>
      ) : null}
    </div>
  );
}

/**
 * One symbol of an answer.
 *
 * An answer that spans seven files is unreadable as a list of bare names, so
 * every row is qualified up to its file (`analytics.send`) — there is no
 * "current file" here to make a shorter form unambiguous.
 */
function NodeRow({
  id,
  model,
  onNavigate,
}: {
  id: string;
  model: GraphModel | null;
  onNavigate(id: string): void;
}) {
  const node = model?.get(id) ?? null;
  const Icon = iconForNode(node?.kind ?? DIRECTORY_KIND, node?.file ?? '');
  return (
    <button
      type="button"
      onClick={() => onNavigate(id)}
      title={node?.file ? `${node.file}:${node.startLine}` : node?.qualifiedName || id}
      data-testid="result-node"
      className="flex w-full items-center gap-1.5 rounded px-1.5 py-[3px] text-left hover:bg-accent/10"
    >
      <Icon
        className="h-3 w-3 shrink-0"
        style={{ color: colorForKind(node?.kind ?? DIRECTORY_KIND) }}
      />
      <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-foreground/90">
        {qualifiedLabel(model, id)}
      </span>
      <span className="shrink-0 text-[9px] text-muted/70">{node?.kind.replace(/_/g, ' ') ?? '—'}</span>
    </button>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-1 pb-0.5 text-[9px] uppercase tracking-[0.18em] text-muted">{children}</div>
  );
}

/** Flow hops → a walkable chain (`from` of the first hop, then every `to`). */
export function flowChain(flow: ExploreResult['flow']): Array<{ id: string; via: string }> {
  if (flow.length === 0) return [];
  const chain = [{ id: flow[0]!.from, via: '' }];
  for (const hop of flow) chain.push({ id: hop.to, via: hop.via });
  return chain;
}

