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
 *    cards. Activating one selects nothing, glows the result (dimming the rest)
 *    and bundles the result's edges. **A view is a highlighter and never moves
 *    the camera** (phase G3): no fit, no pan, no zoom, no re-root — switching
 *    views changes what is lit, never where you are standing.
 *  - **Changes.** `GET /api/changes` refreshed whenever `dataVersion` moves
 *    while the view is active — changed arcs wear a hot rim, impacted ones a
 *    warm one, and a node opened from here shows its diff first.
 *  - **Feedback export.** The active view plus the current selection, rendered
 *    as markdown to paste into an agent prompt.
 *  - **URL = state.** Current root, SELECTION, active card, colour mode and
 *    edge toggles live in the hash (see `lib/url-state.ts`), restored on load.
 *    A phase D link carrying an expansion set still opens — it re-roots to what
 *    those ids have in common.
 *  - **URL = history** (round 3). Navigation — selecting, clearing the
 *    selection, re-rooting, switching card — is written with `pushState`, so
 *    the browser's Back/Forward walk the user's own path through the graph;
 *    camera and colour changes only ever `replaceState`. `popstate` applies the
 *    whole hash back onto the canvas without writing anything itself.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { CommandPalette } from '@/components/command-palette';
import { HelpOverlay } from '@/components/help-overlay';
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
import type {
  CanvasController,
  ChangeMarker,
  StoredWorkspace,
  ViewSummary,
} from '@/graph/canvas-controller';
import { DIRECTORY_KIND, type GraphModel, type ModelNode } from '@/graph/model';
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
import { readPref, useStoredState, writePref } from '@/lib/prefs';
import { decodeUrlState, encodeUrlState, type UrlState } from '@/lib/url-state';

export default function App() {
  const { status, model, error, indexing, indexLog, runIndex } = useGraphData();
  const controllerRef = useRef<CanvasController | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);

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
  /**
   * Width of the right-hand column, dragged by the handle on its inner edge.
   *
   * How much room the code deserves against how much of the disk stays visible
   * is a per-person, per-screen trade, so it is a stored preference rather than
   * a constant — and it is `localStorage`, not the URL (it describes this
   * browser, not the view a link would share) and not `~/.codegraph/ui.json`
   * (which the server would have to be written to on every drag).
   */
  const [rightWidth, setRightWidth] = useStoredState(
    'rightColumnWidth',
    RIGHT_COLUMN_DEFAULT,
    clampColumnWidth
  );
  // …and so do the two LEFT-hand panels (round 2): the disk is the app, and
  // both columns should be able to get out of its way with the same gesture.
  const [cardsPanelCollapsed, setCardsPanelCollapsed] = useState(false);
  const [legendPanelCollapsed, setLegendPanelCollapsed] = useState(false);
  /** Colour keys currently on the disk — the LEGEND's only input. */
  const [colorKeys, setColorKeys] = useState<string[]>([]);
  const colorKeysRef = useRef('');
  /**
   * Legend categories switched off (round 4). Deliberately SESSION state, not
   * URL state: hiding a kind is how you are reading the disk this minute, not
   * the view you would send someone — the same reasoning that keeps the sort
   * mode in settings rather than the hash.
   */
  const [hiddenColorKeys, setHiddenColorKeys] = useState<string[]>([]);
  /** The node IMPACT mode is showing dependents of, if any. */
  const [impactNodeId, setImpactNodeId] = useState<string | null>(null);

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
  const modelRef = useRef(model);
  modelRef.current = model;
  const selectedRef = useRef(selectedNode);
  selectedRef.current = selectedNode;
  const colorModeRef = useRef(colorMode);
  colorModeRef.current = colorMode;
  /** True once the hash has been read — nothing is written before that. */
  const restoredRef = useRef(false);
  const restoreStarted = useRef(false);
  const urlTimer = useRef<number | null>(null);
  /** What the hash currently says — every write is diffed against it. */
  const lastHashRef = useRef<HashState | null>(null);
  /** Project whose stored workspace has already been put back on the canvas. */
  const workspaceRestored = useRef<string | null>(null);
  const workspaceTimer = useRef<number | null>(null);

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

  /** Changes are re-read whenever the index moves — see the effect below. */
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

  /** The markers themselves: file node id → share of its lines added/removed. */
  useEffect(() => {
    controllerRef.current?.setChangeMarkers(changeMarkers(changes, model));
  }, [changes, model]);

  useEffect(() => {
    controllerRef.current?.setHiddenColorKeys(hiddenColorKeys);
  }, [hiddenColorKeys]);

  /**
   * IMPACT mode. The closure is computed **client-side**: the model already
   * holds every non-`contains` edge indexed by node (`edgesOf`), so walking
   * incoming edges outward is a local graph walk — no request, no latency, and
   * no second source of truth to disagree with the disk. (`/api/changes` runs
   * the server's own `getImpactRadius`, but that is depth-2 and seeded from a
   * whole changeset; this question is "everything that transitively depends on
   * THIS", which is a different walk.)
   */
  useEffect(() => {
    const controller = controllerRef.current;
    if (!controller) return;
    if (!impactNodeId || !model) {
      controller.setImpact(null);
      return;
    }
    controller.setImpact(impactClosure(model, impactNodeId));
  }, [impactNodeId, model]);

  // --------------------------------------------------------------- cards ---

  const persist = useCallback((next: Card[]) => {
    setCards(next);
    void saveCards(next).catch(() => {
      /* the card still works this session even if the write failed */
    });
  }, []);

  /**
   * Put a card's answer on the disk: glow the results and bundle their edges.
   *
   * **A view is a HIGHLIGHTER — it never moves the camera** (phase G3). No fit,
   * no pan, no zoom, no re-root, no reveal, in either direction: switching
   * between Project, a question card and Changes changes what is lit and what
   * is dimmed, and nothing else. It used to re-root onto the deepest node
   * containing the whole answer, which yanked the picture out from under
   * whatever the user was reading — and the answer is usually spread wide
   * enough that the re-root landed on the project root anyway. Clicking an
   * individual symbol INSIDE a card still reveals it: that is an explicit
   * navigation act, and the only one here.
   */
  const applyResult = useCallback(
    (result: ExploreResult | undefined) => {
      const controller = controllerRef.current;
      if (!controller || !model) return;
      const ids = result?.nodeIds ?? [];
      controller.setHighlight({ nodes: ids, edges: result?.edgeRefs ?? [] });
      controller.setSelected(null);
      setSelectedNode(null);
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
    },
    [model]
  );

  const activate = useCallback(
    (id: string) => {
      setActiveId(id);
      const controller = controllerRef.current;
      if (!controller || !model) return;

      if (id === PROJECT_VIEW_ID) {
        // Project is "no highlight", not "go home": the camera and the root
        // stay exactly where the user left them.
        controller.setHighlight(null);
        controller.setSelected(null);
        setSelectedNode(null);
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
   * Changes are read for EVERY view now, not just the Changes card (round 4):
   * the disk carries a permanent added/removed marker on each changed file, so
   * the payload is part of the normal picture rather than a mode. It is one git
   * call against the working tree, refreshed on the contract's `dataVersion`
   * signal, and it only ever touches files that actually changed.
   */
  useEffect(() => {
    if (!status?.indexed) return;
    void loadChanges().then((payload) => {
      if (payload && activeRef.current === CHANGES_VIEW_ID) applyChanges(payload);
    });
  }, [status?.indexed, status?.dataVersion, loadChanges, applyChanges]);

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

  /**
   * Debounced hash write. The debounce is also the history's coalescer: a
   * re-root that moves the selection with it is one entry, not two.
   *
   * **Navigation pushes, everything else replaces.** Root, selection and the
   * active card are places you can go Back to; the camera (pan / zoom / fit)
   * and the colour mode are how you are looking at the place you are already
   * in, and one history entry per wheel notch would make Back useless. A hover
   * changes neither, so it never writes at all — and an identical state is
   * dropped before it can become a duplicate entry.
   */
  const scheduleUrlUpdate = useCallback(() => {
    if (!restoredRef.current) return;
    if (urlTimer.current !== null) window.clearTimeout(urlTimer.current);
    urlTimer.current = window.setTimeout(() => {
      urlTimer.current = null;
      const controller = controllerRef.current;
      if (!controller) return;
      const next: HashState = {
        root: controller.getRoot(),
        selection: selectedRef.current?.id ?? null,
        cardId: activeRef.current,
        colorMode: colorModeRef.current,
        edgeKinds: controller.enabledEdgeKinds(),
      };
      const previous = lastHashRef.current;
      if (previous && sameHashState(previous, next)) return;
      const navigational =
        !previous ||
        previous.root !== next.root ||
        previous.selection !== next.selection ||
        previous.cardId !== next.cardId;
      lastHashRef.current = next;
      void encodeUrlState(next).then((hash) => {
        // The FIRST write of a session replaces: the entry the browser already
        // has for this page is the one the user arrived on.
        if (navigational && previous) window.history.pushState(null, '', hash);
        else window.history.replaceState(null, '', hash);
      });
    }, 300);
  }, []);

  /**
   * Put a decoded hash back on screen — the ONE place a URL becomes a view.
   *
   * Used by the initial restore and by Back/Forward alike, which is the point:
   * a history entry is just a hash, so applying one must not be a special case.
   * It records what it applied in `lastHashRef`, so the writes that every
   * setter below schedules find nothing to say and no entry is pushed for a
   * navigation the browser already performed.
   */
  const applyUrlState = useCallback(
    (state: UrlState) => {
      const controller = controllerRef.current;
      if (!controller) return;
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
        controller.setHighlight(result ? { nodes: result.nodeIds, edges: result.edgeRefs } : null);
      } else {
        controller.setHighlight(null);
      }

      // A phase E link names its root outright; a phase D one carries the old
      // expansion set, which `setExpanded` translates into the closest root.
      if (state.root) controller.setRoot(state.root, false);
      else if (state.legacyExpanded.length > 0) controller.setExpanded(state.legacyExpanded);

      const selected = state.selection ? (modelRef.current?.get(state.selection) ?? null) : null;
      controller.setSelected(selected?.id ?? null);
      setSelectedNode(selected);

      lastHashRef.current = {
        root: controller.getRoot(),
        selection: selected?.id ?? null,
        cardId,
        colorMode: state.colorMode,
        edgeKinds: controller.enabledEdgeKinds(),
      };
    },
    [loadChanges]
  );

  /** Restore once, as soon as there is a model to restore INTO. */
  useEffect(() => {
    if (restoreStarted.current || !model) return;
    restoreStarted.current = true;
    void decodeUrlState(window.location.hash).then((state) => {
      if (state) applyUrlState(state);
      // Only now may anything be written — a write racing the restore would
      // push the DEFAULT view over the one the link asked for.
      restoredRef.current = true;
      scheduleUrlUpdate();
    });
  }, [model, applyUrlState, scheduleUrlUpdate]);

  useEffect(() => {
    scheduleUrlUpdate();
  }, [activeId, colorMode, selectedNode, scheduleUrlUpdate]);

  /**
   * Back / Forward. The hash IS the state, so the handler simply applies it —
   * and cancels any write still in flight, which would otherwise land a moment
   * later and overwrite the entry the user just navigated to.
   */
  useEffect(() => {
    const onPopState = (): void => {
      if (urlTimer.current !== null) {
        window.clearTimeout(urlTimer.current);
        urlTimer.current = null;
      }
      void decodeUrlState(window.location.hash).then((state) => {
        if (state) applyUrlState(state);
      });
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [applyUrlState]);

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

  // ----------------------------------------------------------- workspace ---

  /**
   * Which disks are open and where they sit, remembered per project.
   *
   * A refresh used to throw the whole workspace away — every disk the user had
   * dragged out, and the arrangement they had put them in, which is real work.
   * It is `localStorage` and not the URL for the same reason the panel widths
   * are: it describes THIS browser's arrangement, not the view a link shares,
   * and the hash still owns (and on any conflict wins) the primary disk's root,
   * selection and camera. The write is debounced, because dragging a disk moves
   * it on every pointer frame.
   */
  const persistWorkspace = useCallback(
    (workspace: StoredWorkspace) => {
      const project = modelRef.current?.root;
      // Nothing is stored before the restore has run: an empty workspace
      // reported during startup would otherwise erase the stored one.
      if (!project || workspaceRestored.current !== project) return;
      if (workspaceTimer.current !== null) window.clearTimeout(workspaceTimer.current);
      workspaceTimer.current = window.setTimeout(() => {
        workspaceTimer.current = null;
        writePref(workspaceKey(project), workspace);
      }, WORKSPACE_WRITE_MS);
    },
    []
  );

  /** Put the stored workspace back, once, as soon as there is a model. */
  useEffect(() => {
    const controller = controllerRef.current;
    if (!controller || !model) return;
    if (workspaceRestored.current === model.root) return;
    workspaceRestored.current = model.root;
    const stored = readPref<StoredWorkspace | null>(workspaceKey(model.root), null);
    if (stored && Array.isArray(stored.disks)) controller.restoreWorkspace(stored);
  }, [model]);

  useEffect(
    () => () => {
      if (workspaceTimer.current !== null) window.clearTimeout(workspaceTimer.current);
    },
    []
  );

  // ------------------------------------------------------------ commands ---

  /**
   * Drag the right column's inner edge.
   *
   * The pointer is captured for the whole gesture, so the drag survives the
   * cursor crossing the canvas (which has its own pointer handlers) and a
   * release outside the window. Width follows the cursor directly — there is no
   * transition anywhere in this DOM, and a resize handle that lags is a resize
   * handle that feels broken.
   */
  const startColumnResize = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      event.preventDefault();
      const handle = event.currentTarget;
      handle.setPointerCapture(event.pointerId);
      const onMove = (move: PointerEvent): void => {
        setRightWidth(window.innerWidth - move.clientX);
      };
      const onUp = (): void => {
        handle.removeEventListener('pointermove', onMove);
        handle.removeEventListener('pointerup', onUp);
        handle.removeEventListener('pointercancel', onUp);
      };
      handle.addEventListener('pointermove', onMove);
      handle.addEventListener('pointerup', onUp);
      handle.addEventListener('pointercancel', onUp);
    },
    [setRightWidth]
  );

  /** A stored width has to stay legal when the window shrinks under it. */
  useEffect(() => {
    const onResize = (): void => setRightWidth((width) => width);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [setRightWidth]);

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

      if (event.key === 'Escape') {
        if (paletteOpen) {
          event.preventDefault();
          setPaletteOpen(false);
          return;
        }
        if (helpOpen) {
          event.preventDefault();
          setHelpOpen(false);
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
        return;
      }

      // Arrow navigation belongs to the DISK, so it stands down whenever
      // something else owns the keyboard: a dialog, or a field being typed in.
      if (paletteOpen || settingsOpen || feedbackOpen || helpOpen) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (isTypingTarget(event.target)) return;

      const move = ARROW_MOVES[event.key];
      if (move) {
        event.preventDefault();
        controllerRef.current?.moveSelection(move);
        return;
      }
      if (event.key === 'Enter') {
        event.preventDefault();
        controllerRef.current?.enterSelected();
        return;
      }
      // Backspace steps the FOCUSED disk one level out — the keyboard twin of
      // clicking its centre circle, and the way back from an Enter that drilled
      // in. It stands down under exactly the same conditions the arrows do (a
      // dialog up, a field being typed in), which is also what keeps it from
      // fighting a text field for the delete key.
      if (event.key === 'Backspace') {
        event.preventDefault();
        controllerRef.current?.rootUp();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    paletteOpen,
    settingsOpen,
    feedbackOpen,
    helpOpen,
    selectedNode,
    clearSelection,
    refreshSettings,
  ]);

  /** A different node is a different question — impact mode never carries over. */
  useEffect(() => {
    setImpactNodeId(null);
  }, [selectedNode?.id]);

  /** Select a node and bring it on screen — used by the palette and the panel. */
  const navigate = useCallback((id: string) => {
    controllerRef.current?.reveal(id);
  }, []);

  /**
   * The ⌘P landing. Same reveal, plus a short PULSE on the wedge it lands on:
   * a re-root can move the whole picture, and "which of these 300 arcs did I
   * just ask for" is a question the user should not have to answer by reading.
   */
  const navigateFromSearch = useCallback((id: string) => {
    controllerRef.current?.reveal(id, true);
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
        onWorkspaceChange={persistWorkspace}
        onController={(controller) => {
          controllerRef.current = controller;
        }}
        onSelect={setSelectedNode}
      />

      {/* Left column: everything you DRIVE the disk with. */}
      <div className="pointer-events-none absolute inset-y-0 left-0 p-4">
        <div className="flex max-h-full w-[22rem] flex-col gap-3">
          {/* Search (⌘P) and settings are icon buttons in the CODEGRAPH panel's
              own title bar now (round 3) — one header instead of a header plus
              a row of chrome under it. */}
          <StatusPanel
            status={status}
            error={error}
            indexing={indexing}
            indexLog={indexLog}
            onIndex={() => void runIndex()}
            onOpenPalette={() => setPaletteOpen(true)}
            onOpenSettings={() => setSettingsOpen(true)}
            onOpenHelp={() => setHelpOpen(true)}
          />

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
            hidden={hiddenColorKeys}
            onToggleKey={(key) =>
              setHiddenColorKeys((keys) =>
                keys.includes(key) ? keys.filter((entry) => entry !== key) : [...keys, key]
              )
            }
            onFit={() => controllerRef.current?.fitView()}
            collapsed={legendPanelCollapsed}
            onToggleCollapsed={() => setLegendPanelCollapsed((value) => !value)}
          />
        </div>
      </div>

      {/* Right column: the selection, and nothing else. */}
      {selectedNode ? (
        <div
          className="pointer-events-none absolute inset-y-0 right-0 flex flex-col gap-3 p-4"
          style={{ width: `${rightWidth}px` }}
        >
          {/* The column's inner edge is the handle — no separate gutter to
              find, and nothing moves until it is dragged. */}
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize panel column"
            data-testid="right-column-resize"
            onPointerDown={startColumnResize}
            className="pointer-events-auto absolute inset-y-0 left-0 z-10 w-1.5 cursor-col-resize bg-transparent hover:bg-accent/40"
          />
          <NodePanel
            key={selectedNode.id}
            node={selectedNode}
            model={model}
            detail={detailState.detail}
            loading={detailState.loading}
            error={detailState.error}
            root={status?.root ?? null}
            onNavigate={navigate}
            impact={impactNodeId === selectedNode.id}
            onToggleImpact={() =>
              setImpactNodeId((current) => (current === selectedNode.id ? null : selectedNode.id))
            }
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

      <CommandPalette
        open={paletteOpen}
        model={model}
        onClose={() => setPaletteOpen(false)}
        onPick={navigateFromSearch}
      />
      <HelpOverlay open={helpOpen} onClose={() => setHelpOpen(false)} />
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

/**
 * The hash's payload as the shell holds it — what a write is diffed against.
 *
 * Deliberately the same fields `encodeUrlState` takes, so "did anything change"
 * and "what do we write" can never drift apart.
 */
interface HashState {
  root: string | null;
  selection: string | null;
  cardId: string | null;
  colorMode: ColorMode;
  edgeKinds: string[];
}

/** Identical state = no history entry (and no write at all). */
function sameHashState(a: HashState, b: HashState): boolean {
  return (
    a.root === b.root &&
    a.selection === b.selection &&
    a.cardId === b.cardId &&
    a.colorMode === b.colorMode &&
    a.edgeKinds.length === b.edgeKinds.length &&
    a.edgeKinds.every((kind, index) => kind === b.edgeKinds[index])
  );
}

/** How long the workspace has to sit still before it is written down. */
const WORKSPACE_WRITE_MS = 300;

/**
 * Where one project's workspace is stored.
 *
 * The project's absolute root path is the identity the client already has (it
 * is what `/api/graph` reports), but it is not a key: it is long and full of
 * separators. It is hashed instead, so the key is short, stable and opaque —
 * and two projects can never collide into one arrangement.
 *
 * This is the whole reason `codegraph ui` can be stopped in one folder and
 * started in another on the same port without the second project inheriting
 * the first one's disks and bubbles: every project has its own key, and a
 * stored arrangement that names nodes this project does not have is dropped
 * disk by disk and bubble by bubble on restore (`restoreWorkspace`) rather
 * than restored broken. What made the swap look broken anyway was the graph
 * itself being served out of the browser's cache — fixed on the server, where
 * the `/api/graph` validator now names the project as well as its version.
 */
function workspaceKey(root: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < root.length; i++) {
    hash ^= root.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `workspace.${(hash >>> 0).toString(36)}`;
}

/** Right column: the phase F width, still the default. */
const RIGHT_COLUMN_DEFAULT = 480;
/** Narrower than this and a diff line is no longer worth reading. */
const RIGHT_COLUMN_MIN = 320;
/** The disk is the app: the column never takes more than this of the window. */
const RIGHT_COLUMN_MAX_SHARE = 0.6;

/** A column width the current viewport can actually hold. */
function clampColumnWidth(width: number): number {
  const viewport = typeof window === 'undefined' ? Infinity : window.innerWidth;
  const max = Math.max(RIGHT_COLUMN_MIN, viewport * RIGHT_COLUMN_MAX_SHARE);
  return Math.round(Math.min(max, Math.max(RIGHT_COLUMN_MIN, width)));
}

/** Arrow key → the move it makes on the disk. */
const ARROW_MOVES: Record<string, 'prev' | 'next' | 'up' | 'down'> = {
  ArrowLeft: 'prev',
  ArrowRight: 'next',
  ArrowUp: 'up',
  ArrowDown: 'down',
};

/** Is the keyboard currently owned by a field the user is typing into? */
function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

/** Nodes walked before an impact closure gives up and reports what it has. */
const IMPACT_CAP = 4000;

/**
 * The selected node and everything that TRANSITIVELY depends on it.
 *
 * Dependents are found by walking edges BACKWARDS — an edge's source depends on
 * its target — from the node and (for a file or a class) everything it
 * contains, because "what breaks if I change this file" means the callers of
 * the symbols in it. `contains` is not in the edge set at all, so the walk can
 * only ever follow real relations. Capped, like every other traversal here: an
 * unbounded closure on a project root would light the entire disk, which is the
 * same as lighting none of it.
 */
function impactClosure(model: GraphModel, id: string): string[] {
  const seen = new Set<string>([id]);
  for (const descendant of model.descendants(id)) {
    if (seen.size >= IMPACT_CAP) break;
    seen.add(descendant);
  }
  const stack = [...seen];
  while (stack.length > 0 && seen.size < IMPACT_CAP) {
    const current = stack.pop()!;
    for (const edge of model.edgesOf(current)) {
      if (edge.target !== current || edge.source === current) continue;
      if (seen.has(edge.source)) continue;
      seen.add(edge.source);
      stack.push(edge.source);
    }
  }
  return [...seen];
}

/**
 * Change markers: for every changed file the index still knows, the share of
 * its own lines that were added and removed (each clamped to 1, since a file
 * can gain more lines than it currently has).
 *
 * The two counts come from the PAYLOAD (`addedLines` / `removedLines`), not
 * from adding up `hunks`: the server counts every hunk of the file, including
 * the ones its own caps dropped from the response, so a huge rewrite is
 * reported as a huge rewrite instead of as the prefix that fitted.
 */
function changeMarkers(
  changes: ChangesPayload | null,
  model: GraphModel | null
): Array<[string, ChangeMarker]> {
  if (!changes || !model) return [];
  const markers: Array<[string, ChangeMarker]> = [];
  for (const file of changes.changedFiles) {
    if (!file.nodeId) continue;
    const node = model.get(file.nodeId);
    if (!node) continue;
    const added = file.addedLines ?? 0;
    const removed = file.removedLines ?? 0;
    if (added === 0 && removed === 0) continue;
    const loc = Math.max(1, node.weight);
    markers.push([
      file.nodeId,
      { added: Math.min(1, added / loc), removed: Math.min(1, removed / loc) },
    ]);
  }
  return markers;
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
