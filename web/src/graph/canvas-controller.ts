/**
 * The sunburst canvas: everything imperative about the graph view.
 *
 * React owns the floating panels; this class owns one `<canvas>` and draws the
 * whole disk into it with the 2D context. There is **no simulation** — the
 * layout is a pure function of (model, current root), so a redraw is a redraw
 * and nothing on screen ever drifts. That is the point: the force layout this
 * replaced was spatially unstable, which made a 13k-node project unreadable.
 *
 * What lives here:
 *
 *  - the current **root** (the centre of the disk) and the layout computed from
 *    it (`sunburst.ts`);
 *  - painting: arcs, rims, curved labels, the centre disk, bundled edges;
 *  - hit testing (ring-indexed for arcs, polyline distance for edges);
 *  - navigation: click a directory to re-root, click the centre to go up,
 *    double-click anything to drill into it, `reveal(id)` for ⌘P;
 *  - the persistent highlight a card / the Changes view drives.
 *
 * Edges are **hidden at rest**. They appear for the hovered arc's subtree, the
 * current selection, or the active card's `edgeRefs` — bundled along the
 * hierarchy so a hundred relations read as one rope (`bundling.ts`).
 */
import { formatNumber } from '@/lib/utils';

import {
  bundleControlPoints,
  bundleCurve,
  distanceToPolyline,
} from './bundling';
import { DIRECTORY_KIND, ROOT_ID, type GraphModel, type ModelEdge, type ModelNode } from './model';
import {
  DIRECTORY_LEGEND_KEY,
  colorForEdgeDirection,
  colorForNode,
  type ColorMode,
  type EdgeDirection,
} from './palette';
import {
  AGGREGATE_KIND,
  DEFAULT_SORT_MODE,
  MAX_ARCS,
  MAX_RADIUS,
  arcAt,
  computeSunburst,
  deepestCommonAncestor,
  initialRoot,
  type Point,
  type SortMode,
  type SunburstArc,
  type SunburstLayout,
} from './sunburst';

export interface BreadcrumbEntry {
  id: string;
  name: string;
}

export interface ViewSummary {
  /** Arcs currently rendered. */
  arcs: number;
  /** Rings rendered outward from the current root. */
  rings: number;
  /** True when depth, budget or the sliver floor folded something away. */
  truncated: boolean;
  /** Bundled relations currently drawn (0 at rest — edges are on demand). */
  visibleEdges: number;
  /** Kinds (or layers) present in the disk — drives the legend. */
  presentColorKeys: string[];
  /** Every non-`contains` kind in the graph, contract kinds first. */
  edgeKinds: string[];
  /** The subset currently drawable — the controller owns this, not React. */
  enabledKinds: string[];
  /** Project root → … → current root. */
  breadcrumb: BreadcrumbEntry[];
  zoom: number;
}

/** Hover readout for an arc: what it is, how big, and what it hides. */
export interface ArcTooltip {
  x: number;
  y: number;
  name: string;
  path: string;
  kind: string;
  layer?: string;
  /** LoC for directories and files, span length for symbols. */
  loc: number;
  aggregate: boolean;
  hiddenChildren: number;
}

/**
 * What a card (or the Changes view) asks the canvas to light up.
 *
 * Three independent channels because they answer different questions and are
 * shown at once: `nodes`/`edges` are "the answer to this question", `changed`
 * is "you edited this", `impacted` is "this depends on what you edited".
 */
export interface CanvasHighlight {
  /** Result nodes of a card — glowed, everything else dimmed. */
  nodes?: Iterable<string>;
  /** Result edges, matched to model edges by (source, target, kind). */
  edges?: Iterable<{ source: string; target: string; kind: string }>;
  /** Nodes with uncommitted edits — hot rim. */
  changed?: Iterable<string>;
  /** Nodes within the impact radius of a change — warm rim. */
  impacted?: Iterable<string>;
}

export interface CanvasCallbacks {
  onSelect(node: ModelNode | null): void;
  onViewChange(summary: ViewSummary): void;
  /**
   * Tooltips are for WEDGES ONLY (phase F). An edge never raises one: a rope of
   * bundled curves put a tooltip under the pointer everywhere the user was
   * trying to aim at an arc, and the edge's own information (kind, provenance,
   * wiring site) belongs to the node panel, which has room for it.
   */
  onArcTooltip(tooltip: ArcTooltip | null): void;
}

// ------------------------------------------------------------- constants ---

/** Widest the disk is allowed to grow, and the gutter the panels occupy. */
const VIEW_PADDING = 36;
const PANEL_GUTTER = 372;
const GUTTER_MIN_WIDTH = 900;

const ZOOM_MIN = 0.5;
const ZOOM_MAX = 8;

/** Re-root transition. Short on purpose: navigation, not decoration. */
const TRANSITION_MS = 260;

/** Relations assembled for one hover / selection / card. */
const EDGE_BUDGET = 500;
/** Nodes walked when collecting a subtree's relations. */
const NODE_SCAN_CAP = 4000;

/** Pointer slop before a drag stops counting as a click. */
const DRAG_SLOP = 4;

/** Arc must be this long (screen px) before it earns a curved label. */
const LABEL_MIN_ARC_PX = 38;
const LABEL_MIN_THICKNESS_PX = 11;
/** A truncation that leaves fewer than this many characters is not a label. */
const LABEL_MIN_CHARS = 5;

/**
 * RADIAL layout: the name runs along the RADIUS — out from the centre through
 * the wedge's angular bisector, flipped 180° on the left half of the disk so it
 * is never upside down (the standard sunburst convention).
 *
 * As of round 3 this is not a *fallback* but one of two orientations, picked by
 * whichever of the wedge's two extents is longer (see `drawArcLabel`); the
 * other orientation is still tried when the picked one cannot fit a name.
 *
 * Which is why the room the text has is the wedge's own geometry with the axes
 * swapped from the curved case: the **radial depth** (`r1 - r0`) is the line
 * LENGTH, the **angular chord at the centroid** is its HEIGHT. Both gates are
 * checked before any `measureText`, and a fit that leaves fewer than
 * {@link RLABEL_MIN_CHARS} characters (ellipsis included) is dropped: three
 * letters name something, one plus a dot names nothing.
 *
 * (Round 1 drew this fallback screen-horizontally through the centroid, which
 * scattered text across the disk at every angle and collided with neighbours.
 * Radial text is why files and symbols now get the deeper wedge — see
 * `depthFactor` — the depth IS the label's room.)
 */
const RLABEL_MIN_LENGTH_PX = 18;
const RLABEL_MIN_HEIGHT_PX = 8;
const RLABEL_MIN_CHARS = 4;
const RLABEL_MAX_FONT_PX = 12;

/**
 * How long the camera must sit still before the full label pass runs again.
 *
 * Zooming used to re-run the whole label layout on every frame — an orientation
 * choice plus one `measureText` per candidate arc per tick — which is what made
 * a zoom gesture judder the moment labels came into range. While the camera is
 * moving the painter now replays the LAST plan through cheap arithmetic gates
 * only (no `measureText`, no font assignment), and the real pass runs once the
 * gesture stops. At rest the output is byte-identical to the old path.
 */
const LABEL_SETTLE_MS = 100;

/** ⌘P reveal pulse: three gentle breaths on the wedge the user landed on. */
const PULSE_MS = 1000;
const PULSE_CYCLES = 3;

/**
 * Change markers: two thin bars on the OUTER rim of a changed file's wedge.
 *
 * Stacked radially — green (added) outermost, red (removed) directly inside it
 * — rather than side by side angularly, because the angle already means "how
 * much code is here" and re-using it for "how much changed" would make a small
 * heavily-edited file read as a big one. Each bar's LENGTH along the arc is the
 * share of the file's lines it accounts for, so the pair reads as two little
 * progress bars against the wedge they sit on.
 */
const MARKER_MAX_THICKNESS = 2.4;
const MARKER_DEPTH_SHARE = 0.12;
const MARKER_ADDED = '#4ade80';
const MARKER_REMOVED = '#f87171';

/** Opacity multiplier for anything the current focus dims. */
const DIM_ALPHA = 0.26;
/** Dimmed wedges keep their labels — quieter, but still readable. */
const DIM_LABEL_COLOR = 'rgba(226, 232, 240, 0.62)';

const BACKGROUND = '#080b12';
const AGGREGATE_FILL = '#46516a';
const RIM_CHANGED = '#f87171';
const RIM_IMPACTED = '#fbbf24';
const GLOW_RESULT = '#67e8f9';
const CENTRE_FILL = 'rgba(24, 33, 52, 0.92)';
const CENTRE_STROKE = 'rgba(140, 165, 205, 0.45)';

interface DrawnEdge {
  edge: ModelEdge;
  points: Point[];
  /** Relative to the hovered / selected wedge — green in, amber out. */
  direction: EdgeDirection;
}

/**
 * Everything about a wedge a label needs that does NOT depend on the camera.
 *
 * Computed once per layout (`rebuildLayout`), never per frame: the mid angle,
 * its sine/cosine, the label radius and the wedge's two extents in LAYOUT
 * units. Multiplying by the current scale is the only per-frame arithmetic.
 */
interface ArcLabelGeom {
  arc: SunburstArc;
  mid: number;
  cos: number;
  sin: number;
  midRadius: number;
  span: number;
  /** Arc length at the label radius (`span × midRadius`), layout units. */
  tangential: number;
  /** Radial depth (`r1 − r0`), layout units. */
  radial: number;
}

/** One label, as the last full pass decided to draw it. */
interface PlannedLabel {
  geom: ArcLabelGeom;
  text: string;
  orientation: 'curved' | 'radial';
  /** Font size in SCREEN px the plan was measured at (bucketed). */
  fontPx: number;
  /** What the text measured at that size, in SCREEN px. */
  widthPx: number;
}

/** Added/removed share of a changed file's own line count, each clamped to 1. */
export interface ChangeMarker {
  added: number;
  removed: number;
}

export class CanvasController {
  private readonly container: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly callbacks: CanvasCallbacks;
  private readonly resizeObserver: ResizeObserver;

  private model: GraphModel | null = null;
  private rootId = ROOT_ID;
  private layout: SunburstLayout | null = null;

  private colorMode: ColorMode = 'kind';
  private sortMode: SortMode = DEFAULT_SORT_MODE;
  private enabledKinds = new Set<string>();

  private selected: string | null = null;
  private hoveredKey: string | null = null;
  private hoveredEdgeKey: string | null = null;

  private resultNodes = new Set<string>();
  private changedNodes = new Set<string>();
  private impactedNodes = new Set<string>();
  private resultEdges = new Set<string>();

  /**
   * The per-node IMPACT mode (round 4): a node plus everything that transitively
   * depends on it, dimming the rest exactly like a card's result does. The set
   * is computed by the shell from the model's own edges and handed over whole.
   */
  private impactModeNodes = new Set<string>();

  /** Arc keys the result/changed sets resolve to — recomputed per layout. */
  private resultArcs = new Set<string>();
  private changedArcs = new Set<string>();
  private impactedArcs = new Set<string>();
  private impactModeArcs = new Set<string>();

  /**
   * Legend categories the user switched OFF (round 4). A wedge whose colour key
   * is in here is not painted, not labelled and not hit-tested — but the LAYOUT
   * is untouched, so it keeps its angular space and nothing else moves.
   */
  private hiddenColorKeys = new Set<string>();

  /** File node id → what changed in it, for the outer-rim change markers. */
  private changeMarkers = new Map<string, ChangeMarker>();

  /** Per-layout label geometry, and the last full label pass's decisions. */
  private labelGeom: ArcLabelGeom[] = [];
  private labelPlan: PlannedLabel[] | null = null;
  /** `(font bucket, text)` → measured width in SCREEN px. */
  private readonly textWidths = new Map<string, number>();
  /** When the camera last moved — the label pass waits for this to go stale. */
  private cameraMovedAt = -Infinity;

  /** ⌘P landing pulse: which node, and when the pulse starts. */
  private pulseNodeId: string | null = null;
  private pulseStart = 0;

  /**
   * Arcs the hovered wedge is related to by an edge — `null` when nothing is
   * hovered. Non-null means the disk is dimmed down to this set, instantly:
   * connectivity is the question a hover asks, and a fade would answer it late.
   */
  private hoverConnectedArcs: Set<string> | null = null;

  private drawnEdges: DrawnEdge[] = [];
  private edgesDirty = true;
  /** Edge count the last summary reported, so a redraw doesn't re-emit. */
  private emittedEdges = -1;

  private width = 0;
  private height = 0;
  private zoom = 1;
  private panX = 0;
  private panY = 0;

  private transitionStart = 0;
  private transitionFrom = 1;
  /** When the root last changed — guards the double-click drill-in. */
  private rootChangedAt = -Infinity;
  private frame: number | null = null;
  private disposed = false;

  private dragging = false;
  private dragMoved = false;
  private dragX = 0;
  private dragY = 0;
  private suppressClick = false;

  constructor(container: HTMLElement, callbacks: CanvasCallbacks) {
    this.container = container;
    this.callbacks = callbacks;

    this.canvas = document.createElement('canvas');
    this.canvas.style.position = 'absolute';
    this.canvas.style.inset = '0';
    this.canvas.style.width = '100%';
    this.canvas.style.height = '100%';
    this.canvas.style.display = 'block';
    container.appendChild(this.canvas);

    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas context unavailable');
    this.ctx = ctx;

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();
    this.bindEvents();
  }

  // ---------------------------------------------------------------- data ---

  /**
   * Install a model. On a re-index (`sameProject`) the current root, selection
   * and zoom are preserved — liveness must not cost the user their place.
   */
  setModel(model: GraphModel, sameProject: boolean): void {
    const previous = this.model;
    this.model = model;

    if (!previous || !sameProject) {
      this.rootId = initialRoot(model);
      this.enabledKinds = new Set(model.edgeKinds);
      this.selected = null;
      this.zoom = 1;
      this.panX = 0;
      this.panY = 0;
    } else {
      if (!model.nodes.has(this.rootId)) this.rootId = initialRoot(model);
      // A brand-new edge kind arriving mid-session should be visible, not
      // silently off; kinds that vanished are simply dropped.
      const known = new Set(previous.edgeKinds);
      for (const kind of model.edgeKinds) if (!known.has(kind)) this.enabledKinds.add(kind);
      this.enabledKinds = new Set([...this.enabledKinds].filter((k) => model.edgeKinds.includes(k)));
      if (this.selected && !model.nodes.has(this.selected)) this.selected = null;
    }
    this.rebuildLayout();
  }

  setColorMode(mode: ColorMode): void {
    if (this.colorMode === mode) return;
    this.colorMode = mode;
    this.requestDraw();
    this.emitSummary();
  }

  /**
   * Sibling order on the disk. Changing it re-runs the (pure) layout — the
   * wedges keep their angles and swap places, nothing is added or removed.
   */
  setSortMode(mode: SortMode): void {
    if (this.sortMode === mode) return;
    this.sortMode = mode;
    if (this.model) this.rebuildLayout();
  }

  sortModeValue(): SortMode {
    return this.sortMode;
  }

  setEdgeKinds(kinds: Iterable<string>): void {
    this.enabledKinds = new Set(kinds);
    this.edgesDirty = true;
    this.requestDraw();
    this.emitSummary();
  }

  enabledEdgeKinds(): string[] {
    return [...this.enabledKinds];
  }

  setSelected(id: string | null): void {
    this.selected = id;
    this.edgesDirty = true;
    this.requestDraw();
  }

  /**
   * Switch legend categories off (round 4).
   *
   * "Off" means INVISIBLE, not dimmed: the wedge is not painted, carries no
   * label and no tooltip, and the pointer goes straight through it. What it
   * does NOT mean is re-laying out the disk — the wedge keeps its angular
   * space, so switching a category off never moves anything else. A filter that
   * re-flows the picture is a filter you cannot use to compare two states.
   */
  setHiddenColorKeys(keys: Iterable<string>): void {
    const next = new Set(keys);
    if (next.size === this.hiddenColorKeys.size && [...next].every((k) => this.hiddenColorKeys.has(k))) {
      return;
    }
    this.hiddenColorKeys = next;
    this.labelPlan = null;
    this.requestDraw();
  }

  /**
   * Uncommitted-change markers, keyed by FILE node id (round 4).
   *
   * Always on in the normal view — it costs two thin bars on the handful of
   * wedges that actually changed, and "what have I touched" is the question a
   * developer opens this UI with more often than any other.
   */
  setChangeMarkers(markers: Iterable<[string, ChangeMarker]>): void {
    this.changeMarkers = new Map(markers);
    this.requestDraw();
  }

  /**
   * Per-node IMPACT mode: light `ids` (the node and its transitive dependents)
   * and dim everything else. `null` clears it.
   */
  setImpact(ids: Iterable<string> | null): void {
    const model = this.model;
    const next = new Set<string>();
    for (const id of ids ?? []) if (!model || model.nodes.has(id)) next.add(id);
    this.impactModeNodes = next;
    this.projectHighlight();
    this.edgesDirty = true;
    this.requestDraw();
  }

  // ---------------------------------------------------------- navigation ---

  getRoot(): string {
    return this.rootId;
  }

  /**
   * Re-root the disk. The centre becomes `id`, rings grow outward from it.
   *
   * A node with no children can still be the root — the centre disk names it —
   * which is what makes `reveal` able to land on any node in the graph.
   */
  setRoot(id: string, animate = true): void {
    const model = this.model;
    if (!model || !model.nodes.has(id) || id === this.rootId) return;
    const previousDepth = model.get(this.rootId)?.depth ?? 0;
    const nextDepth = model.get(id)?.depth ?? 0;
    this.rootId = id;
    this.rootChangedAt = performance.now();
    this.zoom = 1;
    this.panX = 0;
    this.panY = 0;
    this.hoveredKey = null;
    this.hoveredEdgeKey = null;
    this.hoverConnectedArcs = null;
    this.callbacks.onArcTooltip(null);
    if (animate) {
      // Drilling in starts wide and settles; stepping out starts small and
      // grows. Both are pure opacity + scale on a layout that never moves.
      this.transitionFrom = nextDepth > previousDepth ? 1.28 : 0.78;
      this.transitionStart = performance.now();
    }
    this.rebuildLayout();
  }

  /** Step one level out — the centre circle and the breadcrumb both do this. */
  rootUp(): void {
    const parent = this.model?.get(this.rootId)?.parent;
    if (parent) this.setRoot(parent);
  }

  /**
   * Re-root onto a result set — what a card (or the Changes view) does.
   *
   * The disk lands on the deepest node that contains every result, so a card
   * answering inside one file opens that file's symbol ring and a card spread
   * across the project stays at the project root.
   */
  focusNodes(ids: Iterable<string>): void {
    const model = this.model;
    if (!model) return;
    const wanted = [...ids].filter((id) => model.nodes.has(id));
    if (wanted.length === 0) return;
    const target = deepestCommonAncestor(model, wanted);
    if (target === this.rootId) {
      this.rebuildLayout();
      return;
    }
    this.setRoot(target);
  }

  /**
   * Select a node and bring its arc on screen — the ⌘P landing.
   *
   * "Visible" means an arc actually exists for it. Re-rooting to its parent is
   * the normal answer, but a node can still be swallowed by its parent's
   * `+N` fold arc (a directory of 900 files), so the fallback re-roots onto
   * the node ITSELF: the centre disk always renders the root, so ⌘P can reach
   * anything in the graph.
   */
  reveal(id: string, pulse = false): boolean {
    const model = this.model;
    if (!model) return false;
    const node = model.get(id);
    if (!node) return false;

    const parent = node.parent;
    if (parent && parent !== this.rootId) this.setRoot(parent);
    if (!this.layout || (!this.layout.byNode.has(id) && this.rootId !== id)) {
      this.setRoot(id);
    }

    this.selected = id;
    if (pulse) {
      // The pulse only means anything once the wedge is where it is going to
      // stay, so it starts when the re-root transition ENDS (immediately when
      // there was no re-root to make).
      this.pulseNodeId = id;
      this.pulseStart =
        this.transitionStart > 0 ? this.transitionStart + TRANSITION_MS : performance.now();
    }
    this.edgesDirty = true;
    this.requestDraw();
    this.callbacks.onSelect(node);
    return true;
  }

  /**
   * Arrow-key navigation over the disk (round 4).
   *
   * The disk is a tree drawn as rings, so the four directions read off the
   * geometry directly: left/right walk the SIBLINGS in display order (the order
   * they are drawn around the ring, which is the sort mode's order), up is the
   * containing wedge, down is the first child. Left/right wrap, because a ring
   * is a circle and stopping at "the last one" is an arbitrary place to stop.
   *
   * With nothing selected, any direction lands on the first wedge of ring 1 —
   * the keyboard must have a way in that does not require a click first.
   */
  moveSelection(direction: 'prev' | 'next' | 'up' | 'down'): boolean {
    const layout = this.layout;
    const model = this.model;
    if (!layout || !model) return false;

    const current = this.selected ? layout.byNode.get(this.selected) : undefined;
    if (!current) {
      const first = this.visibleRing(1)[0];
      return first ? this.selectArc(first) : false;
    }

    if (direction === 'up') {
      const parent = current.parentKey ? layout.byKey.get(current.parentKey) : undefined;
      return parent && !this.isHiddenArc(parent) ? this.selectArc(parent) : false;
    }
    if (direction === 'down') {
      const child = this.visibleRing(current.ring + 1).find(
        (arc) => arc.parentKey === current.key
      );
      return child ? this.selectArc(child) : false;
    }

    const siblings = this.visibleRing(current.ring).filter(
      (arc) => arc.parentKey === current.parentKey && arc.parentNodeId === current.parentNodeId
    );
    if (siblings.length === 0) return false;
    const index = siblings.indexOf(current);
    if (index < 0) return false;
    const step = direction === 'next' ? 1 : -1;
    const next = siblings[(index + step + siblings.length) % siblings.length]!;
    return next === current ? false : this.selectArc(next);
  }

  /** Enter: re-root onto the selected wedge, which is the drill-in gesture. */
  enterSelected(): boolean {
    const id = this.selected;
    if (!id || !this.model?.nodes.has(id) || id === this.rootId) return false;
    this.setRoot(id);
    return true;
  }

  /** Arcs of one ring in display order, minus the categories switched off. */
  private visibleRing(ring: number): SunburstArc[] {
    const arcs = this.layout?.byRing[ring] ?? [];
    return arcs.filter((arc) => !this.isHiddenArc(arc));
  }

  /** Select the node an arc renders (a `+N` arc has none) and publish it. */
  private selectArc(arc: SunburstArc): boolean {
    const node = arc.nodeId ? this.model?.get(arc.nodeId) : undefined;
    if (!node) return false;
    this.selected = node.id;
    this.edgesDirty = true;
    this.requestDraw();
    this.callbacks.onSelect(node);
    return true;
  }

  /**
   * Compatibility with the phase C/D contract: the URL and the cards used to
   * speak in terms of an *expansion set*. There is no expansion any more — the
   * disk has one root — so the set collapses to it, and a set coming back in
   * (an old URL, a card's ancestor list) re-roots to what it all has in common.
   */
  getExpanded(): Set<string> {
    return new Set([this.rootId]);
  }

  setExpanded(ids: Iterable<string>): void {
    const model = this.model;
    if (!model) return;
    const wanted = [...ids].filter((id) => model.nodes.has(id));
    if (wanted.length === 0) {
      this.setRoot(initialRoot(model), false);
      return;
    }
    const target = deepestCommonAncestor(model, wanted);
    this.setRoot(target, false);
  }

  // ------------------------------------------------------------ highlight ---

  /**
   * Install (or clear) the persistent highlight a card drives.
   *
   * Ids the model doesn't know are dropped silently: a card saved before a
   * re-index can name a symbol that no longer exists, and that must degrade to
   * "fewer glows", never to an error.
   */
  setHighlight(highlight: CanvasHighlight | null): void {
    const model = this.model;
    const known = (ids: Iterable<string> | undefined): Set<string> => {
      const out = new Set<string>();
      for (const id of ids ?? []) if (!model || model.nodes.has(id)) out.add(id);
      return out;
    };
    this.resultNodes = known(highlight?.nodes);
    this.changedNodes = known(highlight?.changed);
    this.impactedNodes = known(highlight?.impacted);

    this.resultEdges = new Set<string>();
    if (model) {
      for (const ref of highlight?.edges ?? []) {
        for (const edge of model.edgesOf(ref.source)) {
          if (edge.kind !== ref.kind) continue;
          if (edge.source !== ref.source || edge.target !== ref.target) continue;
          this.resultEdges.add(edge.key);
        }
      }
    }
    this.projectHighlight();
    this.edgesDirty = true;
    this.requestDraw();
  }

  /** Re-fit: reset zoom and pan so the whole disk is on screen. */
  fitView(): void {
    this.zoom = 1;
    this.panX = 0;
    this.panY = 0;
    this.cameraMoved();
    this.requestDraw();
    this.emitSummary();
  }

  destroy(): void {
    this.disposed = true;
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.resizeObserver.disconnect();
    this.canvas.remove();
  }

  // --------------------------------------------------------------- layout ---

  private rebuildLayout(): void {
    const model = this.model;
    if (!model) return;
    this.layout = computeSunburst(model, this.rootId, { sort: this.sortMode });
    this.rootId = this.layout.rootId;
    this.buildLabelGeometry();
    this.projectHighlight();
    this.edgesDirty = true;
    this.requestDraw();
    this.emitSummary();
  }

  /**
   * Everything a label needs that the camera cannot change, once per layout.
   *
   * The trigonometry and the two extents are properties of the WEDGE, so they
   * belong to the layout's lifetime, not to the frame's. Hoisting them here is
   * half of the zoom fix — the other half is {@link drawLabels} not re-running
   * the fit while the camera is in motion.
   */
  private buildLabelGeometry(): void {
    this.labelGeom = [];
    this.labelPlan = null;
    const layout = this.layout;
    if (!layout) return;
    for (const arc of layout.arcs) {
      const mid = (arc.a0 + arc.a1) / 2;
      const midRadius = (arc.r0 + arc.r1) / 2;
      const span = arc.a1 - arc.a0;
      this.labelGeom.push({
        arc,
        mid,
        cos: Math.cos(mid),
        sin: Math.sin(mid),
        midRadius,
        span,
        tangential: span * midRadius,
        radial: arc.r1 - arc.r0,
      });
    }
  }

  /** The legend row a wedge belongs to — the unit an interactive legend hides. */
  private legendKeyFor(arc: SunburstArc): string | null {
    const node = arc.nodeId ? this.model?.get(arc.nodeId) : undefined;
    if (!node) return null;
    if (this.colorMode !== 'layer') return node.kind;
    return node.kind === DIRECTORY_KIND ? DIRECTORY_LEGEND_KEY : (node.layer ?? '');
  }

  /** Is this wedge switched off in the legend? Aggregates never are. */
  private isHiddenArc(arc: SunburstArc): boolean {
    if (this.hiddenColorKeys.size === 0) return false;
    const key = this.legendKeyFor(arc);
    return key !== null && this.hiddenColorKeys.has(key);
  }

  /**
   * Map highlighted NODE ids onto the arcs that actually render them.
   *
   * A changed symbol inside a collapsed directory has no arc of its own, so its
   * rim is drawn on the deepest ancestor arc that IS on screen — otherwise a
   * whole edit would silently vanish when the user zooms out.
   */
  private projectHighlight(): void {
    this.resultArcs = new Set();
    this.changedArcs = new Set();
    this.impactedArcs = new Set();
    this.impactModeArcs = new Set();
    if (!this.layout) return;
    const project = (ids: Set<string>, into: Set<string>): void => {
      for (const id of ids) {
        const arc = this.resolveArc(id);
        if (arc) into.add(arc.key);
      }
    };
    project(this.resultNodes, this.resultArcs);
    project(this.changedNodes, this.changedArcs);
    project(this.impactedNodes, this.impactedArcs);
    project(this.impactModeNodes, this.impactModeArcs);
  }

  /**
   * The deepest RENDERED arc standing in for a node.
   *
   * `null` means the centre — either the current root itself or something
   * outside its subtree entirely, which is exactly where such an edge should
   * appear to leave from.
   */
  private resolveArc(id: string): SunburstArc | null {
    const layout = this.layout;
    const model = this.model;
    if (!layout || !model) return null;
    const direct = layout.byNode.get(id);
    if (direct) return direct;
    const folded = layout.aggregatedInto.get(id);
    if (folded) return folded;
    for (const ancestor of model.ancestors(id)) {
      const arc = layout.byNode.get(ancestor);
      if (arc) return arc;
      const aggregate = layout.aggregatedInto.get(ancestor);
      if (aggregate) return aggregate;
    }
    return null;
  }

  private resize(): void {
    const rect = this.container.getBoundingClientRect();
    this.width = Math.max(1, Math.round(rect.width));
    this.height = Math.max(1, Math.round(rect.height));
    const ratio = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(this.width * ratio);
    this.canvas.height = Math.round(this.height * ratio);
    this.cameraMoved();
    this.requestDraw();
  }

  // ------------------------------------------------------------ transform ---

  /**
   * Where the disk sits with no pan applied.
   *
   * Biased right of centre: the cards / status column floats over the left of
   * the viewport, and a disk centred under it would be half-covered.
   */
  private centre(): Point {
    const gutter = this.width > GUTTER_MIN_WIDTH ? PANEL_GUTTER : 0;
    const available = Math.max(120, this.width - gutter);
    return { x: gutter + available / 2, y: this.height / 2 };
  }

  /** Scale that fits the disk in the space the floating panels leave free. */
  private fitScale(): number {
    const gutter = this.width > GUTTER_MIN_WIDTH ? PANEL_GUTTER : 0;
    const available = Math.max(120, this.width - gutter);
    const radius = Math.max(60, Math.min(available, this.height) / 2 - VIEW_PADDING);
    return radius / (this.layout?.maxRadius ?? MAX_RADIUS);
  }

  private scale(): number {
    return this.fitScale() * this.zoom;
  }

  private origin(): Point {
    const centre = this.centre();
    return { x: centre.x + this.panX, y: centre.y + this.panY };
  }

  private toWorld(screenX: number, screenY: number): Point {
    const origin = this.origin();
    const scale = this.scale();
    return { x: (screenX - origin.x) / scale, y: (screenY - origin.y) / scale };
  }

  // -------------------------------------------------------------- painting ---

  private requestDraw(): void {
    if (this.frame !== null || this.disposed) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = null;
      if (this.disposed) return;
      this.draw();
      if (this.transitionStart > 0) this.requestDraw();
    });
  }

  private draw(): void {
    const ctx = this.ctx;
    const ratio = window.devicePixelRatio || 1;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, this.width, this.height);
    ctx.fillStyle = BACKGROUND;
    ctx.fillRect(0, 0, this.width, this.height);

    const layout = this.layout;
    const model = this.model;
    if (!layout || !model) return;

    // Re-root transition: pure scale + fade over a layout that never moves.
    let progress = 1;
    if (this.transitionStart > 0) {
      progress = Math.min(1, (performance.now() - this.transitionStart) / TRANSITION_MS);
      if (progress >= 1) this.transitionStart = 0;
      // The re-root animation scales the whole disk frame by frame, which is a
      // camera move by any other name — the labels ride the last plan through
      // it and are re-planned once it lands.
      this.cameraMoved();
    }
    const eased = 1 - Math.pow(1 - progress, 3);
    const animationScale = this.transitionFrom + (1 - this.transitionFrom) * eased;

    if (this.edgesDirty) this.rebuildEdges();

    const origin = this.origin();
    const scale = this.scale();
    ctx.save();
    ctx.translate(origin.x, origin.y);
    ctx.scale(scale * animationScale, scale * animationScale);
    ctx.globalAlpha = progress < 1 ? 0.25 + 0.75 * eased : 1;

    const k = scale * animationScale;
    this.drawArcs(ctx, layout, model, k);
    this.drawCentre(ctx, layout, k);
    this.drawEdges(ctx, k);
    this.drawLabels(ctx, model, k);

    ctx.restore();

    // Two things keep the frame loop alive on their own: the ⌘P pulse, and the
    // camera-settle window that owes the labels one more (full) pass.
    if (this.pulseNodeId !== null || this.cameraSettling()) this.requestDraw();

    // The edge count is part of the summary, and it only ever changes here.
    if (this.drawnEdges.length !== this.emittedEdges) this.emitSummary();
  }

  /** Is the camera still moving (or freshly stopped)? */
  private cameraSettling(): boolean {
    return performance.now() - this.cameraMovedAt < LABEL_SETTLE_MS;
  }

  /** Note a camera gesture — zoom, pan, resize. Defers the label pass. */
  private cameraMoved(): void {
    this.cameraMovedAt = performance.now();
  }

  private drawArcs(
    ctx: CanvasRenderingContext2D,
    layout: SunburstLayout,
    model: GraphModel,
    k: number
  ): void {
    const pulseAlpha = this.pulseAlpha();
    for (const arc of layout.arcs) {
      // A category switched off in the legend is not painted at all — it is not
      // dimmed, it is absent (its angular space stays, so nothing else moves).
      if (this.isHiddenArc(arc)) continue;
      const pad = Math.min(0.0022, (arc.a1 - arc.a0) * 0.14);
      const a0 = arc.a0 + pad;
      const a1 = arc.a1 - pad;
      if (a1 <= a0) continue;

      const emphasised = this.isEmphasised(arc);
      let alpha = 0.94 - 0.055 * (arc.ring - 1);
      if (emphasised) alpha = 1;
      else if (this.hasFocus()) alpha *= DIM_ALPHA;

      ctx.beginPath();
      ctx.arc(0, 0, arc.r0, a0, a1);
      ctx.arc(0, 0, arc.r1, a1, a0, true);
      ctx.closePath();
      ctx.fillStyle = withAlpha(this.fillFor(arc, model), alpha);
      ctx.fill();

      // Outlines first, while the annulus is still the current path — the rim
      // below starts a path of its own and would otherwise be stroked twice.
      if (this.resultArcs.has(arc.key)) {
        ctx.strokeStyle = GLOW_RESULT;
        ctx.lineWidth = 1.6 / k;
        ctx.stroke();
      }
      if (arc.nodeId !== null && arc.nodeId === this.selected) {
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2 / k;
        ctx.stroke();
      } else if (arc.key === this.hoveredKey) {
        ctx.strokeStyle = 'rgba(255,255,255,0.75)';
        ctx.lineWidth = 1.4 / k;
        ctx.stroke();
      }

      // The ⌘P landing pulse: a few gentle breaths of extra outline so the eye
      // finds the wedge the palette just jumped to.
      if (pulseAlpha > 0 && arc.nodeId !== null && arc.nodeId === this.pulseNodeId) {
        ctx.strokeStyle = withAlpha(GLOW_RESULT, pulseAlpha);
        ctx.lineWidth = (1.5 + 2.5 * pulseAlpha) / k;
        ctx.stroke();
      }

      if (this.changedArcs.has(arc.key)) this.strokeRim(ctx, arc, a0, a1, RIM_CHANGED, 2.8 / k);
      else if (this.impactedArcs.has(arc.key)) {
        this.strokeRim(ctx, arc, a0, a1, RIM_IMPACTED, 2 / k);
      }

      this.drawChangeMarker(ctx, arc, a0, a1, alpha);
    }
  }

  /**
   * Where the ⌘P pulse is in its cycle: 0 when nothing is pulsing.
   *
   * Three half-sine breaths over a second, then the pulse retires itself — a
   * "look here" that outstays its welcome becomes chrome.
   */
  private pulseAlpha(): number {
    if (this.pulseNodeId === null) return 0;
    const elapsed = performance.now() - this.pulseStart;
    if (elapsed < 0) return 0;
    if (elapsed > PULSE_MS) {
      this.pulseNodeId = null;
      return 0;
    }
    const phase = (elapsed / PULSE_MS) * PULSE_CYCLES * Math.PI;
    return Math.abs(Math.sin(phase)) * (1 - elapsed / PULSE_MS);
  }

  /**
   * Uncommitted edits, on the OUTER rim of the file's own wedge.
   *
   * Two bars stacked radially — added green outside, removed red inside — each
   * running along the arc for the share of the file's lines it accounts for.
   * Deliberately thin and slightly translucent: this is a standing annotation
   * on the normal view, not a mode, so it has to survive being always on.
   */
  private drawChangeMarker(
    ctx: CanvasRenderingContext2D,
    arc: SunburstArc,
    a0: number,
    a1: number,
    alpha: number
  ): void {
    if (this.changeMarkers.size === 0 || !arc.nodeId) return;
    const marker = this.changeMarkers.get(arc.nodeId);
    if (!marker) return;
    const depth = arc.r1 - arc.r0;
    const thickness = Math.min(MARKER_MAX_THICKNESS, depth * MARKER_DEPTH_SHARE);
    if (thickness <= 0) return;
    const span = a1 - a0;

    const bar = (share: number, color: string, outer: number): void => {
      if (share <= 0) return;
      const extent = Math.max(span * Math.min(1, share), span * 0.06);
      ctx.beginPath();
      ctx.arc(0, 0, outer - thickness / 2, a0, a0 + extent);
      ctx.strokeStyle = withAlpha(color, 0.85 * alpha);
      ctx.lineWidth = thickness;
      ctx.stroke();
    };

    bar(marker.added, MARKER_ADDED, arc.r1);
    bar(marker.removed, MARKER_REMOVED, arc.r1 - thickness);
  }

  /**
   * Is this wedge part of what the user is currently looking AT?
   *
   * Three sources, all additive: a card's result, the hovered subtree (plus
   * everything an edge connects it to), and the selection.
   */
  private isEmphasised(arc: SunburstArc): boolean {
    if (this.resultArcs.has(arc.key)) return true;
    if (this.impactModeArcs.has(arc.key)) return true;
    if (this.selected !== null && arc.nodeId === this.selected) return true;
    if (this.isUnderHover(arc)) return true;
    return this.hoverConnectedArcs?.has(arc.key) ?? false;
  }

  /**
   * Is this wedge pushed to the background right now?
   *
   * Two independent focus channels dim: a card's result set (phase D) and, as
   * of phase F, a HOVER — everything the hovered wedge has no edge with fades
   * out at once, so "what does this touch" is answered by looking, not by
   * reading a list. Both use the same {@link DIM_ALPHA}, and neither animates.
   */
  private isDimmed(arc: SunburstArc): boolean {
    return this.hasFocus() && !this.isEmphasised(arc);
  }

  /** Is anything focused right now — a card, an impact set, or a hover? */
  private hasFocus(): boolean {
    return (
      this.resultArcs.size > 0 ||
      this.impactModeArcs.size > 0 ||
      this.hoverConnectedArcs !== null
    );
  }

  /** Rim on the OUTER boundary: hot for changed, warm for impacted. */
  private strokeRim(
    ctx: CanvasRenderingContext2D,
    arc: SunburstArc,
    a0: number,
    a1: number,
    color: string,
    lineWidth: number
  ): void {
    ctx.beginPath();
    ctx.arc(0, 0, Math.max(arc.r0, arc.r1 - lineWidth / 2), a0, a1);
    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth;
    ctx.stroke();
  }

  private drawCentre(ctx: CanvasRenderingContext2D, layout: SunburstLayout, k: number): void {
    ctx.beginPath();
    ctx.arc(0, 0, layout.centreRadius - 3, 0, Math.PI * 2);
    ctx.fillStyle = CENTRE_FILL;
    ctx.fill();
    ctx.strokeStyle = this.hoveredKey === CENTRE_KEY ? 'rgba(255,255,255,0.7)' : CENTRE_STROKE;
    ctx.lineWidth = 1.4 / k;
    ctx.stroke();

    // The centre names WHERE YOU ARE (round 2): the current root, prominent,
    // with the LoC the disk in front of you weighs under it. It is still a
    // button, so the destination of clicking it is a small secondary hint above
    // the name (`▲ <parent>`); at the project root there is nowhere up and the
    // hint is simply absent.
    const parentId = layout.root.parent;
    const parent = parentId ? this.model?.get(parentId) : undefined;
    const title = layout.root.name || 'project';
    const width = (layout.centreRadius - 12) * 2;

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    if (parent) {
      ctx.font = `500 ${9 / k}px ui-sans-serif, system-ui, sans-serif`;
      ctx.fillStyle = 'rgba(170, 190, 220, 0.55)';
      ctx.fillText(fitText(ctx, `▲ ${parent.name}`, width), 0, -20 / k);
    }

    ctx.fillStyle = '#dbe4f2';
    ctx.font = `600 ${13 / k}px ui-sans-serif, system-ui, sans-serif`;
    ctx.fillText(fitText(ctx, title, width), 0, (parent ? -2 : -5) / k);

    ctx.font = `500 ${10 / k}px ui-sans-serif, system-ui, sans-serif`;
    ctx.fillStyle = 'rgba(190, 205, 230, 0.72)';
    ctx.fillText(fitText(ctx, `${formatNumber(layout.rootLoc)} loc`, width), 0, (parent ? 14 : 10) / k);
  }

  private drawEdges(ctx: CanvasRenderingContext2D, k: number): void {
    if (this.drawnEdges.length === 0) return;
    ctx.lineCap = 'round';
    for (const drawn of this.drawnEdges) {
      if (drawn.points.length < 2) continue;
      const hovered = drawn.edge.key === this.hoveredEdgeKey;
      ctx.beginPath();
      ctx.moveTo(drawn.points[0]!.x, drawn.points[0]!.y);
      for (let i = 1; i < drawn.points.length; i++) {
        ctx.lineTo(drawn.points[i]!.x, drawn.points[i]!.y);
      }
      // Colour is DIRECTION relative to the focused wedge (green in, amber
      // out), never the edge kind — see `palette.ts`.
      const color = colorForEdgeDirection(drawn.direction);
      ctx.strokeStyle = withAlpha(color, hovered ? 0.98 : 0.68);
      ctx.lineWidth = (hovered ? 2.4 : 1.3) / k;
      // Provenance: a synthesized (heuristic) relation is dashed, always.
      if (drawn.edge.heuristic) ctx.setLineDash([6 / k, 4 / k]);
      else ctx.setLineDash([]);
      ctx.stroke();
    }
    ctx.setLineDash([]);
  }

  /**
   * Labels are drawn for EVERY wedge, dimmed ones included (phase F).
   *
   * They used to disappear the moment a card dimmed the disk, which is exactly
   * when the user needs them: the dimmed ring is what they are navigating back
   * through. A dimmed label is drawn in quiet ink instead of hidden.
   */
  private drawLabels(ctx: CanvasRenderingContext2D, model: GraphModel, k: number): void {
    // While the camera is moving the last PLAN is replayed through arithmetic
    // gates only. Rebuilding it costs an orientation choice and a `measureText`
    // per candidate wedge, which at 60fps is exactly the judder the round-4
    // review reported; the gates below are a handful of multiplications and the
    // real pass runs the moment the gesture stops.
    const reuse = this.cameraSettling() && this.labelPlan !== null;
    const plan = reuse ? this.labelPlan! : this.buildLabelPlan(ctx, k);
    if (!reuse) this.labelPlan = plan;

    for (const label of plan) {
      const arc = label.geom.arc;
      if (this.isHiddenArc(arc)) continue;
      if (reuse && !this.planStillFits(label, k)) continue;
      const ink = this.isDimmed(arc) ? DIM_LABEL_COLOR : readableOn(this.fillFor(arc, model));
      // The plan's own font is kept while the camera moves: recomputing it would
      // miss the metrics cache on every bucket change, which is the cost this
      // whole path exists to avoid. The size only ever varies between 8 and
      // 12.5px, so holding it for the length of a gesture is not visible.
      ctx.font = fontSpec(label.fontPx, k);
      if (label.orientation === 'curved') this.paintCurvedLabel(ctx, label, k, ink);
      else this.paintRadialLabel(ctx, label, ink);
    }
  }

  /** The full label pass: one decision per wedge, at the current scale. */
  private buildLabelPlan(ctx: CanvasRenderingContext2D, k: number): PlannedLabel[] {
    const plan: PlannedLabel[] = [];
    for (const geom of this.labelGeom) {
      if (this.isHiddenArc(geom.arc)) continue;
      const label = this.planLabel(ctx, geom, k);
      if (label) plan.push(label);
    }
    return plan;
  }

  /**
   * Name a wedge — along its arc, or along its RADIUS, whichever the wedge has
   * more room for.
   *
   * The orientation is chosen by **measuring the wedge, not by ranking the two
   * layouts** (round 3). A wedge is a curved rectangle with two extents at the
   * label's radius: the TANGENTIAL one (`span × midRadius`, the arc length) and
   * the RADIAL one (`r1 - r0`). Text runs along the longer of the two — which
   * is the only reading that survives per-branch radii, where a directory
   * wedge can be wide and shallow while the symbol beside it is deep and
   * narrow. Curved-first was a fixed preference and got this backwards on every
   * deep, narrow wedge.
   *
   * Each layout keeps its own fit gates and its own ≥3-characters-or-nothing
   * rule; if the chosen one does not fit, the other is tried before the wedge
   * is left bare for the hover tooltip to name.
   */
  private planLabel(
    ctx: CanvasRenderingContext2D,
    geom: ArcLabelGeom,
    k: number
  ): PlannedLabel | null {
    if (geom.tangential > geom.radial) {
      return this.planCurved(ctx, geom, k) ?? this.planRadial(ctx, geom, k);
    }
    return this.planRadial(ctx, geom, k) ?? this.planCurved(ctx, geom, k);
  }

  /**
   * Curved layout: the name follows the arc. `null` when the wedge is too
   * short or too thin for it, or when what fits is not a name any more.
   */
  private planCurved(
    ctx: CanvasRenderingContext2D,
    geom: ArcLabelGeom,
    k: number
  ): PlannedLabel | null {
    const thicknessPx = geom.radial * k;
    if (geom.tangential * k < LABEL_MIN_ARC_PX || thicknessPx < LABEL_MIN_THICKNESS_PX) return null;
    const fontPx = curvedFontPx(thicknessPx);
    const fitted = this.fitLabel(ctx, geom.arc.label, geom.tangential * 0.9 * k, fontPx, k);
    // `ex…` names nothing — let the caller try the other orientation.
    if (!fitted || (fitted.text.endsWith('…') && fitted.text.length < LABEL_MIN_CHARS)) return null;
    return { geom, text: fitted.text, orientation: 'curved', fontPx, widthPx: fitted.widthPx };
  }

  /**
   * Radial layout: the name runs OUT ALONG THE RADIUS, on the wedge's angular
   * bisector.
   *
   * The room is the wedge's own geometry, no approximation needed: the line
   * length is the wedge's radial depth and the cap height is the angular chord
   * at the centroid (`span × midRadius`). Both are known before any
   * `measureText` — and, as of round 4, both were computed once when the layout
   * was built rather than once per wedge per frame.
   */
  private planRadial(
    ctx: CanvasRenderingContext2D,
    geom: ArcLabelGeom,
    k: number
  ): PlannedLabel | null {
    const lengthPx = geom.radial * k;
    const heightPx = geom.tangential * k;
    if (lengthPx < RLABEL_MIN_LENGTH_PX || heightPx < RLABEL_MIN_HEIGHT_PX) return null;
    const fontPx = radialFontPx(heightPx);
    const fitted = this.fitLabel(ctx, geom.arc.label, geom.radial * 0.92 * k, fontPx, k);
    if (!fitted || (fitted.text.endsWith('…') && fitted.text.length < RLABEL_MIN_CHARS)) return null;
    return { geom, text: fitted.text, orientation: 'radial', fontPx, widthPx: fitted.widthPx };
  }

  /**
   * Cheap replay gate: does last pass's decision still hold at this scale?
   *
   * Pure arithmetic — the wedge's two extents at the current scale against the
   * same thresholds the full pass uses, and the plan's own measured width (the
   * font is held for the gesture, so the width holds with it). It can only ever
   * DROP a label, never invent one, so a gesture can thin the disk out but can
   * never draw a name that does not fit.
   */
  private planStillFits(label: PlannedLabel, k: number): boolean {
    const geom = label.geom;
    const tangentialPx = geom.tangential * k;
    const radialPx = geom.radial * k;
    const needed = label.widthPx;
    if (label.orientation === 'curved') {
      if (tangentialPx < LABEL_MIN_ARC_PX || radialPx < LABEL_MIN_THICKNESS_PX) return false;
      return needed <= tangentialPx * 0.9;
    }
    if (radialPx < RLABEL_MIN_LENGTH_PX || tangentialPx < RLABEL_MIN_HEIGHT_PX) return false;
    return needed <= radialPx * 0.92;
  }

  /**
   * Longest prefix of `text` that fits `maxPx`, ellipsised — or `null` when
   * nothing legible fits (a lone `…` is noise, not information). Every
   * measurement goes through the cache, so a re-plan at the same scale is free.
   */
  private fitLabel(
    ctx: CanvasRenderingContext2D,
    text: string,
    maxPx: number,
    fontPx: number,
    k: number
  ): { text: string; widthPx: number } | null {
    if (maxPx <= 0) return null;
    const full = this.measurePx(ctx, text, fontPx, k);
    if (full <= maxPx) return { text, widthPx: full };
    for (let cut = text.length - 1; cut > 1; cut--) {
      const candidate = `${text.slice(0, cut)}…`;
      const width = this.measurePx(ctx, candidate, fontPx, k);
      if (width <= maxPx) return { text: candidate, widthPx: width };
    }
    return null;
  }

  /**
   * Width of `text` at `fontPx`, in SCREEN px — memoised per (font, text).
   *
   * The canvas is scaled by `k`, so the context's own font is `fontPx / k` and
   * `measureText` answers in layout units; multiplying back by `k` gives a
   * number that depends only on the pair being cached. Font sizes are bucketed
   * to a half-pixel by the two `*FontPx` helpers, which is what keeps the cache
   * from being a per-zoom-level miss on every entry.
   */
  private measurePx(
    ctx: CanvasRenderingContext2D,
    text: string,
    fontPx: number,
    k: number
  ): number {
    const key = `${fontPx}|${text}`;
    const cached = this.textWidths.get(key);
    if (cached !== undefined) return cached;
    ctx.font = fontSpec(fontPx, k);
    const width = ctx.measureText(text).width * k;
    if (this.textWidths.size < TEXT_CACHE_MAX) this.textWidths.set(key, width);
    return width;
  }

  /**
   * Paint a planned curved label, one glyph at a time along the arc. Labels on
   * the bottom half are flipped so they are never upside down.
   *
   * Every glyph advance comes out of the metrics cache — the per-character
   * `measureText` this used to do on every frame was the other half of the zoom
   * cost, and a font has only so many distinct glyphs.
   */
  private paintCurvedLabel(
    ctx: CanvasRenderingContext2D,
    label: PlannedLabel,
    k: number,
    ink: string
  ): void {
    const { mid, midRadius } = label.geom;
    const fontPx = label.fontPx;
    const flip = label.geom.sin > 0;
    const total = this.measurePx(ctx, label.text, fontPx, k) / k;
    ctx.font = fontSpec(fontPx, k);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = ink;

    let angle = flip ? mid + total / midRadius / 2 : mid - total / midRadius / 2;
    for (const character of label.text) {
      const step = this.measurePx(ctx, character, fontPx, k) / k / midRadius;
      const at = flip ? angle - step / 2 : angle + step / 2;
      ctx.save();
      ctx.rotate(at);
      ctx.translate(midRadius, 0);
      ctx.rotate(flip ? -Math.PI / 2 : Math.PI / 2);
      ctx.fillText(character, 0, 0);
      ctx.restore();
      angle = flip ? angle - step : angle + step;
    }
  }

  /**
   * Paint a planned radial label: out along the radius, on the wedge's angular
   * bisector.
   *
   * On the left half of the disk (`cos(mid) < 0`) the text would come out
   * upside down, so it is rotated a further 180° and reads inward — the
   * convention every sunburst uses, and the reason the label never has to be
   * mirrored per glyph.
   */
  private paintRadialLabel(
    ctx: CanvasRenderingContext2D,
    label: PlannedLabel,
    ink: string
  ): void {
    const { mid, cos, sin, midRadius } = label.geom;
    ctx.save();
    ctx.translate(cos * midRadius, sin * midRadius);
    ctx.rotate(cos < 0 ? mid + Math.PI : mid);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = ink;
    ctx.fillText(label.text, 0, 0);
    ctx.restore();
  }

  private fillFor(arc: SunburstArc, model: GraphModel): string {
    if (!arc.nodeId) return AGGREGATE_FILL;
    const node = model.get(arc.nodeId);
    if (!node) return AGGREGATE_FILL;
    return colorForNode(node, this.colorMode, model.layers);
  }

  // ---------------------------------------------------------------- edges ---

  /**
   * Is this arc the hovered one, or inside its subtree?
   *
   * Answered by walking the arc's own parent chain (at most `MAX_RINGS` steps)
   * rather than expanding the hovered subtree, so it stays O(1) per arc.
   */
  private isUnderHover(arc: SunburstArc): boolean {
    const hovered = this.hoveredKey;
    if (!hovered || hovered === CENTRE_KEY) return false;
    const layout = this.layout;
    if (!layout) return false;
    let current: SunburstArc | undefined = arc;
    let guard = 0;
    while (current && guard++ < 16) {
      if (current.key === hovered) return true;
      current = current.parentKey ? layout.byKey.get(current.parentKey) : undefined;
    }
    return false;
  }

  /**
   * Assemble the relations to draw right now.
   *
   * Edges are hidden at rest by design (contract): the disk is the structure,
   * relations are the answer to a question. Three sources ask for them — the
   * hovered arc's subtree, the current selection, and the active card's
   * `edgeRefs` — and each is capped, because a hover over the project root
   * would otherwise ask for every edge in the graph.
   */
  private rebuildEdges(): void {
    this.edgesDirty = false;
    this.drawnEdges = [];
    const model = this.model;
    const layout = this.layout;
    if (!model || !layout) return;

    const wanted = new Map<string, ModelEdge>();
    // Direction is meaningful only against a FOCUS — the hovered wedge, else
    // the selection. A card's edges have no single endpoint to be relative to,
    // so they stay neutral rather than claiming a direction they don't have.
    const directions = new Map<string, EdgeDirection>();
    for (const key of this.resultEdges) {
      const edge = model.edgeByKey.get(key);
      if (edge && this.enabledKinds.has(edge.kind)) wanted.set(key, edge);
      if (wanted.size >= EDGE_BUDGET) break;
    }
    if (this.selected) this.collectEdges([this.selected], wanted, directions);

    const hoverEdges = new Map<string, ModelEdge>();
    const hoveredArc =
      this.hoveredKey && this.hoveredKey !== CENTRE_KEY
        ? (layout.byKey.get(this.hoveredKey) ?? null)
        : null;
    if (hoveredArc) {
      this.collectEdges(
        hoveredArc.nodeId ? [hoveredArc.nodeId] : hoveredArc.aggregated,
        hoverEdges,
        directions
      );
      for (const [key, edge] of hoverEdges) {
        if (wanted.size >= EDGE_BUDGET && !wanted.has(key)) break;
        wanted.set(key, edge);
      }
    }

    // Everything the hover reaches — the dimming set. Both endpoints are mapped
    // onto the arcs that actually render them, so a relation into a folded
    // subtree still lights the arc standing in for it.
    this.hoverConnectedArcs = hoveredArc ? new Set<string>([hoveredArc.key]) : null;

    for (const [key, edge] of wanted) {
      const from = this.resolveArc(edge.source);
      const to = this.resolveArc(edge.target);
      if (this.hoverConnectedArcs && hoverEdges.has(key)) {
        if (from) this.hoverConnectedArcs.add(from.key);
        if (to) this.hoverConnectedArcs.add(to.key);
      }
      if (!from && !to) continue;
      if (from && to && from.key === to.key) continue;
      const points = bundleCurve(bundleControlPoints(from, to, layout));
      if (points.length >= 2) {
        this.drawnEdges.push({ edge, points, direction: directions.get(key) ?? 'neutral' });
      }
    }
  }

  /**
   * Walk a subtree and take its relations, recording each one's DIRECTION
   * relative to the subtree: an edge leaving a node we walked is outgoing, one
   * arriving at it is incoming. That is the only place the two are
   * distinguishable for free, so it happens here rather than in the painter.
   */
  private collectEdges(
    seeds: string[],
    into: Map<string, ModelEdge>,
    directions?: Map<string, EdgeDirection>
  ): void {
    const model = this.model;
    if (!model) return;
    const stack = [...seeds];
    let scanned = 0;
    while (stack.length > 0 && scanned < NODE_SCAN_CAP && into.size < EDGE_BUDGET) {
      const id = stack.pop()!;
      scanned++;
      for (const edge of model.edgesOf(id)) {
        if (into.size >= EDGE_BUDGET) break;
        if (!this.enabledKinds.has(edge.kind)) continue;
        if (edge.source === edge.target) continue;
        into.set(edge.key, edge);
        if (directions && !directions.has(edge.key)) {
          directions.set(edge.key, edge.source === id ? 'outgoing' : 'incoming');
        }
      }
      for (const child of model.childrenOf(id)) stack.push(child);
    }
  }

  // --------------------------------------------------------------- events ---

  private bindEvents(): void {
    this.canvas.addEventListener('pointermove', this.onPointerMove);
    this.canvas.addEventListener('pointerdown', this.onPointerDown);
    this.canvas.addEventListener('pointerup', this.onPointerUp);
    this.canvas.addEventListener('pointercancel', this.onPointerUp);
    this.canvas.addEventListener('pointerleave', this.onPointerLeave);
    this.canvas.addEventListener('click', this.onClick);
    this.canvas.addEventListener('dblclick', this.onDoubleClick);
    this.canvas.addEventListener('wheel', this.onWheel, { passive: false });
  }

  /**
   * The arc under a layout-space point, honouring the legend's filters.
   *
   * A category switched off is INVISIBLE, not dimmed, so the pointer has to go
   * straight through it — a wedge you cannot see must not swallow the click
   * meant for the background.
   */
  private hitArc(layout: SunburstLayout, x: number, y: number): SunburstArc | null {
    const arc = arcAt(layout, x, y);
    if (!arc || this.isHiddenArc(arc)) return null;
    return arc;
  }

  private pointerPosition(event: PointerEvent | MouseEvent | WheelEvent): Point {
    const rect = this.canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  private readonly onPointerMove = (event: PointerEvent): void => {
    const position = this.pointerPosition(event);
    if (this.dragging) {
      const dx = position.x - this.dragX;
      const dy = position.y - this.dragY;
      if (!this.dragMoved && Math.hypot(dx, dy) < DRAG_SLOP) return;
      this.dragMoved = true;
      this.panX += dx;
      this.panY += dy;
      this.dragX = position.x;
      this.dragY = position.y;
      this.cameraMoved();
      this.requestDraw();
      return;
    }
    if (this.transitionStart > 0) return;
    this.updateHover(position.x, position.y);
  };

  private readonly onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0) return;
    const position = this.pointerPosition(event);
    this.dragging = true;
    this.dragMoved = false;
    this.dragX = position.x;
    this.dragY = position.y;
    // Capture so a pan that leaves the canvas keeps tracking. Both calls are
    // guarded: releasing a pointer the browser already released throws.
    try {
      this.canvas.setPointerCapture(event.pointerId);
    } catch {
      /* capture is an optimisation, not a requirement */
    }
  };

  private readonly onPointerUp = (event: PointerEvent): void => {
    if (!this.dragging) return;
    this.dragging = false;
    this.suppressClick = this.dragMoved;
    try {
      this.canvas.releasePointerCapture(event.pointerId);
    } catch {
      /* already released (pointercancel) */
    }
  };

  private readonly onPointerLeave = (): void => {
    this.dragging = false;
    this.setHover(null, null);
  };

  private readonly onClick = (event: MouseEvent): void => {
    if (this.suppressClick) {
      this.suppressClick = false;
      return;
    }
    // A click landing mid-transition would be hit-tested against the settled
    // geometry while the user is looking at the animating one. It also makes
    // the second click of a double-click on a directory re-root twice.
    if (this.transitionStart > 0) return;
    const model = this.model;
    const layout = this.layout;
    if (!model || !layout) return;
    const position = this.pointerPosition(event);
    const world = this.toWorld(position.x, position.y);

    if (Math.hypot(world.x, world.y) <= layout.centreRadius) {
      this.rootUp();
      return;
    }

    const arc = this.hitArc(layout, world.x, world.y);
    if (!arc) {
      this.selected = null;
      this.edgesDirty = true;
      this.requestDraw();
      this.callbacks.onSelect(null);
      return;
    }

    if (!arc.nodeId) {
      // A `+N` fold arc: re-rooting onto its parent gives the folded
      // children the full circle. At ring 1 the parent IS the root, so there is
      // nowhere further to go — ⌘P is the way in, and the tooltip says so.
      if (arc.parentNodeId !== this.rootId) this.setRoot(arc.parentNodeId);
      return;
    }

    const node = model.get(arc.nodeId);
    if (!node) return;
    if (node.kind === DIRECTORY_KIND) {
      this.setRoot(node.id);
      return;
    }
    this.selected = node.id;
    this.edgesDirty = true;
    this.requestDraw();
    this.callbacks.onSelect(node);
  };

  /** Double-click drills into anything with children — files included. */
  private readonly onDoubleClick = (event: MouseEvent): void => {
    const layout = this.layout;
    const model = this.model;
    if (!layout || !model) return;
    // Double-clicking a DIRECTORY already re-rooted on the first click; the
    // arc now under the cursor belongs to a different level entirely.
    if (performance.now() - this.rootChangedAt < 450) return;
    const position = this.pointerPosition(event);
    const world = this.toWorld(position.x, position.y);
    const arc = this.hitArc(layout, world.x, world.y);
    if (!arc?.nodeId) return;
    if (model.childrenOf(arc.nodeId).length === 0) return;
    this.setRoot(arc.nodeId);
  };

  private readonly onWheel = (event: WheelEvent): void => {
    event.preventDefault();
    const position = this.pointerPosition(event);
    const before = this.toWorld(position.x, position.y);
    const factor = Math.exp(-event.deltaY * 0.0015);
    const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, this.zoom * factor));
    if (next === this.zoom) return;
    this.zoom = next;
    // Keep the world point under the cursor pinned to the cursor.
    const centre = this.centre();
    const scale = this.scale();
    this.panX = position.x - before.x * scale - centre.x;
    this.panY = position.y - before.y * scale - centre.y;
    this.cameraMoved();
    this.requestDraw();
    this.emitSummary();
  };

  private updateHover(screenX: number, screenY: number): void {
    const layout = this.layout;
    if (!layout) return;
    const world = this.toWorld(screenX, screenY);

    // Edges are only hit-tested among the ones already on screen, and they do
    // NOT steal the arc hover — otherwise hovering an arc would reveal an edge
    // under the cursor, drop the arc hover, hide the edge, and loop forever.
    let edgeKey: string | null = null;
    if (this.drawnEdges.length > 0) {
      const tolerance = 5 / this.scale();
      let best = tolerance;
      for (const drawn of this.drawnEdges) {
        const distance = distanceToPolyline(drawn.points, world.x, world.y);
        if (distance < best) {
          best = distance;
          edgeKey = drawn.edge.key;
        }
      }
    }

    const radius = Math.hypot(world.x, world.y);
    const arcKey =
      radius <= layout.centreRadius
        ? CENTRE_KEY
        : (this.hitArc(layout, world.x, world.y)?.key ?? null);
    this.setHover(arcKey, edgeKey, screenX, screenY);
  }

  /**
   * Hover is only published when the TARGET changes, never on every pointer
   * move: a tooltip that re-renders the React chrome 60 times a second is how
   * a canvas app ends up feeling slower than the canvas is.
   */
  private setHover(arcKey: string | null, edgeKey: string | null, x = 0, y = 0): void {
    const arcChanged = arcKey !== this.hoveredKey;
    const edgeChanged = edgeKey !== this.hoveredEdgeKey;
    if (!arcChanged && !edgeChanged) return;
    this.hoveredKey = arcKey;
    this.hoveredEdgeKey = edgeKey;
    this.canvas.style.cursor = arcKey ? 'pointer' : 'default';
    if (arcChanged) this.edgesDirty = true;
    this.emitTooltips(x, y);
    this.requestDraw();
  }

  private emitTooltips(x: number, y: number): void {
    const model = this.model;
    const layout = this.layout;
    if (!model || !layout) return;

    // An edge under the pointer highlights its rope and NOTHING else — phase F
    // removed the edge tooltip outright (see `CanvasCallbacks.onArcTooltip`).
    if (!this.hoveredKey || this.hoveredKey === CENTRE_KEY) {
      this.callbacks.onArcTooltip(null);
      return;
    }
    const arc = layout.byKey.get(this.hoveredKey);
    if (!arc) {
      this.callbacks.onArcTooltip(null);
      return;
    }
    const node = arc.nodeId ? model.get(arc.nodeId) : undefined;
    const tooltip: ArcTooltip = {
      x,
      y,
      name: node?.name ?? arc.label,
      path: node?.file ?? '',
      kind: node?.kind ?? AGGREGATE_KIND,
      loc: arc.weight,
      aggregate: !arc.nodeId,
      hiddenChildren: arc.hiddenChildren,
    };
    if (node?.layer) tooltip.layer = node.layer;
    this.callbacks.onArcTooltip(tooltip);
  }

  // -------------------------------------------------------------- summary ---

  private emitSummary(): void {
    const model = this.model;
    const layout = this.layout;
    if (!model || !layout) return;
    const present = new Set<string>();
    for (const arc of layout.arcs) {
      if (!arc.nodeId) continue;
      const node = model.get(arc.nodeId);
      if (!node) continue;
      if (this.colorMode !== 'layer') {
        present.add(node.kind);
        continue;
      }
      // In the layer mode a directory is grey, not "no layer" — it gets its own
      // legend row so the two greys/teals can't be confused (phase F).
      present.add(node.kind === DIRECTORY_KIND ? DIRECTORY_LEGEND_KEY : (node.layer ?? ''));
    }
    this.emittedEdges = this.drawnEdges.length;
    this.callbacks.onViewChange({
      arcs: layout.arcs.length,
      rings: layout.rings,
      truncated: layout.truncated,
      visibleEdges: this.drawnEdges.length,
      presentColorKeys: [...present],
      edgeKinds: [...model.edgeKinds],
      enabledKinds: [...this.enabledKinds],
      breadcrumb: layout.trail.map((node) => ({ id: node.id, name: node.name })),
      zoom: this.zoom,
    });
  }
}

/** Pseudo arc key for the centre disk, so hover has one vocabulary. */
const CENTRE_KEY = '@centre';

/** The render budget, re-exported so the chrome can show `arcs / budget`. */
export { MAX_ARCS as ARC_BUDGET };

/**
 * Label font sizes, in SCREEN px, **bucketed to a half pixel**.
 *
 * The bucket is what makes the metrics cache work: a continuous zoom would
 * otherwise produce a fresh font size — and therefore a fresh cache miss — on
 * every single frame. Half a pixel is below the threshold anyone can see and
 * the same wedge keeps the same entry across a whole gesture.
 */
function curvedFontPx(thicknessPx: number): number {
  return bucketFont(Math.max(9, Math.min(12.5, thicknessPx * 0.34)));
}

function radialFontPx(heightPx: number): number {
  return bucketFont(Math.max(8, Math.min(RLABEL_MAX_FONT_PX, heightPx * 0.8)));
}

function bucketFont(px: number): number {
  return Math.round(px * 2) / 2;
}

/** The canvas is scaled by `k`, so a screen-px font is `px / k` user units. */
function fontSpec(fontPx: number, k: number): string {
  return `500 ${fontPx / k}px ui-sans-serif, system-ui, sans-serif`;
}

/** Entries the text-metrics cache holds before it stops growing. */
const TEXT_CACHE_MAX = 4000;

/** `#rrggbb` (or `rgba(...)`) → `rgba(...)` at the given alpha. */
function withAlpha(color: string, alpha: number): string {
  if (color.startsWith('rgba(')) {
    return color.replace(/rgba\(([^,]+),([^,]+),([^,]+),[^)]+\)/, `rgba($1,$2,$3,${alpha})`);
  }
  if (!color.startsWith('#') || color.length !== 7) return color;
  const value = Number.parseInt(color.slice(1), 16);
  const r = (value >> 16) & 255;
  const g = (value >> 8) & 255;
  const b = value & 255;
  return `rgba(${r},${g},${b},${alpha})`;
}

/** Dark ink on a bright arc, light ink on a dark one. */
function readableOn(color: string): string {
  if (!color.startsWith('#') || color.length !== 7) return '#e6edf7';
  const value = Number.parseInt(color.slice(1), 16);
  const r = (value >> 16) & 255;
  const g = (value >> 8) & 255;
  const b = value & 255;
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.6 ? '#0b1220' : '#eef4ff';
}

/**
 * Longest prefix of `text` that fits `maxWidth`, ellipsised — or `''` when
 * nothing legible fits (a lone `…` is noise, not information).
 */
function fitText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (maxWidth <= 0) return '';
  if (ctx.measureText(text).width <= maxWidth) return text;
  let cut = text.length - 1;
  while (cut > 1 && ctx.measureText(`${text.slice(0, cut)}…`).width > maxWidth) cut--;
  return cut > 1 ? `${text.slice(0, cut)}…` : '';
}
