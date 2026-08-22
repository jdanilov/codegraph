/**
 * The node info panel — the body of the floating selection card.
 *
 * Everything the contract asks a selection to answer lives here: what the node
 * IS (kind, qualified name, file span, layer), what it CONTAINS, what it
 * REACHES and what reaches it (grouped by edge kind, heuristic edges labelled
 * with the synthesizer that wired them), its SOURCE, and a jump into the
 * user's editor.
 *
 * Two things are deliberate:
 *
 *  - **Directories are answered locally.** `dirs[]` entries are synthesized by
 *    the graph payload and have no row behind `/api/node/:id`, so asking for
 *    one would 404. The model already holds their children, which is the only
 *    thing there is to say about a directory.
 *  - **Every relation is a navigation target.** Clicking a contained node or
 *    an edge endpoint selects and reveals it on the canvas, which is what makes
 *    the panel a way to *walk* the graph rather than a read-only readout.
 */
import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, ExternalLink, Loader2 } from 'lucide-react';

import { SourceView } from './source-view';
import { Badge } from '@/components/ui/badge';
import { DIRECTORY_KIND, type GraphModel, type ModelNode } from '@/graph/model';
import { colorForKind } from '@/graph/palette';
import { fetchNode, openInEditor, type NodeDetail, type NodeRelation, type NodeRef } from '@/lib/api';
import { cn } from '@/lib/utils';

/** Contained nodes / relations shown before the list collapses behind "+N". */
const LIST_PREVIEW = 6;

export interface NodePanelProps {
  node: ModelNode;
  model: GraphModel | null;
  /** Absolute project root from `/api/status`, for the `vscode://` fallback. */
  root: string | null;
  /** Select the node and bring it into view on the canvas. */
  onNavigate(id: string): void;
}

export function NodePanel({ node, model, root, onNavigate }: NodePanelProps) {
  const [detail, setDetail] = useState<NodeDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const isDirectory = node.kind === DIRECTORY_KIND;

  useEffect(() => {
    setDetail(null);
    setError(null);
    if (isDirectory) return;
    const controller = new AbortController();
    setLoading(true);
    void fetchNode(node.id, controller.signal)
      .then((payload) => {
        if (!controller.signal.aborted) setDetail(payload);
      })
      .catch((err: unknown) => {
        if (!controller.signal.aborted) setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [node.id, isDirectory]);

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

  const qualified = detail?.node.qualifiedName || node.qualifiedName;

  return (
    <div className="mt-3 flex min-h-0 flex-col text-[11px]">
      <div className="flex flex-wrap items-center gap-1.5">
        {node.layer ? <Badge variant="accent">{node.layer}</Badge> : null}
        {detail?.node.isExported ? <Badge variant="muted">exported</Badge> : null}
        {detail?.node.visibility ? (
          <Badge variant="muted">{detail.node.visibility}</Badge>
        ) : null}
        {detail?.node.language ? <Badge variant="muted">{detail.node.language}</Badge> : null}
      </div>

      <dl className="mt-2 flex flex-col gap-1">
        {qualified && qualified !== node.name ? <Row label="qualified" value={qualified} /> : null}
        <Row label={isDirectory ? 'path' : 'file'} value={node.file || '(project root)'} />
        {!isDirectory ? <Row label="lines" value={`${node.startLine}–${node.endLine}`} /> : null}
        {isDirectory ? <Row label="loc" value={String(node.weight)} /> : null}
      </dl>

      {detail?.node.signature ? (
        <pre className="mt-2 max-h-16 overflow-auto rounded border border-border/60 bg-background/40 px-2 py-1 font-mono text-[10px] leading-snug text-foreground/80">
          {detail.node.signature}
        </pre>
      ) : null}

      {!isDirectory ? (
        <EditorJump root={root} file={node.file} line={node.startLine || 1} />
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

        <RelationSections
          title="outgoing"
          arrow="→"
          relations={detail?.outgoing ?? []}
          onNavigate={onNavigate}
        />
        <RelationSections
          title="incoming"
          arrow="←"
          relations={detail?.incoming ?? []}
          onNavigate={onNavigate}
        />

        {/* Waits for the detail payload, which already carries the span — so
            the source pane costs zero extra requests. Keyed by node id so a
            navigation remounts it with clean state instead of reconciling. */}
        {!isDirectory && detail ? (
          <SourceView
            key={detail.node.id}
            file={detail.node.file}
            startLine={detail.node.startLine || 1}
            endLine={detail.node.endLine || detail.node.startLine || 1}
            initial={detail.source}
          />
        ) : null}
      </div>
    </div>
  );
}

/**
 * "Jump to editor" — POSTs `/api/open`, and on the contract's 409 ("no editor
 * command configured") falls back to the `vscode://` URL scheme. The button IS
 * that URL: rendering it as a real anchor means the fallback works even if the
 * click handler never runs, and makes the target visible on hover.
 */
function EditorJump({ root, file, line }: { root: string | null; file: string; line: number }) {
  const [note, setNote] = useState<string | null>(null);
  const href = useMemo(() => vscodeUrl(root, file, line), [root, file, line]);

  const handle = async (event: React.MouseEvent<HTMLAnchorElement>): Promise<void> => {
    event.preventDefault();
    setNote(null);
    const result = await openInEditor(file, line);
    if (result.ok) {
      setNote('opened');
      return;
    }
    if (result.reason === 'unconfigured') {
      // No server-side editor command: hand the OS the URL scheme instead.
      setNote('no editor command set — using vscode://');
      window.location.href = href;
      return;
    }
    setNote(result.message);
  };

  return (
    <div className="mt-2 flex items-center gap-2">
      <a
        href={href}
        onClick={(event) => void handle(event)}
        data-testid="editor-jump"
        className="inline-flex items-center gap-1.5 rounded border border-border/70 px-2 py-1 text-[10px] text-muted transition-colors hover:border-accent/60 hover:text-accent"
      >
        <ExternalLink className="h-3 w-3" /> jump to editor
      </a>
      {note ? <span className="truncate text-[10px] text-muted">{note}</span> : null}
    </div>
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

function RelationSections({
  title,
  arrow,
  relations,
  onNavigate,
}: {
  title: string;
  arrow: string;
  relations: NodeRelation[];
  onNavigate(id: string): void;
}) {
  const groups = useMemo(() => groupByKind(relations), [relations]);
  if (groups.length === 0) return null;
  return (
    <div className="flex flex-col gap-1">
      <div className="text-[10px] uppercase tracking-[0.18em] text-muted">
        {title} · {relations.length}
      </div>
      {groups.map(([kind, items]) => (
        <Section key={kind} title={`${arrow} ${kind}`} count={items.length} defaultOpen>
          <RelationList items={items} onNavigate={onNavigate} />
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
        className="flex w-full items-center gap-1 rounded px-0.5 py-0.5 text-left text-[10px] text-muted transition-colors hover:text-foreground"
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
  onNavigate,
}: {
  items: NodeRelation[];
  onNavigate(id: string): void;
}) {
  const [all, setAll] = useState(false);
  const shown = all ? items : items.slice(0, LIST_PREVIEW);
  return (
    <>
      {shown.map((relation, index) => {
        const target = relation.node;
        const heuristic = relation.provenance === 'heuristic';
        return (
          <TargetRow
            key={`${relation.source}|${relation.target}|${relation.line ?? index}`}
            kind={target?.kind ?? 'unknown'}
            name={target?.name ?? relation.target}
            title={target?.qualifiedName || relation.target}
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
  name,
  title,
  note,
  heuristic,
  disabled,
  onClick,
}: {
  kind: string;
  name: string;
  title: string;
  note?: string;
  heuristic?: boolean;
  disabled?: boolean;
  onClick(): void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      title={title}
      data-testid="relation-row"
      data-kind={kind}
      className={cn(
        'group flex w-full items-center gap-1.5 rounded px-1.5 py-[3px] text-left transition-colors',
        disabled ? 'cursor-default opacity-50' : 'hover:bg-accent/10'
      )}
    >
      <span
        className={cn('h-1.5 w-1.5 shrink-0 rounded-full', heuristic && 'opacity-60')}
        style={{ backgroundColor: colorForKind(kind) }}
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
      <dt className="w-14 shrink-0 text-muted">{label}</dt>
      <dd className="min-w-0 flex-1 truncate font-mono text-foreground/90" title={value}>
        {value}
      </dd>
    </div>
  );
}
