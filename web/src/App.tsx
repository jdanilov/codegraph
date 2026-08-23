/**
 * App shell.
 *
 * The canvas IS the app: it fills the viewport as the background layer and
 * every other surface floats on top of it (contract: "minimal + light
 * futuristic; graph is the background; code panels / views float on top").
 *
 * Phase D added the question layer and made the view addressable; phase E
 * swapped the representation underneath it for a sunburst, which changes what
 * "apply a card to the canvas" means:
 *
 *  - **Cards.** Two standing views (Project, Changes) plus saved question
 *    cards. Activating one re-roots the disk onto the deepest node containing
 *    every result, selects nothing, glows the result (dimming the rest) and
 *    bundles the result's edges.
 *  - **Changes.** `GET /api/changes` refreshed whenever `dataVersion` moves
 *    while the view is active — changed arcs wear a hot rim, impacted ones a
 *    warm one, and a node opened from here shows its diff first.
 *  - **Feedback export.** The active view plus the current selection, rendered
 *    as markdown to paste into an agent prompt.
 *  - **URL = state.** Current root, active card, colour mode and edge toggles
 *    live in the hash (see `lib/url-state.ts`), restored on load. A phase D
 *    link carrying an expansion set still opens — it re-roots to what those
 *    ids have in common.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Search, Settings as SettingsIcon } from 'lucide-react';

import { CommandPalette } from '@/components/command-palette';
import { SettingsDialog } from '@/components/settings-dialog';
import {
  CardsPanel,
  CHANGES_VIEW_ID,
  PROJECT_VIEW_ID,
} from '@/components/cards/cards-panel';
import { FeedbackDialog, type FeedbackNode } from '@/components/feedback-dialog';
import { CodePanel } from '@/components/graph/code-panel';
import { GraphCanvas } from '@/components/graph/graph-canvas';
import { LegendPanel } from '@/components/graph/legend-panel';
import { NodePanel } from '@/components/graph/node-panel';
import { StatusPanel } from '@/components/graph/status-panel';
import type { CanvasController, ViewSummary } from '@/graph/canvas-controller';
import { DIRECTORY_KIND, ROOT_ID, type GraphModel, type ModelNode } from '@/graph/model';
import { useNodeDetail } from '@/graph/use-node-detail';
import type { ColorMode } from '@/graph/palette';
import { DEFAULT_SORT_MODE, toSortMode, type SortMode } from '@/graph/sunburst';
import { useGraphData } from '@/graph/use-graph-data';
import {
  askQuestion,
  exploreQuery,
  fetchCards,
  fetchChanges,
  fetchSettings,
  saveCards,
  type Card,
  type ChangesPayload,
  type ExploreResult,
} from '@/lib/api';
import { decodeUrlState, encodeUrlState } from '@/lib/url-state';

export default function App() {
  const { status, model, error, indexing, indexLog, runIndex } = useGraphData();
  const controllerRef = useRef<CanvasController | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [feedbackOpen, setFeedbackOpen] = useState(false);

  const [cards, setCards] = useState<Card[]>([]);
  const [activeId, setActiveId] = useState<string>(PROJECT_VIEW_ID);
  const [busy, setBusy] = useState(false);
  const [askError, setAskError] = useState<string | null>(null);
  const [askAvailable, setAskAvailable] = useState(false);
  const [colorMode, setColorMode] = useState<ColorMode>('kind');
  // Sibling order lives in the user's settings (`~/.codegraph/ui.json`), not in
  // the URL: it is how this person likes to read a disk, not part of the view
  // they would share with someone else.
  const [sortMode, setSortMode] = useState<SortMode>(DEFAULT_SORT_MODE);
  const [selectedNode, setSelectedNode] = useState<ModelNode | null>(null);
  // The two right-hand panels COLLAPSE rather than close (phase F): folding one
  // away must not throw the selection out, and the state has to survive picking
  // a different node — a reader who folded the code away wants it to stay
  // folded while they walk the graph.
  const [nodePanelCollapsed, setNodePanelCollapsed] = useState(false);
  const [codePanelCollapsed, setCodePanelCollapsed] = useState(false);
  // …and so do the two LEFT-hand panels (round 2): the disk is the app, and
  // both columns should be able to get out of its way with the same gesture.
  const [cardsPanelCollapsed, setCardsPanelCollapsed] = useState(false);
  const [legendPanelCollapsed, setLegendPanelCollapsed] = useState(false);
  /** Colour keys currently on the disk — the LEGEND's only input. */
  const [colorKeys, setColorKeys] = useState<string[]>([]);
  const colorKeysRef = useRef('');

  const detailState = useNodeDetail(selectedNode);

  const [changes, setChanges] = useState<ChangesPayload | null>(null);
  const [changesError, setChangesError] = useState<string | null>(null);

  // Refs the imperative canvas work reads: the apply/restore paths run outside
  // React's render, so they must not close over stale state.
  const cardsRef = useRef(cards);
  cardsRef.current = cards;
  const changesRef = useRef(changes);
  changesRef.current = changes;
  const activeRef = useRef(activeId);
  activeRef.current = activeId;
  const restoredRef = useRef(false);
  const urlTimer = useRef<number | null>(null);

  // ---------------------------------------------------------------- data ---

  useEffect(() => {
    void fetchCards()
      .then(setCards)
      .catch(() => {
        /* a project with no cards file is the normal empty state */
      });
    void refreshSettings();
  }, []);

  /** One settings read feeds both the ask button and the disk's order. */
  const refreshSettings = useCallback(async () => {
    try {
      const view = await fetchSettings();
      setAskAvailable(view.anthropicApiKeySet);
      setSortMode(toSortMode(view.sortMode));
    } catch {
      setAskAvailable(false);
    }
  }, []);

  /** Changes are re-read whenever the index moves while the view is on show. */
  const loadChanges = useCallback(async () => {
    try {
      const payload = await fetchChanges();
      setChanges(payload);
      setChangesError(null);
      return payload;
    } catch (err) {
      setChangesError(err instanceof Error ? err.message : String(err));
      return null;
    }
  }, []);

  useEffect(() => {
    if (activeId !== CHANGES_VIEW_ID) return;
    void loadChanges().then((payload) => {
      if (payload) applyChanges(payload);
    });
    // `dataVersion` is the contract's "something changed" signal.
  }, [activeId, status?.dataVersion, loadChanges]);

  // --------------------------------------------------------------- cards ---

  const persist = useCallback((next: Card[]) => {
    setCards(next);
    void saveCards(next).catch(() => {
      /* the card still works this session even if the write failed */
    });
  }, []);

  /**
   * Put a card's answer on the disk: glow the results, bundle their edges, and
   * re-root onto the deepest node that contains them all (the controller works
   * that out — a spread-out answer stays at the project root).
   */
  const applyResult = useCallback(
    (result: ExploreResult | undefined) => {
      const controller = controllerRef.current;
      if (!controller || !model) return;
      const ids = result?.nodeIds ?? [];
      controller.setHighlight({ nodes: ids, edges: result?.edgeRefs ?? [] });
      controller.setSelected(null);
      setSelectedNode(null);
      controller.focusNodes(ids);
    },
    [model]
  );

  const applyChanges = useCallback(
    (payload: ChangesPayload) => {
      const controller = controllerRef.current;
      if (!controller || !model) return;
      const changed = payload.changedNodes.map((node) => node.id);
      controller.setHighlight({ changed, impacted: payload.impactedNodeIds });
      controller.setSelected(null);
      setSelectedNode(null);
      controller.focusNodes(changed);
    },
    [model]
  );

  const activate = useCallback(
    (id: string) => {
      setActiveId(id);
      const controller = controllerRef.current;
      if (!controller || !model) return;

      if (id === PROJECT_VIEW_ID) {
        controller.setRoot(ROOT_ID);
        controller.setHighlight(null);
        controller.setSelected(null);
        setSelectedNode(null);
        controller.fitView();
        return;
      }
      if (id === CHANGES_VIEW_ID) {
        const payload = changesRef.current;
        if (payload) applyChanges(payload);
        else void loadChanges().then((next) => next && applyChanges(next));
        return;
      }
      applyResult(cardsRef.current.find((card) => card.id === id)?.result);
    },
    [model, applyChanges, applyResult, loadChanges]
  );

  /**
   * Ask a question. The deterministic explore is what lands the card — the
   * model, when configured, is an explicit follow-up ("refine with AI") rather
   * than a gate in front of the answer.
   */
  const ask = useCallback(
    (question: string) => {
      setBusy(true);
      setAskError(null);
      void exploreQuery(question)
        .then((result) => {
          const card: Card = {
            id: `card-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
            question,
            createdAt: Date.now(),
            result,
          };
          persist([card, ...cardsRef.current]);
          setActiveId(card.id);
          applyResult(result);
        })
        .catch((err: unknown) => setAskError(err instanceof Error ? err.message : String(err)))
        .finally(() => setBusy(false));
    },
    [persist, applyResult]
  );

  /** Re-answer an existing card through the model, replacing its result. */
  const refine = useCallback(
    (card: Card) => {
      setBusy(true);
      setAskError(null);
      void askQuestion(card.question)
        .then((outcome) => {
          if (!outcome.ok) {
            setAskError(outcome.message);
            return;
          }
          const next = cardsRef.current.map((entry) =>
            entry.id === card.id ? { ...entry, result: outcome.result } : entry
          );
          persist(next);
          setActiveId(card.id);
          applyResult(outcome.result);
        })
        .finally(() => setBusy(false));
    },
    [persist, applyResult]
  );

  const removeCard = useCallback(
    (id: string) => {
      persist(cardsRef.current.filter((card) => card.id !== id));
      if (activeRef.current === id) activate(PROJECT_VIEW_ID);
    },
    [persist, activate]
  );

  // ----------------------------------------------------------- URL state ---

  /** Restore once, as soon as there is a model to restore INTO. */
  useEffect(() => {
    if (restoredRef.current || !model) return;
    restoredRef.current = true;
    const controller = controllerRef.current;
    void decodeUrlState(window.location.hash).then((state) => {
      if (!state || !controller) {
        scheduleUrlUpdate();
        return;
      }
      setColorMode(state.colorMode);
      if (state.edgeKinds && state.edgeKinds.length > 0) controller.setEdgeKinds(state.edgeKinds);

      const cardId = state.cardId ?? PROJECT_VIEW_ID;
      setActiveId(cardId);
      // The card's highlight is restored, but NOT its root: the URL's own root
      // is where the user actually was, which may be deeper or shallower than
      // where the card would land.
      if (cardId === CHANGES_VIEW_ID) {
        void loadChanges().then((payload) => {
          if (payload) {
            controller.setHighlight({
              changed: payload.changedNodes.map((node) => node.id),
              impacted: payload.impactedNodeIds,
            });
          }
        });
      } else if (cardId !== PROJECT_VIEW_ID) {
        const result = cardsRef.current.find((card) => card.id === cardId)?.result;
        if (result) controller.setHighlight({ nodes: result.nodeIds, edges: result.edgeRefs });
      }

      // A phase E link names its root outright; a phase D one carries the old
      // expansion set, which `setExpanded` translates into the closest root.
      if (state.root) controller.setRoot(state.root, false);
      else if (state.legacyExpanded.length > 0) controller.setExpanded(state.legacyExpanded);
    });
  }, [model, loadChanges]);

  /** Debounced hash write; the canvas fires a view change on every re-root. */
  const scheduleUrlUpdate = useCallback(() => {
    if (!restoredRef.current) return;
    if (urlTimer.current !== null) window.clearTimeout(urlTimer.current);
    urlTimer.current = window.setTimeout(() => {
      urlTimer.current = null;
      const controller = controllerRef.current;
      if (!controller) return;
      void encodeUrlState({
        root: controller.getRoot(),
        cardId: activeRef.current,
        colorMode,
        edgeKinds: controller.enabledEdgeKinds(),
      }).then((hash) => {
        window.history.replaceState(null, '', hash);
      });
    }, 350);
  }, [colorMode]);

  useEffect(() => {
    scheduleUrlUpdate();
  }, [activeId, colorMode, scheduleUrlUpdate]);

  /**
   * The canvas reports a view summary on every re-root, re-fit and edge redraw.
   * Only ONE thing in it belongs to React — the colour keys the legend lists —
   * so the rest is dropped here rather than re-rendering the shell on hover.
   */
  const handleViewChange = useCallback(
    (summary: ViewSummary) => {
      scheduleUrlUpdate();
      const key = summary.presentColorKeys.join('|');
      if (key === colorKeysRef.current) return;
      colorKeysRef.current = key;
      setColorKeys(summary.presentColorKeys);
    },
    [scheduleUrlUpdate]
  );

  useEffect(
    () => () => {
      if (urlTimer.current !== null) window.clearTimeout(urlTimer.current);
    },
    []
  );

  // ------------------------------------------------------------ commands ---

  /** Drop the selection and, with it, both right-hand panels. */
  const clearSelection = useCallback(() => {
    controllerRef.current?.setSelected(null);
    setSelectedNode(null);
  }, []);

  /**
   * Global keyboard handling. Both shortcuts are captured on the WINDOW: the
   * canvas is a bitmap surface with no focusable children, and — the phase F
   * bug — a dialog's own React `onKeyDown` only fires while the DOM focus
   * happens to sit inside that dialog, which is not something the shell can
   * guarantee. Escape now has ONE owner and a fixed priority:
   *
   *   1. the ⌘P palette, 2. settings, 3. the feedback export, 4. the selection.
   *
   * Nothing happens when none of those is up — Escape never navigates.
   */
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'p') {
        event.preventDefault();
        setPaletteOpen(true);
        return;
      }
      if (event.key !== 'Escape') return;
      if (paletteOpen) {
        event.preventDefault();
        setPaletteOpen(false);
        return;
      }
      if (settingsOpen) {
        event.preventDefault();
        setSettingsOpen(false);
        void refreshSettings();
        return;
      }
      if (feedbackOpen) {
        event.preventDefault();
        setFeedbackOpen(false);
        return;
      }
      if (selectedNode) {
        event.preventDefault();
        clearSelection();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [paletteOpen, settingsOpen, feedbackOpen, selectedNode, clearSelection, refreshSettings]);

  /** Select a node and bring it on screen — used by the palette and the panel. */
  const navigate = useCallback((id: string) => {
    controllerRef.current?.reveal(id);
  }, []);

  // ------------------------------------------------------------ feedback ---

  const activeCard = cards.find((card) => card.id === activeId) ?? null;
  const feedbackContext = activeCard
    ? activeCard.question
    : activeId === CHANGES_VIEW_ID
      ? 'Uncommitted changes vs HEAD'
      : 'Project overview';
  const feedbackSummary = activeCard?.result?.summary ?? changesSummaryText(activeId, changes);
  const feedbackResultNodes = useMemo<FeedbackNode[]>(() => {
    const ids =
      activeId === CHANGES_VIEW_ID
        ? (changes?.changedNodes.map((node) => node.id) ?? [])
        : (activeCard?.result?.nodeIds ?? []);
    return ids.map((id) => describeForFeedback(model, id)).filter((node): node is FeedbackNode => Boolean(node));
  }, [activeId, activeCard, changes, model]);
  const feedbackSelected = useMemo<FeedbackNode[]>(() => {
    const node = selectedNode ? describeForFeedback(model, selectedNode.id) : null;
    return node ? [node] : [];
  }, [selectedNode, model]);

  return (
    <div className="relative h-full w-full">
      <GraphCanvas
        model={model}
        colorMode={colorMode}
        onColorModeChange={setColorMode}
        sortMode={sortMode}
        onViewChange={handleViewChange}
        onController={(controller) => {
          controllerRef.current = controller;
        }}
        onSelect={setSelectedNode}
      />

      {/* Left column: everything you DRIVE the disk with. */}
      <div className="pointer-events-none absolute inset-y-0 left-0 p-4">
        <div className="flex max-h-full w-[22rem] flex-col gap-3">
          <StatusPanel
            status={status}
            error={error}
            indexing={indexing}
            indexLog={indexLog}
            onIndex={() => void runIndex()}
          />
          <div className="pointer-events-auto flex items-center gap-2">
            <button
              type="button"
              onClick={() => setPaletteOpen(true)}
              data-testid="open-palette"
              className="flex flex-1 items-center gap-2 rounded-lg border border-border bg-surface/70 px-3 py-1.5 text-[11px] text-muted shadow-sm backdrop-blur-md hover:border-accent/50 hover:text-foreground"
            >
              <Search className="h-3 w-3" />
              <span className="flex-1 text-left">Search the graph…</span>
              <kbd className="rounded border border-border px-1 py-0.5 text-[9px]">⌘P</kbd>
            </button>
            <button
              type="button"
              onClick={() => setSettingsOpen(true)}
              aria-label="Settings"
              data-testid="open-settings"
              className="rounded-lg border border-border bg-surface/70 p-2 text-muted shadow-sm backdrop-blur-md hover:border-accent/50 hover:text-foreground"
            >
              <SettingsIcon className="h-3.5 w-3.5" />
            </button>
          </div>

          <CardsPanel
            cards={cards}
            activeId={activeId}
            model={model}
            changes={changes}
            changesError={changesError}
            busy={busy}
            askAvailable={askAvailable}
            error={askError}
            onActivate={activate}
            onAsk={ask}
            onRefine={refine}
            onDelete={removeCard}
            onNavigate={navigate}
            onExport={() => setFeedbackOpen(true)}
            collapsed={cardsPanelCollapsed}
            onToggleCollapsed={() => setCardsPanelCollapsed((value) => !value)}
          />

          <LegendPanel
            mode={colorMode}
            onModeChange={setColorMode}
            layers={model?.layers ?? []}
            present={colorKeys}
            onFit={() => controllerRef.current?.fitView()}
            collapsed={legendPanelCollapsed}
            onToggleCollapsed={() => setLegendPanelCollapsed((value) => !value)}
          />
        </div>
      </div>

      {/* Right column: the selection, and nothing else. */}
      {selectedNode ? (
        <div className="pointer-events-none absolute inset-y-0 right-0 flex w-[30rem] flex-col gap-3 p-4">
          <NodePanel
            key={selectedNode.id}
            node={selectedNode}
            model={model}
            detail={detailState.detail}
            loading={detailState.loading}
            error={detailState.error}
            root={status?.root ?? null}
            onNavigate={navigate}
            collapsed={nodePanelCollapsed}
            onToggleCollapsed={() => setNodePanelCollapsed((value) => !value)}
            // The node panel yields the lower half to the code — unless there
            // is no code panel up, in which case it takes the column.
            className={
              selectedNode.kind === DIRECTORY_KIND || codePanelCollapsed
                ? 'min-h-0 flex-1'
                : 'max-h-[45%] shrink-0'
            }
          />
          {selectedNode.kind === DIRECTORY_KIND ? null : (
            <CodePanel
              key={`code|${selectedNode.id}`}
              node={selectedNode}
              detail={detailState.detail}
              loading={detailState.loading}
              initialMode={activeId === CHANGES_VIEW_ID ? 'diff' : 'full'}
              collapsed={codePanelCollapsed}
              onToggleCollapsed={() => setCodePanelCollapsed((value) => !value)}
            />
          )}
        </div>
      ) : null}

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} onPick={navigate} />
      <SettingsDialog
        open={settingsOpen}
        onSortModeChange={setSortMode}
        onClose={() => {
          setSettingsOpen(false);
          void refreshSettings();
        }}
      />
      <FeedbackDialog
        open={feedbackOpen}
        onClose={() => setFeedbackOpen(false)}
        context={feedbackContext}
        summary={feedbackSummary}
        selected={feedbackSelected}
        resultNodes={feedbackResultNodes}
        projectName={status?.projectName}
      />
    </div>
  );
}

/** A node as the feedback export cites it (`path:start-end`). */
function describeForFeedback(model: GraphModel | null, id: string): FeedbackNode | null {
  const node = model?.get(id);
  if (!node) return null;
  return {
    id: node.id,
    name: node.name,
    kind: node.kind,
    file: node.file,
    startLine: node.startLine,
    endLine: node.endLine,
  };
}

function changesSummaryText(activeId: string, changes: ChangesPayload | null): string | undefined {
  if (activeId !== CHANGES_VIEW_ID || !changes) return undefined;
  return `${changes.changedFiles.length} changed file(s), ${changes.changedNodes.length} changed symbol(s), ${changes.impactedNodeIds.length} impacted.`;
}
