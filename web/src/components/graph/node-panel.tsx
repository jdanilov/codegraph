/**
 * The NODE panel — what the selected entry is, and what it reaches.
 *
 * Phase F reshaped it around one question: how much of the panel is spent on
 * things the reader already knows? The answers it removed —
 *
 *  - the extension / layer / language pills (the file name says it),
 *  - the `qualified` and `file` rows plus a separate `lines` row (one `parent`
 *    row says all three: `src/lib/api.ts:67-135`),
 *  - the repeated file name above the code and the code itself (its own panel
 *    now — see `code-panel.tsx`),
 *  - the Close button (Esc clears the selection; the panel COLLAPSES).
 *
 * — and one it added: every relation is shown **qualified**
 * (`analytics.send`, not `send`), extended up to the file name when the
 * reference lives outside the selected node's own file. A bare method name in a
 * list of forty references is not an answer.
 *
 * Two things are unchanged and deliberate:
 *
 *  - **Directories are answered locally.** `dirs[]` entries are synthesized by
 *    the graph payload and have no row behind `/api/node/:id`; the model
 *    already holds their children, which is all there is to say about one.
 *  - **Every relation is a navigation target.** Clicking a contained node or an
 *    edge endpoint selects and reveals it on the canvas, which is what makes
 *    the panel a way to *walk* the graph rather than a read-only readout.
 */
import { useMemo, useState } from 'react';
import {
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronRight,
  Loader2,
  SquareArrowOutUpRight,
  Waypoints,
} from 'lucide-react';

import { PanelButton, SidePanel } from './side-panel';
import { DIRECTORY_KIND, type GraphModel, type ModelNode } from '@/graph/model';
import { colorForKind } from '@/graph/palette';
import { openInEditor, type NodeDetail, type NodeRelation, type NodeRef } from '@/lib/api';
import { iconForNode } from '@/lib/file-icons';
import { containerLabel, qualifiedLabel } from '@/lib/qualify';
import { cn } from '@/lib/utils';

/** Contained nodes / relations shown before the list collapses behind "+N". */
const LIST_PREVIEW = 6;

export interface NodePanelProps {
  node: ModelNode;
  model: GraphModel | null;
  /** `/api/node/:id`, fetched once by the shell for both right-hand panels. */
  detail: NodeDetail | null;
  loading: boolean;
  error: string | null;
  /** Absolute project root from `/api/status`, for the `vscode://` fallback. */
  root: string | null;
  /** Select the node and bring it into view on the canvas. */
  onNavigate(id: string): void;
  /** Is IMPACT mode on for this node? */
  impact: boolean;
  /** Toggle impact mode — the shell owns the closure and the dimming. */
  onToggleImpact(): void;
  collapsed: boolean;
  onToggleCollapsed(): void;
  /** Height policy from the shell — it knows whether the code panel is up. */
  className?: string;
}

export function NodePanel({
  node,
  model,
  detail,
  loading,
  error,
  root,
  onNavigate,
  impact,
  onToggleImpact,
  collapsed,
  onToggleCollapsed,
  className,
}: NodePanelProps) {
  const isDirectory = node.kind === DIRECTORY_KIND;

  const contained: NodeRef[] = useMemo(() => {
    if (detail) return detail.contains;
    // Directories (and the pre-fetch frame) answer from the model.
    return node.children
      .map((id) => model?.get(id))
      .filter((child): child is ModelNode => Boolean(child))
      .map((child) => ({
        id: child.id,
        kind: child.kind,
        name: child.name,
        qualifiedName: child.qualifiedName,
        file: child.file,
        startLine: child.startLine,
        endLine: child.endLine,
      }));
  }, [detail, node.children, model]);

  const Icon = iconForNode(node.kind, node.file);

  return (
    <SidePanel
      data-testid="node-panel"
      collapsed={collapsed}
      onToggleCollapsed={onToggleCollapsed}
      className={className ?? 'max-h-[45%] shrink-0'}
      bodyClassName="px-2.5 py-2 text-[11px]"
      icon={<Icon className="h-3.5 w-3.5" style={{ color: colorForKind(node.kind) }} />}
      title={
        <span title={node.qualifiedName || node.name}>{node.name}</span>
      }
      meta={node.kind.replace(/_/g, ' ')}
      actions={
        <>
          {/* IMPACT (round 4): this node plus everything that transitively
              depends on it, lit; the rest of the disk dimmed. */}
          <PanelButton
            onClick={onToggleImpact}
            active={impact}
            label={impact ? 'Clear impact' : 'Show what depends on this (impact)'}
            data-testid="impact-toggle"
          >
            <Waypoints className="h-3.5 w-3.5" />
          </PanelButton>
          {isDirectory ? null : (
            <EditorJump root={root} file={node.file} line={node.startLine || 1} />
          )}
        </>
      }
    >
      <dl className="flex flex-col gap-1">
        <Row label="parent" value={containerLabel(node)} />
        {isDirectory ? <Row label="loc" value={String(node.weight)} /> : null}
      </dl>

      {detail?.node.signature ? (
        <pre className="mt-2 max-h-16 overflow-auto rounded border border-border/60 bg-background/40 px-2 py-1 font-mono text-[10px] leading-snug text-foreground/80">
          {detail.node.signature}
        </pre>
      ) : null}

      {loading ? (
        <p className="mt-3 flex items-center gap-2 text-muted">
          <Loader2 className="h-3 w-3 animate-spin" /> loading details…
        </p>
      ) : null}
      {error ? <p className="mt-3 text-[11px] text-red-400">{error}</p> : null}

      <div className="mt-3 flex flex-col gap-2">
        {/* `contains` is open by default: the backbone is the fastest way into
            a node's members, and a collapsed list reads as "nothing here". */}
        {contained.length > 0 ? (
          <Section title="contains" count={contained.length} defaultOpen>
            <NodeList items={contained} onNavigate={onNavigate} />
          </Section>
        ) : null}

        <EdgesSection
          incoming={detail?.incoming ?? []}
          outgoing={detail?.outgoing ?? []}
          model={model}
          contextFile={node.file}
          onNavigate={onNavigate}
        />
      </div>
    </SidePanel>
  );
}

/**
 * "Jump to editor" — a title-bar icon button (phase F).
 *
 * Resolution order, and the phase F bug fix: the CONFIGURED editor command
 * wins. The button POSTs `/api/open`, which runs the template from
 * `~/.codegraph/ui.json` server-side; only the contract's 409 ("nothing
 * configured") falls back to the `vscode://` URL scheme. It used to be rendered
 * as an anchor whose `href` was ALWAYS that fallback URL — so the browser
 * advertised (and, on any path that skipped the click handler, followed)
 * `vscode://` even when the user had configured a different editor. A launch
 * that fails is now reported instead of being silently swallowed.
 */
function EditorJump({ root, file, line }: { root: string | null; file: string; line: number }) {
  const [state, setState] = useState<{ status: 'idle' | 'ok' | 'error'; message: string }>({
    status: 'idle',
    message: 'Jump to editor',
  });

  const jump = async (): Promise<void> => {
    const result = await openInEditor(file, line);
    if (result.ok) {
      setState({ status: 'ok', message: 'Opened in your editor' });
      return;
    }
    if (result.reason === 'unconfigured') {
      // No server-side editor command: hand the OS the URL scheme instead.
      setState({ status: 'ok', message: 'No editor command set — using vscode://' });
      window.location.href = vscodeUrl(root, file, line);
      return;
    }
    setState({ status: 'error', message: result.message });
  };

  return (
    <PanelButton onClick={() => void jump()} label={state.message} data-testid="editor-jump">
      {state.status === 'ok' ? (
        <Check className="h-3.5 w-3.5 text-accent" />
      ) : state.status === 'error' ? (
        <AlertTriangle className="h-3.5 w-3.5 text-red-400" />
      ) : (
        <SquareArrowOutUpRight className="h-3.5 w-3.5" />
      )}
    </PanelButton>
  );
}

/** `vscode://file/<abs>:<line>` — the client-side fallback the contract names. */
export function vscodeUrl(root: string | null, file: string, line: number): string {
  const base = (root ?? '').replace(/[\\/]+$/, '');
  const joined = base ? `${base}/${file}` : file;
  const absolute = joined.replace(/\\/g, '/');
  const path = absolute.startsWith('/') ? absolute : `/${absolute}`;
  return `vscode://file${path}:${line}`;
}

/**
 * Edge kinds that read backwards on the INCOMING side.
 *
 * An edge is stored in the direction the source declares it, so an incoming
 * `extends` means "that symbol extends THIS one" — labelling the group
 * `extends` said the opposite of what the row meant. The passive voice is the
 * honest label. (`calls`, `imports`, `references`, `instantiates` and the rest
 * stay as they are: the ← arrow already carries "…by" for a verb that has no
 * direction problem, and `called by` on every row adds noise without meaning.)
 */
const INCOMING_KIND_LABELS: Record<string, string> = {
  extends: 'extended by',
};

/**
 * EDGES — the two directions **stacked, one after the other** (round 4).
 *
 * Round 3 put them in two columns; that treatment belongs to the LEGEND on the
 * left, which says what the two edge colours mean in one row. Here the two
 * lists are the panel's content, and halving their width halved the room a
 * qualified name (`analytics.send`) has to be readable in — which is the whole
 * reason the names are qualified. Outgoing first (what this reaches), then
 * incoming (what reaches it). Everything inside a group is unchanged: grouped
 * by kind, qualified names, and `extended by` for an incoming `extends`.
 */
function EdgesSection({
  incoming,
  outgoing,
  model,
  contextFile,
  onNavigate,
}: {
  incoming: NodeRelation[];
  outgoing: NodeRelation[];
  model: GraphModel | null;
  contextFile: string;
  onNavigate(id: string): void;
}) {
  if (incoming.length === 0 && outgoing.length === 0) return null;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="text-[10px] uppercase tracking-[0.18em] text-muted">edges</div>
      <RelationColumn
        title="outgoing"
        arrow="→"
        relations={outgoing}
        model={model}
        contextFile={contextFile}
        onNavigate={onNavigate}
      />
      <RelationColumn
        title="incoming"
        arrow="←"
        relations={incoming}
        model={model}
        contextFile={contextFile}
        onNavigate={onNavigate}
      />
    </div>
  );
}

function RelationColumn({
  title,
  arrow,
  relations,
  model,
  contextFile,
  onNavigate,
}: {
  title: string;
  arrow: string;
  relations: NodeRelation[];
  model: GraphModel | null;
  contextFile: string;
  onNavigate(id: string): void;
}) {
  const incoming = title === 'incoming';
  const groups = useMemo(() => groupByKind(relations), [relations]);
  // Stacked (round 4): an empty half is left out entirely rather than printed
  // as a `· 0` heading over nothing.
  if (relations.length === 0) return null;
  return (
    <div className="flex min-w-0 flex-col gap-1" data-testid={`edges-${title}`}>
      <div className="text-[10px] text-muted/80">
        {title} · {relations.length}
      </div>
      {groups.map(([kind, items]) => (
        <Section
          key={kind}
          title={`${arrow} ${(incoming && INCOMING_KIND_LABELS[kind]) || kind}`}
          count={items.length}
          defaultOpen
        >
          <RelationList
            items={items}
            model={model}
            contextFile={contextFile}
            onNavigate={onNavigate}
          />
        </Section>
      ))}
    </div>
  );
}

function groupByKind(relations: NodeRelation[]): Array<[string, NodeRelation[]]> {
  const groups = new Map<string, NodeRelation[]>();
  for (const relation of relations) {
    const list = groups.get(relation.kind);
    if (list) list.push(relation);
    else groups.set(relation.kind, [relation]);
  }
  return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

function Section({
  title,
  count,
  defaultOpen,
  children,
}: {
  title: string;
  count: number;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(Boolean(defaultOpen));
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-1 rounded px-0.5 py-0.5 text-left text-[10px] text-muted hover:text-foreground"
      >
        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        <span className="font-medium">{title}</span>
        <span className="text-muted/70">{count}</span>
      </button>
      {open ? <div className="mt-0.5 flex flex-col">{children}</div> : null}
    </div>
  );
}

function NodeList({ items, onNavigate }: { items: NodeRef[]; onNavigate(id: string): void }) {
  const [all, setAll] = useState(false);
  const shown = all ? items : items.slice(0, LIST_PREVIEW);
  return (
    <>
      {shown.map((item) => (
        <TargetRow
          key={item.id}
          kind={item.kind}
          file={item.file}
          name={item.name}
          title={item.qualifiedName || item.name}
          onClick={() => onNavigate(item.id)}
        />
      ))}
      {!all && items.length > shown.length ? (
        <MoreButton count={items.length - shown.length} onClick={() => setAll(true)} />
      ) : null}
    </>
  );
}

function RelationList({
  items,
  model,
  contextFile,
  onNavigate,
}: {
  items: NodeRelation[];
  model: GraphModel | null;
  contextFile: string;
  onNavigate(id: string): void;
}) {
  const [all, setAll] = useState(false);
  const shown = all ? items : items.slice(0, LIST_PREVIEW);
  return (
    <>
      {shown.map((relation, index) => {
        const target = relation.node;
        const heuristic = relation.provenance === 'heuristic';
        // Qualified: `parent.symbol` inside this file, up to the file name
        // outside it — a bare name is not enough to tell two `send`s apart.
        const label = qualifiedLabel(
          model,
          target?.id ?? relation.target,
          contextFile,
          target ?? undefined
        );
        return (
          <TargetRow
            key={`${relation.source}|${relation.target}|${relation.line ?? index}`}
            kind={target?.kind ?? 'unknown'}
            file={target?.file ?? ''}
            name={label}
            title={target?.qualifiedName || target?.file || relation.target}
            heuristic={heuristic}
            note={heuristic ? (relation.synthesizedBy ?? 'synthesized') : undefined}
            disabled={!target}
            onClick={() => target && onNavigate(target.id)}
          />
        );
      })}
      {!all && items.length > shown.length ? (
        <MoreButton count={items.length - shown.length} onClick={() => setAll(true)} />
      ) : null}
    </>
  );
}

function TargetRow({
  kind,
  file,
  name,
  title,
  note,
  heuristic,
  disabled,
  onClick,
}: {
  kind: string;
  file: string;
  name: string;
  title: string;
  note?: string;
  heuristic?: boolean;
  disabled?: boolean;
  onClick(): void;
}) {
  const Icon = iconForNode(kind, file);
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      title={title}
      data-testid="relation-row"
      data-kind={kind}
      className={cn(
        'group flex w-full items-center gap-1.5 rounded px-1.5 py-[3px] text-left',
        disabled ? 'cursor-default opacity-50' : 'hover:bg-accent/10'
      )}
    >
      <Icon
        className={cn('h-3 w-3 shrink-0', heuristic && 'opacity-60')}
        style={{ color: colorForKind(kind) }}
      />
      <span className="min-w-0 flex-1 truncate font-mono text-foreground/90">{name}</span>
      {note ? (
        <span className="shrink-0 truncate text-[9px] italic text-accent/80" title={note}>
          {note}
        </span>
      ) : null}
      <span className="shrink-0 text-[9px] text-muted/70">{kind.replace(/_/g, ' ')}</span>
    </button>
  );
}

function MoreButton({ count, onClick }: { count: number; onClick(): void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="px-1.5 py-[3px] text-left text-[10px] text-accent/80 hover:text-accent"
    >
      +{count} more
    </button>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-2">
      <dt className="w-12 shrink-0 text-muted">{label}</dt>
      <dd className="min-w-0 flex-1 truncate font-mono text-foreground/90" title={value}>
        {value}
      </dd>
    </div>
  );
}
