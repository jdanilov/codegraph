/**
 * The sunburst canvas: everything imperative about the graph view.
 *
 * React owns the floating panels; this class owns one `<canvas>` and draws the
 * whole workspace into it with the 2D context. There is **no simulation** — each
 * disk's layout is a pure function of (model, its root), so a redraw is a redraw
 * and nothing on screen ever drifts. That is the point: the force layout this
 * replaced was spatially unstable, which made a 13k-node project unreadable.
 *
 * PHASE G: the canvas is a **workspace** holding N disks, not a single disk.
 * Dragging a wedge past its disk's outer radius spawns a second disk rooted at
 * that node, and a relation whose two ends are visible in two different disks is
 * drawn straight across the gap. The single-disk pipeline underneath is
 * untouched: `sunburst.ts` still lays out one disk at a time and never learns
 * that a second one exists, `workspace.ts` owns the (pure) geometry above it,
 * and this class is the orchestrator between them. A workspace with one disk is
 * numerically identical to the pre-phase-G canvas.
 *
 * What lives here:
 *
 *  - the **disks** — each with its own root, position and layout;
 *  - painting: arcs, rims, curved labels, the centre disk, bundled intra-disk
 *    edges, gentle cross-disk curves, the drag ghost and the close affordance;
 *  - hit testing (workspace → disk → angle-first ring search, per disk);
 *  - navigation: click a directory to re-root, click the centre to go up,
 *    double-click anything to drill into it, `reveal(id)` for ⌘P;
 *  - the persistent highlight a card / the Changes view drives, applied
 *    uniformly to every disk.
 *
 * Edges are **hidden at rest**. They appear for the hovered arc's subtree, the
 * current selection, or the active card's `edgeRefs` — bundled along the
 * hierarchy so a hundred relations read as one rope (`bundling.ts`) when both
 * ends live in the same disk, and as one bowed curve (`workspace.ts`) when they
 * do not.
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
  arcCentroid,
  computeSunburst,
  deepestCommonAncestor,
  initialRoot,
  type Point,
  type SortMode,
  type SunburstArc,
  type SunburstLayout,
} from './sunburst';
import {
  closeAnchor,
  crossDiskCurve,
  diskAt,
  fitCamera,
  placeSpawnedDisk,
  tetherCurve,
  tetherPolyline,
  toDiskLocal,
  workspaceBounds,
  type DiskPlacement,
  type TetherCurve,
} from './workspace';

export interface BreadcrumbEntry {
  id: string;
  name: string;
}

export interface ViewSummary {
  /** Arcs currently rendered, across every disk. */
  arcs: number;
  /** Deepest ring count any disk reached. */
  rings: number;
  /** True when depth, budget or the sliver floor folded something away. */
  truncated: boolean;
  /** Bundled relations currently drawn (0 at rest — edges are on demand). */
  visibleEdges: number;
  /** Kinds (or layers) present in the workspace — drives the legend. */
  presentColorKeys: string[];
  /** Every non-`contains` kind in the graph, contract kinds first. */
  edgeKinds: string[];
  /** The subset currently drawable — the controller owns this, not React. */
  enabledKinds: string[];
  /** Project root → … → the FOCUSED disk's root. */
  breadcrumb: BreadcrumbEntry[];
  zoom: number;
  /** Disks on the canvas (1 until the user drags one out). */
  disks: number;
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

/**
 * Zoom range. The floor is well below 1 because `fit` now has to frame a whole
 * WORKSPACE: three or four disks side by side need a third of the scale a single
 * disk does, and a fit that cannot reach it is a fit that lies.
 */
const ZOOM_MIN = 0.12;
const ZOOM_MAX = 8;

/** Re-root transition. Short on purpose: navigation, not decoration. */
const TRANSITION_MS = 260;

/** Relations assembled for one hover / selection / card. */
const EDGE_BUDGET = 500;

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
 * gesture stops. At rest the output is byte-identical to the old path. Every
 * disk keeps its own plan; the settle window is the camera's, so it is shared.
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

/**
 * Width of the centre circle's identity border, in LAYOUT units.
 *
 * The border carries the disk root's own colour under the active colour mode
 * (see {@link CanvasController.drawCentre}). 2.5 reads clearly at every zoom
 * without becoming a second ring competing with the wedges — the same range the
 * change markers and the focus ring already live in.
 */
const CENTRE_BORDER = 2.5;

/** Phase G chrome: the drag ghost, the close `×`, the expansion tether. */
const GHOST_RADIUS_PX = 44;
const GHOST_STROKE = 'rgba(140, 200, 255, 0.75)';
const GHOST_FILL = 'rgba(24, 40, 66, 0.55)';
const CLOSE_RADIUS_PX = 9;
const CLOSE_HIT_PX = 13;
/**
 * The tether: one quiet line from a collapsed wedge's rim to the disk that
 * expanded it. Deliberately NOT an edge colour — it is not a relation in the
 * code, it is the workspace saying "that subtree is over there", so it borrows
 * neither the green/amber direction vocabulary nor the dashed-for-heuristic
 * one. Always on while the disk exists, which is the other half of telling it
 * apart from a code edge (those are drawn on demand only).
 */
const TETHER_COLOR = 'rgba(148, 163, 184, 0.42)';
/** Same slate, brighter, while the pointer is on the line (its `×` is up). */
const TETHER_COLOR_HOVER = 'rgba(186, 202, 224, 0.85)';
const TETHER_WIDTH_PX = 1;
/** Screen-space tolerance of the tether's own hit test (the `×` affordance). */
const TETHER_HIT_PX = 6;
/** Ring around the focused disk's centre, drawn only once there are several. */
const FOCUS_RING = 'rgba(125, 211, 252, 0.55)';

interface DrawnEdge {
  edge: ModelEdge;
  points: Point[];
  /** Relative to the hovered / selected wedge — green in, amber out. */
  direction: EdgeDirection;
  /**
   * Disk whose LOCAL space the polyline is expressed in — `null` for a
   * cross-disk curve, which lives in workspace space.
   */
  diskId: string | null;
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

/**
 * One disk in the workspace.
 *
 * Everything that used to be a scalar field on the controller and is genuinely
 * *per disk* lives here: the root, the layout computed from it, the label
 * geometry and plan, the projected highlight sets and the re-root transition.
 * Everything that is per WORKSPACE — the camera, the selection, the model, the
 * legend filters — stays on the controller, because that is what makes a
 * highlight or a filter apply uniformly to every disk for free.
 */
interface DiskState {
  id: string;
  rootId: string;
  /** Workspace coordinates of the disk's centre; the primary sits at (0, 0). */
  x: number;
  y: number;
  /** The URL-backed disk. There is exactly one and it cannot be closed. */
  primary: boolean;
  /** Node the drag-away spawned this disk from — `null` for the primary. */
  source: string | null;
  /** Disk the drag-away started in — where this disk's tether is anchored. */
  sourceDiskId: string | null;

  layout: SunburstLayout | null;
  labelGeom: ArcLabelGeom[];
  labelPlan: PlannedLabel[] | null;

  /** Arc keys the result/changed sets resolve to IN THIS DISK. */
  resultArcs: Set<string>;
  changedArcs: Set<string>;
  impactedArcs: Set<string>;
  impactModeArcs: Set<string>;
  /** Arcs the current hover reaches here — `null` when nothing is hovered. */
  hoverArcs: Set<string> | null;

  transitionStart: number;
  transitionFrom: number;
  /** When this disk's root last changed — guards the double-click drill-in. */
  rootChangedAt: number;
}

/** What a pointer gesture turned out to be. See {@link CanvasController}. */
type DragMode = 'pan' | 'move-disk' | 'wedge' | 'close';

interface DragState {
  mode: DragMode;
  moved: boolean;
  /** Screen coordinates of the previous move, for incremental deltas. */
  lastX: number;
  lastY: number;
  /** Screen coordinates the gesture started at. */
  startX: number;
  startY: number;
  /** Current pointer position, in screen coordinates (the ghost follows it). */
  x: number;
  y: number;
  diskId: string | null;
  /** Wedge drag: the node the ghost carries. */
  nodeId: string | null;
  label: string;
  /** Wedge drag: has the pointer crossed the source disk's outer radius? */
  outside: boolean;
  /** Layout the ghost previews, computed once when it first appears. */
  preview: SunburstLayout | null;
}

export class CanvasController {
  private readonly container: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly callbacks: CanvasCallbacks;
  private readonly resizeObserver: ResizeObserver;

  private model: GraphModel | null = null;

  /** The workspace: creation order, primary first. Never empty. */
  private disks: DiskState[] = [];
  /** Last interacted disk — keyboard nav, Enter and the up-nav route here. */
  private focusedDiskId = PRIMARY_DISK_ID;
  private diskSeq = 0;

  /**
   * Layouts, keyed by `(rootId, sortMode)`. A layout is a pure function of
   * (model, root, sort), so two disks on the same root share one — and closing
   * a disk and dragging it out again costs nothing. Dropped wholesale whenever
   * the model or the sort mode changes.
   */
  private layoutCache = new Map<string, SunburstLayout>();

  private colorMode: ColorMode = 'kind';
  private sortMode: SortMode = DEFAULT_SORT_MODE;
  private enabledKinds = new Set<string>();

  /** Selection is GLOBAL: one node, lit in every disk that renders it. */
  private selected: string | null = null;
  private hoveredDiskId: string | null = null;
  private hoveredKey: string | null = null;
  private hoveredEdgeKey: string | null = null;
  /** Secondary disk whose `×` the pointer is on, if any. */
  private closeHoverDiskId: string | null = null;
  /** Secondary disk whose TETHER the pointer is on — what raises that `×`. */
  private tetherHoverDiskId: string | null = null;

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

  /**
   * Nodes the hovered wedge reaches by an edge — `null` when nothing is hovered.
   * Kept at NODE level rather than at arc level so it projects onto every disk:
   * connectivity dimming is a property of the graph, not of one disk.
   */
  private hoverNodes: Set<string> | null = null;

  /** True when any disk actually projected a result / impact arc. */
  private focusArcsPresent = false;

  /**
   * Legend categories the user switched OFF (round 4). A wedge whose colour key
   * is in here is not painted, not labelled and not hit-tested — but the LAYOUT
   * is untouched, so it keeps its angular space and nothing else moves.
   */
  private hiddenColorKeys = new Set<string>();

  /** File node id → what changed in it, for the outer-rim change markers. */
  private changeMarkers = new Map<string, ChangeMarker>();

  /**
   * Node id → how many open disks are rooted at it (phase G2).
   *
   * These are the COLLAPSED nodes: a node expanded as its own disk is drawn in
   * every other disk as a third-depth stub with no children below it, and the
   * relations of its subtree are routed to the disk that actually shows it. The
   * count is a multiset because two disks can be dragged out of one wedge.
   */
  private expandedNodes = new Map<string, number>();
  /** `expandedNodes`' keys, sorted and joined — part of the layout cache key. */
  private collapsedSignature = '';

  /** `(font bucket, text)` → measured width in SCREEN px. */
  private readonly textWidths = new Map<string, number>();
  /** When the camera last moved — the label pass waits for this to go stale. */
  private cameraMovedAt = -Infinity;

  /** ⌘P landing pulse: which node, in which disk, and when it starts. */
  private pulseNodeId: string | null = null;
  private pulseDiskId: string | null = null;
  private pulseStart = 0;

  private drawnEdges: DrawnEdge[] = [];
  private edgesDirty = true;
  /** Edge count the last summary reported, so a redraw doesn't re-emit. */
  private emittedEdges = -1;

  private width = 0;
  private height = 0;
  private zoom = 1;
  private panX = 0;
  private panY = 0;

  private frame: number | null = null;
  private disposed = false;

  private drag: DragState | null = null;
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

    this.disks = [makeDisk(PRIMARY_DISK_ID, ROOT_ID, 0, 0, true, null)];

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();
    this.bindEvents();
  }

  // ---------------------------------------------------------------- data ---

  /**
   * Install a model. On a re-index (`sameProject`) the current root, selection
   * and zoom are preserved — liveness must not cost the user their place — and
   * so is the workspace: a spawned disk whose root survived the re-index stays
   * exactly where the user put it.
   */
  setModel(model: GraphModel, sameProject: boolean): void {
    const previous = this.model;
    this.model = model;
    this.layoutCache.clear();

    if (!previous || !sameProject) {
      this.disks = [makeDisk(PRIMARY_DISK_ID, initialRoot(model), 0, 0, true, null)];
      this.focusedDiskId = PRIMARY_DISK_ID;
      this.expandedNodes.clear();
      this.collapsedSignature = '';
      this.enabledKinds = new Set(model.edgeKinds);
      this.selected = null;
      this.zoom = 1;
      this.panX = 0;
      this.panY = 0;
    } else {
      // A disk whose root no longer exists has nothing to draw. The primary
      // falls back to the project root; a secondary simply goes away.
      this.disks = this.disks.filter((disk) => disk.primary || model.nodes.has(disk.rootId));
      const primary = this.primary();
      if (!model.nodes.has(primary.rootId)) primary.rootId = initialRoot(model);
      this.rebuildExpandedNodes();
      if (!this.disks.some((disk) => disk.id === this.focusedDiskId)) {
        this.focusedDiskId = PRIMARY_DISK_ID;
      }
      // A brand-new edge kind arriving mid-session should be visible, not
      // silently off; kinds that vanished are simply dropped.
      const known = new Set(previous.edgeKinds);
      for (const kind of model.edgeKinds) if (!known.has(kind)) this.enabledKinds.add(kind);
      this.enabledKinds = new Set([...this.enabledKinds].filter((k) => model.edgeKinds.includes(k)));
      if (this.selected && !model.nodes.has(this.selected)) this.selected = null;
    }
    this.rebuildAllLayouts();
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
    this.layoutCache.clear();
    if (this.model) this.rebuildAllLayouts();
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
    for (const disk of this.disks) disk.labelPlan = null;
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

  // ------------------------------------------------------------ workspace ---

  /** The URL-backed disk. Always `disks[0]`, always present. */
  private primary(): DiskState {
    return this.disks[0]!;
  }

  /** Last interacted disk — what the keyboard and Enter drive. */
  private focused(): DiskState {
    return this.disks.find((disk) => disk.id === this.focusedDiskId) ?? this.primary();
  }

  private diskById(id: string | null): DiskState | null {
    if (!id) return null;
    return this.disks.find((disk) => disk.id === id) ?? null;
  }

  /** The workspace geometry's view of the disks — position plus real radius. */
  private placements(): DiskPlacement[] {
    return this.disks.map((disk) => ({
      id: disk.id,
      x: disk.x,
      y: disk.y,
      radius: disk.layout?.maxRadius ?? MAX_RADIUS,
    }));
  }

  /** How many disks are on the canvas — 1 until the user drags one out. */
  diskCount(): number {
    return this.disks.length;
  }

  /**
   * Spawn a disk rooted at `nodeId` near a workspace point — the drop half of
   * the drag-away gesture. Placement is nudged clear of every existing disk, so
   * two disks never overlap at birth.
   *
   * The node becomes COLLAPSED everywhere else the moment the disk exists, so
   * every layout is rebuilt: the source wedge shrinks to a stub, its subtree
   * stops being drawn twice, and the freed arc budget goes to the wedges that
   * still have children to show.
   */
  private spawnDisk(
    nodeId: string,
    at: Point,
    sourceDiskId: string | null,
    layout: SunburstLayout | null
  ): DiskState | null {
    const model = this.model;
    if (!model || !model.nodes.has(nodeId)) return null;
    // The RADIUS only has to be right for placement; the collapsed set cannot
    // change a disk's own root, so the ghost's preview layout is still valid.
    const placement = layout ?? this.layoutFor(nodeId);
    const placed = placeSpawnedDisk(this.placements(), at, placement.maxRadius);
    this.diskSeq += 1;
    const disk = makeDisk(
      `disk:${this.diskSeq}`,
      placement.rootId,
      placed.x,
      placed.y,
      false,
      nodeId,
      sourceDiskId
    );
    this.disks.push(disk);
    this.rebuildExpandedNodes();
    this.focusedDiskId = disk.id;
    this.rebuildAllLayouts();
    return disk;
  }

  /** Close a secondary disk. The primary is the URL's view and cannot go. */
  private closeDisk(id: string): void {
    const disk = this.diskById(id);
    if (!disk || disk.primary) return;
    this.disks = this.disks.filter((entry) => entry.id !== id);
    this.rebuildExpandedNodes();
    if (this.focusedDiskId === id) this.focusedDiskId = PRIMARY_DISK_ID;
    if (this.hoveredDiskId === id) {
      this.hoveredDiskId = null;
      this.hoveredKey = null;
      this.callbacks.onArcTooltip(null);
    }
    if (this.closeHoverDiskId === id) this.closeHoverDiskId = null;
    if (this.tetherHoverDiskId === id) this.tetherHoverDiskId = null;
    if (this.pulseDiskId === id) this.pulseNodeId = null;
    // Its source wedge is whole again — every layout is rebuilt for that.
    this.rebuildAllLayouts();
  }

  /**
   * Recount the collapsed set from the disks that exist now, and re-derive the
   * cache signature. Every layout depends on it, so callers re-lay out after.
   */
  private rebuildExpandedNodes(): void {
    this.expandedNodes = new Map();
    for (const disk of this.disks) {
      if (!disk.source) continue;
      this.expandedNodes.set(disk.source, (this.expandedNodes.get(disk.source) ?? 0) + 1);
    }
    this.collapsedSignature = [...this.expandedNodes.keys()].sort().join('\u0000');
  }

  // ---------------------------------------------------------- navigation ---

  /**
   * The PRIMARY disk's root — the URL speaks for the primary disk only, so this
   * deliberately ignores where the focus happens to be (phase G state scope).
   */
  getRoot(): string {
    return this.primary().rootId;
  }

  /**
   * Re-root the PRIMARY disk. The centre becomes `id`, rings grow outward.
   *
   * A node with no children can still be the root — the centre disk names it —
   * which is what makes `reveal` able to land on any node in the graph.
   */
  setRoot(id: string, animate = true): void {
    this.setDiskRoot(this.primary(), id, animate);
  }

  /** Re-root one disk. Secondary disks never touch the URL or the history. */
  private setDiskRoot(disk: DiskState, id: string, animate = true): void {
    const model = this.model;
    if (!model || !model.nodes.has(id) || id === disk.rootId) return;
    const previousDepth = model.get(disk.rootId)?.depth ?? 0;
    const nextDepth = model.get(id)?.depth ?? 0;
    disk.rootId = id;
    disk.rootChangedAt = performance.now();
    if (disk.primary) {
      this.zoom = 1;
      this.panX = 0;
      this.panY = 0;
    }
    this.hoveredDiskId = null;
    this.hoveredKey = null;
    this.hoveredEdgeKey = null;
    this.hoverNodes = null;
    for (const entry of this.disks) entry.hoverArcs = null;
    this.callbacks.onArcTooltip(null);
    if (animate) {
      // Drilling in starts wide and settles; stepping out starts small and
      // grows. Both are pure opacity + scale on a layout that never moves.
      disk.transitionFrom = nextDepth > previousDepth ? 1.28 : 0.78;
      disk.transitionStart = performance.now();
    }
    this.rebuildLayout(disk);
  }

  /** Step one level out — the centre circle and the breadcrumb both do this. */
  rootUp(): void {
    const disk = this.focused();
    const parent = this.model?.get(disk.rootId)?.parent;
    if (parent) this.setDiskRoot(disk, parent);
  }

  /**
   * Re-root onto a result set — what a card (or the Changes view) does.
   *
   * The disk lands on the deepest node that contains every result, so a card
   * answering inside one file opens that file's symbol ring and a card spread
   * across the project stays at the project root. Cards drive the PRIMARY disk;
   * a spawned disk is the user's own framing and is left alone.
   */
  focusNodes(ids: Iterable<string>): void {
    const model = this.model;
    if (!model) return;
    const wanted = [...ids].filter((id) => model.nodes.has(id));
    if (wanted.length === 0) return;
    const target = deepestCommonAncestor(model, wanted);
    const primary = this.primary();
    if (target === primary.rootId) {
      this.rebuildLayout(primary);
      return;
    }
    this.setDiskRoot(primary, target);
  }

  /**
   * Select a node and bring its arc on screen — the ⌘P landing.
   *
   * Phase G: if ANY disk already renders the node, that disk answers — reveal
   * and pulse there, and take the focus with it. Nothing moves, because the
   * thing the user asked for is already on screen; re-rooting the primary disk
   * to show a second copy of it would be strictly worse.
   *
   * Otherwise this is the pre-phase-G behaviour on the primary disk. "Visible"
   * means an arc actually exists for it: re-rooting to its parent is the normal
   * answer, but a node can still be swallowed by its parent's `+N` fold arc (a
   * directory of 900 files), so the fallback re-roots onto the node ITSELF —
   * the centre disk always renders the root, so ⌘P can reach anything.
   */
  reveal(id: string, pulse = false): boolean {
    const model = this.model;
    if (!model) return false;
    const node = model.get(id);
    if (!node) return false;

    const showing = this.diskShowing(id);
    const disk = showing ?? this.primary();
    if (showing) {
      this.focusedDiskId = showing.id;
    } else {
      const parent = node.parent;
      if (parent && parent !== disk.rootId) this.setDiskRoot(disk, parent);
      if (!disk.layout || (!disk.layout.byNode.has(id) && disk.rootId !== id)) {
        this.setDiskRoot(disk, id);
      }
      this.focusedDiskId = disk.id;
    }

    this.selected = id;
    if (pulse) {
      // The pulse only means anything once the wedge is where it is going to
      // stay, so it starts when the re-root transition ENDS (immediately when
      // there was no re-root to make).
      this.pulseNodeId = id;
      this.pulseDiskId = disk.id;
      this.pulseStart =
        disk.transitionStart > 0 ? disk.transitionStart + TRANSITION_MS : performance.now();
    }
    this.edgesDirty = true;
    this.requestDraw();
    this.callbacks.onSelect(node);
    return true;
  }

  /**
   * A disk that already renders `id` — the focused one first, then creation
   * order, so a ⌘P repeat keeps landing in the same place.
   */
  private diskShowing(id: string): DiskState | null {
    const focused = this.focused();
    if (focused.layout?.byNode.has(id) || focused.rootId === id) return focused;
    for (const disk of this.disks) {
      if (disk.layout?.byNode.has(id) || disk.rootId === id) return disk;
    }
    return null;
  }

  /**
   * Arrow-key navigation over the disk (round 4), on the FOCUSED disk.
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
    const disk = this.focused();
    const layout = disk.layout;
    const model = this.model;
    if (!layout || !model) return false;

    const current = this.selected ? layout.byNode.get(this.selected) : undefined;
    if (!current) {
      const first = this.visibleRing(disk, 1)[0];
      return first ? this.selectArc(disk, first) : false;
    }

    if (direction === 'up') {
      const parent = current.parentKey ? layout.byKey.get(current.parentKey) : undefined;
      return parent && !this.isHiddenArc(parent) ? this.selectArc(disk, parent) : false;
    }
    if (direction === 'down') {
      const child = this.visibleRing(disk, current.ring + 1).find(
        (arc) => arc.parentKey === current.key
      );
      return child ? this.selectArc(disk, child) : false;
    }

    const siblings = this.visibleRing(disk, current.ring).filter(
      (arc) => arc.parentKey === current.parentKey && arc.parentNodeId === current.parentNodeId
    );
    if (siblings.length === 0) return false;
    const index = siblings.indexOf(current);
    if (index < 0) return false;
    const step = direction === 'next' ? 1 : -1;
    const next = siblings[(index + step + siblings.length) % siblings.length]!;
    return next === current ? false : this.selectArc(disk, next);
  }

  /** Enter: re-root the FOCUSED disk onto the selection — the drill-in. */
  enterSelected(): boolean {
    const id = this.selected;
    const disk = this.focused();
    if (!id || !this.model?.nodes.has(id) || id === disk.rootId) return false;
    this.setDiskRoot(disk, id);
    return true;
  }

  /** Arcs of one ring in display order, minus the categories switched off. */
  private visibleRing(disk: DiskState, ring: number): SunburstArc[] {
    const arcs = disk.layout?.byRing[ring] ?? [];
    return arcs.filter((arc) => !this.isHiddenArc(arc));
  }

  /** Select the node an arc renders (a `+N` arc has none) and publish it. */
  private selectArc(disk: DiskState, arc: SunburstArc): boolean {
    const node = arc.nodeId ? this.model?.get(arc.nodeId) : undefined;
    if (!node) return false;
    this.focusedDiskId = disk.id;
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
    return new Set([this.primary().rootId]);
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
   * "fewer glows", never to an error. The sets are NODE-level, so every disk
   * projects them for itself and a card lights its answer wherever it is shown.
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

  /**
   * Re-fit: frame the WHOLE workspace, every disk included.
   *
   * With one disk this is the old "reset zoom and pan" exactly — the camera is
   * anchored to the primary disk's centre, so a single disk at the origin needs
   * `zoom = 1, pan = 0` to fill the free viewport, which is what `fitCamera`
   * returns for it.
   */
  fitView(): void {
    const bounds = workspaceBounds(this.placements());
    const camera = fitCamera(bounds, {
      width: this.availableWidth(),
      height: this.height,
      padding: VIEW_PADDING,
      baseScale: this.baseScale(),
      zoomMin: ZOOM_MIN,
      zoomMax: ZOOM_MAX,
    });
    this.zoom = camera.zoom;
    this.panX = camera.panX;
    this.panY = camera.panY;
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

  /**
   * The (cached) layout for a root under the current model, sort mode and
   * COLLAPSED set — all three are inputs to `computeSunburst`, so all three are
   * in the key. Closing a disk restores the previous signature, and with it the
   * layouts computed under it, so a spawn/close round trip still costs nothing.
   */
  private layoutFor(rootId: string): SunburstLayout {
    const suffix = `|${this.sortMode}|${this.collapsedSignature}`;
    const key = `${rootId}${suffix}`;
    const cached = this.layoutCache.get(key);
    if (cached) return cached;
    const layout = computeSunburst(this.model!, rootId, {
      sort: this.sortMode,
      collapsed: new Set(this.expandedNodes.keys()),
    });
    this.layoutCache.set(key, layout);
    // `computeSunburst` may fall back to the project root for an unknown id;
    // cache the answer under the root it actually produced too.
    this.layoutCache.set(`${layout.rootId}${suffix}`, layout);
    return layout;
  }

  private rebuildAllLayouts(): void {
    if (!this.model) return;
    for (const disk of this.disks) {
      disk.layout = this.layoutFor(disk.rootId);
      disk.rootId = disk.layout.rootId;
      this.buildLabelGeometry(disk);
    }
    this.projectHighlight();
    this.edgesDirty = true;
    this.requestDraw();
    this.emitSummary();
  }

  private rebuildLayout(disk: DiskState): void {
    if (!this.model) return;
    disk.layout = this.layoutFor(disk.rootId);
    disk.rootId = disk.layout.rootId;
    this.buildLabelGeometry(disk);
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
  private buildLabelGeometry(disk: DiskState): void {
    disk.labelGeom = [];
    disk.labelPlan = null;
    const layout = disk.layout;
    if (!layout) return;
    for (const arc of layout.arcs) {
      const mid = (arc.a0 + arc.a1) / 2;
      const midRadius = (arc.r0 + arc.r1) / 2;
      const span = arc.a1 - arc.a0;
      disk.labelGeom.push({
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
   * Map highlighted NODE ids onto the arcs that actually render them, in EVERY
   * disk.
   *
   * A changed symbol inside a collapsed directory has no arc of its own, so its
   * rim is drawn on the deepest ancestor arc that IS on screen — otherwise a
   * whole edit would silently vanish when the user zooms out. Running this per
   * disk is what makes a card's highlight, the change rims and impact mode apply
   * uniformly across the workspace for free.
   */
  private projectHighlight(): void {
    this.focusArcsPresent = false;
    for (const disk of this.disks) {
      disk.resultArcs = new Set();
      disk.changedArcs = new Set();
      disk.impactedArcs = new Set();
      disk.impactModeArcs = new Set();
      if (!disk.layout) continue;
      const project = (ids: Set<string>, into: Set<string>): void => {
        for (const id of ids) {
          const arc = this.resolveArc(disk, id);
          if (arc) into.add(arc.key);
        }
      };
      project(this.resultNodes, disk.resultArcs);
      project(this.changedNodes, disk.changedArcs);
      project(this.impactedNodes, disk.impactedArcs);
      project(this.impactModeNodes, disk.impactModeArcs);
      if (disk.resultArcs.size > 0 || disk.impactModeArcs.size > 0) this.focusArcsPresent = true;
    }
  }

  /** Project the hover's connectivity onto every disk's own arcs. */
  private projectHover(): void {
    for (const disk of this.disks) {
      if (!this.hoverNodes) {
        disk.hoverArcs = null;
        continue;
      }
      const into = new Set<string>();
      for (const id of this.hoverNodes) {
        const arc = this.resolveArc(disk, id);
        if (arc) into.add(arc.key);
      }
      if (disk.id === this.hoveredDiskId && this.hoveredKey && this.hoveredKey !== CENTRE_KEY) {
        into.add(this.hoveredKey);
      }
      disk.hoverArcs = into;
    }
  }

  /**
   * The deepest RENDERED arc of `disk` standing in for a node.
   *
   * `null` means the centre — either that disk's root itself or something
   * outside its subtree entirely, which is exactly where such an edge should
   * appear to leave from.
   */
  private resolveArc(disk: DiskState, id: string): SunburstArc | null {
    const layout = disk.layout;
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

  /** Free width, i.e. the viewport minus the floating card column. */
  private availableWidth(): number {
    const gutter = this.width > GUTTER_MIN_WIDTH ? PANEL_GUTTER : 0;
    return Math.max(120, this.width - gutter);
  }

  /**
   * Where workspace `(0, 0)` sits with no pan applied.
   *
   * Biased right of centre: the cards / status column floats over the left of
   * the viewport, and a disk centred under it would be half-covered.
   */
  private centre(): Point {
    const gutter = this.width > GUTTER_MIN_WIDTH ? PANEL_GUTTER : 0;
    return { x: gutter + this.availableWidth() / 2, y: this.height / 2 };
  }

  /**
   * Screen px per layout unit at zoom 1 — the scale that fits the PRIMARY disk
   * in the space the floating panels leave free.
   *
   * Anchoring the base scale (and the origin) to the primary disk rather than to
   * the workspace bounding box is deliberate: spawning a disk must not shove the
   * picture the user is reading. Framing the whole workspace is what `fitView`
   * is for, and it is an explicit gesture.
   */
  private baseScale(): number {
    const radius = Math.max(60, Math.min(this.availableWidth(), this.height) / 2 - VIEW_PADDING);
    return radius / (this.primary().layout?.maxRadius ?? MAX_RADIUS);
  }

  private scale(): number {
    return this.baseScale() * this.zoom;
  }

  private origin(): Point {
    const centre = this.centre();
    return { x: centre.x + this.panX, y: centre.y + this.panY };
  }

  /** Screen → workspace. The disk-local step is `toDiskLocal` on top of this. */
  private toWorkspace(screenX: number, screenY: number): Point {
    const origin = this.origin();
    const scale = this.scale();
    return { x: (screenX - origin.x) / scale, y: (screenY - origin.y) / scale };
  }

  /** Workspace → screen. */
  private toScreen(point: Point): Point {
    const origin = this.origin();
    const scale = this.scale();
    return { x: origin.x + point.x * scale, y: origin.y + point.y * scale };
  }

  // -------------------------------------------------------------- painting ---

  private requestDraw(): void {
    if (this.frame !== null || this.disposed) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = null;
      if (this.disposed) return;
      this.draw();
      if (this.disks.some((disk) => disk.transitionStart > 0)) this.requestDraw();
    });
  }

  private draw(): void {
    const ctx = this.ctx;
    const ratio = window.devicePixelRatio || 1;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.clearRect(0, 0, this.width, this.height);
    ctx.fillStyle = BACKGROUND;
    ctx.fillRect(0, 0, this.width, this.height);

    const model = this.model;
    if (!model) return;

    if (this.edgesDirty) this.rebuildEdges();

    const origin = this.origin();
    const scale = this.scale();

    for (const disk of this.disks) {
      const layout = disk.layout;
      if (!layout) continue;

      // Re-root transition: pure scale + fade over a layout that never moves.
      let progress = 1;
      if (disk.transitionStart > 0) {
        progress = Math.min(1, (performance.now() - disk.transitionStart) / TRANSITION_MS);
        if (progress >= 1) disk.transitionStart = 0;
        // The re-root animation scales the disk frame by frame, which is a
        // camera move by any other name — the labels ride the last plan through
        // it and are re-planned once it lands.
        this.cameraMoved();
      }
      const eased = 1 - Math.pow(1 - progress, 3);
      const animationScale = disk.transitionFrom + (1 - disk.transitionFrom) * eased;

      ctx.save();
      ctx.translate(origin.x + disk.x * scale, origin.y + disk.y * scale);
      ctx.scale(scale * animationScale, scale * animationScale);
      ctx.globalAlpha = progress < 1 ? 0.25 + 0.75 * eased : 1;

      const k = scale * animationScale;
      this.drawArcs(ctx, disk, layout, model, k);
      this.drawCentre(ctx, disk, layout, k);
      this.drawEdges(ctx, disk.id, k);
      this.drawLabels(ctx, disk, model, k);

      ctx.restore();
    }

    // Cross-disk relations live in workspace space and are drawn once, over the
    // disks: a curve that vanished under an opaque wedge would claim a
    // connection it never showed.
    ctx.save();
    ctx.translate(origin.x, origin.y);
    ctx.scale(scale, scale);
    // Tethers first, so a code edge is never hidden under one.
    this.drawTethers(ctx, scale);
    this.drawEdges(ctx, null, scale);
    ctx.restore();

    this.drawDiskChrome(ctx);
    this.drawGhost(ctx);

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
    disk: DiskState,
    layout: SunburstLayout,
    model: GraphModel,
    k: number
  ): void {
    const pulseAlpha = disk.id === this.pulseDiskId ? this.pulseAlpha() : 0;
    const focus = this.hasFocus();
    for (const arc of layout.arcs) {
      // A category switched off in the legend is not painted at all — it is not
      // dimmed, it is absent (its angular space stays, so nothing else moves).
      if (this.isHiddenArc(arc)) continue;
      const pad = Math.min(0.0022, (arc.a1 - arc.a0) * 0.14);
      const a0 = arc.a0 + pad;
      const a1 = arc.a1 - pad;
      if (a1 <= a0) continue;

      const emphasised = this.isEmphasised(disk, arc);
      let alpha = 0.94 - 0.055 * (arc.ring - 1);
      if (emphasised) alpha = 1;
      else if (focus) alpha *= DIM_ALPHA;

      ctx.beginPath();
      ctx.arc(0, 0, arc.r0, a0, a1);
      ctx.arc(0, 0, arc.r1, a1, a0, true);
      ctx.closePath();
      ctx.fillStyle = withAlpha(this.fillFor(arc, model), alpha);
      ctx.fill();

      // Outlines first, while the annulus is still the current path — the rim
      // below starts a path of its own and would otherwise be stroked twice.
      if (disk.resultArcs.has(arc.key)) {
        ctx.strokeStyle = GLOW_RESULT;
        ctx.lineWidth = 1.6 / k;
        ctx.stroke();
      }
      if (arc.nodeId !== null && arc.nodeId === this.selected) {
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 2 / k;
        ctx.stroke();
      } else if (disk.id === this.hoveredDiskId && arc.key === this.hoveredKey) {
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

      if (disk.changedArcs.has(arc.key)) this.strokeRim(ctx, arc, a0, a1, RIM_CHANGED, 2.8 / k);
      else if (disk.impactedArcs.has(arc.key)) {
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
   * everything an edge connects it to), and the selection. All three are keyed
   * on the NODE, so a wedge lights in every disk that renders it — which is what
   * "selection is global" means on screen.
   */
  private isEmphasised(disk: DiskState, arc: SunburstArc): boolean {
    if (disk.resultArcs.has(arc.key)) return true;
    if (disk.impactModeArcs.has(arc.key)) return true;
    if (this.selected !== null && arc.nodeId === this.selected) return true;
    if (this.isUnderHover(disk, arc)) return true;
    return disk.hoverArcs?.has(arc.key) ?? false;
  }

  /**
   * Is this wedge pushed to the background right now?
   *
   * Two independent focus channels dim: a card's result set (phase D) and, as
   * of phase F, a HOVER — everything the hovered wedge has no edge with fades
   * out at once, so "what does this touch" is answered by looking, not by
   * reading a list. Both use the same {@link DIM_ALPHA}, and neither animates.
   */
  private isDimmed(disk: DiskState, arc: SunburstArc): boolean {
    return this.hasFocus() && !this.isEmphasised(disk, arc);
  }

  /** Is anything focused right now — a card, an impact set, or a hover? */
  private hasFocus(): boolean {
    return this.focusArcsPresent || this.hoverNodes !== null;
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

  private drawCentre(
    ctx: CanvasRenderingContext2D,
    disk: DiskState,
    layout: SunburstLayout,
    k: number
  ): void {
    const hoveredHere = disk.id === this.hoveredDiskId && this.hoveredKey === CENTRE_KEY;
    ctx.beginPath();
    ctx.arc(0, 0, layout.centreRadius - 3, 0, Math.PI * 2);
    ctx.fillStyle = CENTRE_FILL;
    ctx.fill();

    // The border says WHAT THIS DISK IS ROOTED AT: the root's own colour under
    // the ACTIVE colour mode, through the same `colorForNode` + palette the
    // wedges use — grey for a directory, its kind's (or layer's) colour for a
    // file/class/function. Together with the size (which says how much it
    // holds) it gives every disk in a workspace an identity you can read
    // without following a tether. It re-colours when the mode switches,
    // because it is derived, not stored.
    ctx.strokeStyle = this.model
      ? colorForNode(layout.root, this.colorMode, this.model.layers)
      : CENTRE_STROKE;
    ctx.lineWidth = CENTRE_BORDER / k;
    ctx.stroke();

    // Hover and keyboard focus are TRANSIENT states, so they are drawn just
    // outside the identity border rather than replacing it — losing a disk's
    // colour the moment you point at it is exactly the wrong trade. The focus
    // ring only appears once there is more than one disk: with one disk "which
    // disk has the keyboard" is not a question anyone is asking.
    const focusedHere = this.disks.length > 1 && disk.id === this.focusedDiskId;
    if (hoveredHere || focusedHere) {
      ctx.beginPath();
      ctx.arc(0, 0, layout.centreRadius - 0.6, 0, Math.PI * 2);
      ctx.strokeStyle = hoveredHere ? 'rgba(255,255,255,0.7)' : FOCUS_RING;
      ctx.lineWidth = (focusedHere && !hoveredHere ? 2 : 1.4) / k;
      ctx.stroke();
    }

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

  /**
   * The EXPANSION tethers: one quiet line per secondary disk, from the rim of
   * the disk holding its collapsed wedge to the nearest point on its own rim.
   *
   * It answers "which of these disks came from where" — the question a
   * workspace of four disks otherwise leaves unanswered. It is deliberately not
   * a code edge and does not look like one: neutral, thin, solid, and ALWAYS
   * visible, where relations are drawn only on hover/selection and carry the
   * green/amber direction colours. The anchor is the collapsed wedge's mid
   * angle, so the line leaves the disk pointing at the thing it expanded.
   */
  private drawTethers(ctx: CanvasRenderingContext2D, k: number): void {
    if (this.disks.length < 2) return;
    ctx.lineCap = 'round';
    ctx.setLineDash([]);
    for (const disk of this.disks) {
      const curve = this.tetherOf(disk);
      if (!curve) continue;
      const hot = this.tetherHoverDiskId === disk.id;
      ctx.strokeStyle = hot ? TETHER_COLOR_HOVER : TETHER_COLOR;
      ctx.lineWidth = (hot ? TETHER_WIDTH_PX * 1.6 : TETHER_WIDTH_PX) / k;
      ctx.beginPath();
      ctx.moveTo(curve.start.x, curve.start.y);
      ctx.bezierCurveTo(
        curve.control1.x,
        curve.control1.y,
        curve.control2.x,
        curve.control2.y,
        curve.end.x,
        curve.end.y
      );
      ctx.stroke();
    }
  }

  /**
   * A disk's tether, in workspace coordinates — `null` for the primary disk, a
   * disk with no source, or a pair that overlaps too far to draw an honest line
   * between (see {@link tetherCurve}).
   *
   * The source ANCHOR is the rim of the disk that holds the collapsed wedge, at
   * that wedge's mid angle — which is where the wedge's own rim-stretched spoke
   * ends, so the curve continues the wedge outward. The disk the drag STARTED
   * in answers when it still renders the wedge; otherwise (it was re-rooted
   * away) any disk that does will do, in creation order. When no disk renders
   * the wedge at all the source disk still answers, from the point of its rim
   * facing the expanded disk: the tether is also where the close button lives,
   * so it must survive a re-root that hid the wedge it came from.
   */
  private tetherOf(disk: DiskState): TetherCurve | null {
    const nodeId = disk.source;
    if (disk.primary || !nodeId) return null;
    const target: DiskPlacement = {
      id: disk.id,
      x: disk.x,
      y: disk.y,
      radius: disk.layout?.maxRadius ?? MAX_RADIUS,
    };
    const preferred = this.diskById(disk.sourceDiskId);
    const candidates = preferred ? [preferred, ...this.disks] : this.disks;
    for (const holder of candidates) {
      if (holder.id === disk.id || !holder.layout) continue;
      const arc = holder.layout.byNode.get(nodeId);
      if (!arc) continue;
      const source: DiskPlacement = {
        id: holder.id,
        x: holder.x,
        y: holder.y,
        radius: holder.layout.maxRadius,
      };
      return tetherCurve(source, (arc.a0 + arc.a1) / 2, target);
    }
    if (!preferred?.layout) return null;
    const source: DiskPlacement = {
      id: preferred.id,
      x: preferred.x,
      y: preferred.y,
      radius: preferred.layout.maxRadius,
    };
    return tetherCurve(source, Math.atan2(disk.y - preferred.y, disk.x - preferred.x), target);
  }

  /** Paint the relations belonging to one disk (`null` = the cross-disk set). */
  private drawEdges(ctx: CanvasRenderingContext2D, diskId: string | null, k: number): void {
    if (this.drawnEdges.length === 0) return;
    ctx.lineCap = 'round';
    for (const drawn of this.drawnEdges) {
      if (drawn.diskId !== diskId) continue;
      if (drawn.points.length < 2) continue;
      const hovered = drawn.edge.key === this.hoveredEdgeKey;
      ctx.beginPath();
      ctx.moveTo(drawn.points[0]!.x, drawn.points[0]!.y);
      for (let i = 1; i < drawn.points.length; i++) {
        ctx.lineTo(drawn.points[i]!.x, drawn.points[i]!.y);
      }
      // Colour is DIRECTION relative to the focused wedge (green in, amber
      // out), never the edge kind — see `palette.ts`. A cross-disk curve obeys
      // exactly the same rule; only the routing differs.
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
  private drawLabels(
    ctx: CanvasRenderingContext2D,
    disk: DiskState,
    model: GraphModel,
    k: number
  ): void {
    // While the camera is moving the last PLAN is replayed through arithmetic
    // gates only. Rebuilding it costs an orientation choice and a `measureText`
    // per candidate wedge, which at 60fps is exactly the judder the round-4
    // review reported; the gates below are a handful of multiplications and the
    // real pass runs the moment the gesture stops.
    const reuse = this.cameraSettling() && disk.labelPlan !== null;
    const plan = reuse ? disk.labelPlan! : this.buildLabelPlan(ctx, disk, k);
    if (!reuse) disk.labelPlan = plan;

    for (const label of plan) {
      const arc = label.geom.arc;
      if (this.isHiddenArc(arc)) continue;
      if (reuse && !this.planStillFits(label, k)) continue;
      const ink = this.isDimmed(disk, arc) ? DIM_LABEL_COLOR : readableOn(this.fillFor(arc, model));
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
  private buildLabelPlan(
    ctx: CanvasRenderingContext2D,
    disk: DiskState,
    k: number
  ): PlannedLabel[] {
    const plan: PlannedLabel[] = [];
    for (const geom of disk.labelGeom) {
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
   * from being a per-zoom-level miss on every entry. The cache is per
   * WORKSPACE, so a second disk pays nothing for names the first already
   * measured.
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

  // ------------------------------------------------------- workspace chrome ---

  /**
   * The `×` on a hovered secondary disk — in the CENTRE circle, under the
   * `N loc` line, drawn in SCREEN space so it keeps its size at every zoom.
   *
   * It sat on the rim through phase G1, where it competed with the wedges for
   * the eye and moved with the disk's radius. The centre circle is the one part
   * of a disk that is always chrome rather than data, and "close this disk" is
   * chrome. No transitions, like every other surface here.
   */
  private drawDiskChrome(ctx: CanvasRenderingContext2D): void {
    if (this.disks.length < 2) return;
    for (const disk of this.disks) {
      if (disk.primary) continue;
      // The `×` belongs to the TETHER: it is up while the pointer is on the
      // line (or on the button itself), and nowhere else. Hovering the disk
      // raises nothing — a disk is data, and closing it is not.
      const shown = this.tetherHoverDiskId === disk.id || this.closeHoverDiskId === disk.id;
      if (!shown) continue;
      const anchor = this.closeAnchorScreen(disk);
      if (!anchor) continue;
      const hot = this.closeHoverDiskId === disk.id;
      ctx.beginPath();
      ctx.arc(anchor.x, anchor.y, CLOSE_RADIUS_PX, 0, Math.PI * 2);
      ctx.fillStyle = hot ? 'rgba(80, 30, 40, 0.95)' : 'rgba(20, 28, 44, 0.92)';
      ctx.fill();
      ctx.strokeStyle = hot ? '#f87171' : 'rgba(150, 175, 210, 0.7)';
      ctx.lineWidth = 1.2;
      ctx.stroke();

      const arm = CLOSE_RADIUS_PX * 0.42;
      ctx.beginPath();
      ctx.moveTo(anchor.x - arm, anchor.y - arm);
      ctx.lineTo(anchor.x + arm, anchor.y + arm);
      ctx.moveTo(anchor.x + arm, anchor.y - arm);
      ctx.lineTo(anchor.x - arm, anchor.y + arm);
      ctx.strokeStyle = hot ? '#fecaca' : 'rgba(215, 230, 250, 0.9)';
      ctx.lineWidth = 1.6;
      ctx.stroke();
    }
  }

  /**
   * The drag-away ghost: a circle outline and the node's name, following the
   * cursor once the pointer has left the source disk.
   *
   * It appears exactly when the gesture becomes a spawn, which is the whole
   * point — before the pointer crosses the rim the drag is still a no-op that
   * falls back to a click, and showing a ghost then would promise a disk the
   * release is not going to create.
   */
  private drawGhost(ctx: CanvasRenderingContext2D): void {
    const drag = this.drag;
    if (!drag || drag.mode !== 'wedge' || !drag.outside) return;
    const radius = drag.preview
      ? Math.max(24, Math.min(GHOST_RADIUS_PX * 3, drag.preview.maxRadius * this.scale()))
      : GHOST_RADIUS_PX;
    ctx.beginPath();
    ctx.arc(drag.x, drag.y, radius, 0, Math.PI * 2);
    ctx.fillStyle = GHOST_FILL;
    ctx.fill();
    ctx.strokeStyle = GHOST_STROKE;
    ctx.lineWidth = 1.4;
    ctx.setLineDash([5, 4]);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.font = '600 12px ui-sans-serif, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#dbe4f2';
    ctx.fillText(fitText(ctx, drag.label, radius * 1.9), drag.x, drag.y);
  }

  // ---------------------------------------------------------------- edges ---

  /**
   * Is this arc the hovered one?
   *
   * It used to be "the hovered one **or inside its subtree**", which kept a
   * whole branch lit. Phase G3 narrowed hovering to a node's OWN edges, and the
   * dimming follows the same rule: what stays lit is the wedge under the
   * pointer plus whatever it actually has an edge with. Lighting the subtree
   * made "what does this touch" answer with "everything it contains", which is
   * the containment the disk already draws.
   */
  private isUnderHover(disk: DiskState, arc: SunburstArc): boolean {
    const hovered = this.hoveredKey;
    if (!hovered || hovered === CENTRE_KEY) return false;
    if (disk.id !== this.hoveredDiskId) return false;
    return arc.key === hovered;
  }

  /**
   * Assemble the relations to draw right now.
   *
   * Edges are hidden at rest by design (contract): the disk is the structure,
   * relations are the answer to a question. Three sources ask for them — the
   * hovered wedge, the current selection, and the active card's `edgeRefs`.
   *
   * **Hover and selection show a node's OWN edges, never its subtree's** (phase
   * G3). Aggregating descendants meant hovering a class drew every relation of
   * every method in it — a hairball with no single subject, in which the class's
   * own four relations were unfindable. A child rendered as its own wedge has
   * its own hover; the parent answers for itself. (An aggregate `+N` wedge
   * stands for several nodes at once, so it takes each of their own edges — the
   * same rule, applied to each node the wedge is standing in for.)
   *
   * **Inside a card view the hover is scoped to the card** (phase G3): while a
   * question card carries an edge set, a hover shows the intersection of that
   * set with the hovered node's own edges. A card is a view of one answer, and
   * hovering inside it is a question about that answer, not about the graph.
   *
   * Phase G routes each relation ONCE: both endpoints are matched against every
   * disk, the best match wins, and the edge is bundled inside a disk when the
   * two agree or bowed across the gap when they do not.
   */
  private rebuildEdges(): void {
    this.edgesDirty = false;
    this.drawnEdges = [];
    const model = this.model;
    if (!model) return;

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
    if (this.selected) this.collectOwnEdges([this.selected], wanted, directions);

    const hoverDisk = this.diskById(this.hoveredDiskId);
    const hoverEdges = new Map<string, ModelEdge>();
    const hoveredArc =
      hoverDisk && this.hoveredKey && this.hoveredKey !== CENTRE_KEY
        ? (hoverDisk.layout?.byKey.get(this.hoveredKey) ?? null)
        : null;
    if (hoveredArc) {
      this.collectOwnEdges(
        hoveredArc.nodeId ? [hoveredArc.nodeId] : hoveredArc.aggregated,
        hoverEdges,
        directions,
        // A card with an edge set scopes the hover to that set; a view with no
        // edges of its own (Changes, Project) leaves the hover unfiltered.
        this.resultEdges.size > 0 ? this.resultEdges : null
      );
      for (const [key, edge] of hoverEdges) {
        if (wanted.size >= EDGE_BUDGET && !wanted.has(key)) break;
        wanted.set(key, edge);
      }
    }

    // Everything the hover reaches — the dimming set, at NODE level so every
    // disk can project it onto whatever arc stands in for the node there. It
    // is derived from the very edges just collected, so the dimming obeys the
    // own-edges rule (and a card's scoping) by construction.
    if (hoveredArc) {
      const nodes = new Set<string>();
      if (hoveredArc.nodeId) nodes.add(hoveredArc.nodeId);
      for (const id of hoveredArc.aggregated) nodes.add(id);
      for (const edge of hoverEdges.values()) {
        nodes.add(edge.source);
        nodes.add(edge.target);
      }
      this.hoverNodes = nodes;
    } else {
      this.hoverNodes = null;
    }

    const preferred = this.hoveredDiskId ?? this.focusedDiskId;
    for (const edge of wanted.values()) {
      const from = this.pickEndpoint(edge.source, preferred);
      const to = this.pickEndpoint(edge.target, preferred);
      if (!from.disk && !to.disk) continue;
      const fromDisk = from.disk ?? to.disk!;
      const toDisk = to.disk ?? from.disk!;
      const direction = directions.get(edge.key) ?? 'neutral';

      if (fromDisk === toDisk) {
        if (from.arc && to.arc && from.arc.key === to.arc.key) continue;
        const layout = fromDisk.layout;
        if (!layout) continue;
        const points = bundleCurve(bundleControlPoints(from.arc, to.arc, layout));
        if (points.length >= 2) {
          this.drawnEdges.push({ edge, points, direction, diskId: fromDisk.id });
        }
        continue;
      }

      const points = crossDiskCurve(
        anchorOf(fromDisk, from.arc),
        anchorOf(toDisk, to.arc)
      );
      this.drawnEdges.push({ edge, points, direction, diskId: null });
    }

    this.projectHover();
  }

  /**
   * How well one disk can show a node, so an edge can be routed to the disk
   * that shows its endpoint BEST.
   *
   * The ladder matters: a node with an arc of its own beats one folded into a
   * `+N`, which beats a disk that only renders an ancestor, which beats a disk
   * that has nothing but its centre to attach to. Score 0 means the node is
   * outside this disk's subtree altogether — the disk does not show it at all,
   * so it cannot claim the edge.
   */
  private endpointIn(disk: DiskState, nodeId: string): { score: number; arc: SunburstArc | null } {
    const layout = disk.layout;
    const model = this.model;
    if (!layout || !model) return { score: 0, arc: null };
    // A subtree that is EXPANDED as its own disk does not answer here (phase
    // G2). The stub this disk draws for it stands for a structure it is no
    // longer showing, so an edge landing on it would attach a relation to a
    // wedge that cannot be read — the disk that expanded the node renders the
    // real endpoint, and scoring 0 here is what routes the edge there.
    if (layout.collapsed.size > 0) {
      if (layout.collapsed.has(nodeId)) return { score: 0, arc: null };
      for (const ancestor of model.ancestors(nodeId)) {
        if (layout.collapsed.has(ancestor)) return { score: 0, arc: null };
        if (ancestor === disk.rootId) break;
      }
    }
    const direct = layout.byNode.get(nodeId);
    if (direct) return { score: 4, arc: direct };
    const folded = layout.aggregatedInto.get(nodeId);
    if (folded) return { score: 3, arc: folded };
    // The disk's own root has no arc — the centre circle IS its wedge.
    if (nodeId === disk.rootId) return { score: 3, arc: null };
    for (const ancestor of model.ancestors(nodeId)) {
      const arc = layout.byNode.get(ancestor);
      if (arc) return { score: 2, arc };
      const aggregate = layout.aggregatedInto.get(ancestor);
      if (aggregate) return { score: 2, arc: aggregate };
      if (ancestor === disk.rootId) return { score: 1, arc: null };
    }
    return { score: 0, arc: null };
  }

  /**
   * The disk that shows a node best. Ties go to the disk the hover (else the
   * focus) came from, then to creation order — so the routing is deterministic
   * and an edge never flickers between two disks that show the same wedge.
   */
  private pickEndpoint(
    nodeId: string,
    preferredDiskId: string | null
  ): { disk: DiskState | null; arc: SunburstArc | null; score: number } {
    let best: { disk: DiskState | null; arc: SunburstArc | null; score: number } = {
      disk: null,
      arc: null,
      score: 0,
    };
    for (const disk of this.disks) {
      const found = this.endpointIn(disk, nodeId);
      if (found.score === 0) continue;
      const wins =
        found.score > best.score ||
        (found.score === best.score &&
          disk.id === preferredDiskId &&
          best.disk?.id !== preferredDiskId);
      if (wins) best = { disk, arc: found.arc, score: found.score };
    }
    return best;
  }

  /**
   * The relations of the seed nodes THEMSELVES — no subtree walk (phase G3).
   *
   * Each edge's DIRECTION is recorded relative to the seed it was found on: one
   * leaving it is outgoing, one arriving at it is incoming. That is the only
   * place the two are distinguishable for free, so it happens here rather than
   * in the painter.
   *
   * `only` scopes the result to an edge set the caller already has — the active
   * card's `edgeRefs`, which is what makes a hover inside a card view a
   * question about that card's answer rather than about the whole graph.
   */
  private collectOwnEdges(
    seeds: string[],
    into: Map<string, ModelEdge>,
    directions?: Map<string, EdgeDirection>,
    only?: ReadonlySet<string> | null
  ): void {
    const model = this.model;
    if (!model) return;
    for (const id of seeds) {
      for (const edge of model.edgesOf(id)) {
        if (into.size >= EDGE_BUDGET) return;
        if (!this.enabledKinds.has(edge.kind)) continue;
        if (edge.source === edge.target) continue;
        if (only && !only.has(edge.key)) continue;
        into.set(edge.key, edge);
        if (directions && !directions.has(edge.key)) {
          directions.set(edge.key, edge.source === id ? 'outgoing' : 'incoming');
        }
      }
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

  /** The disk under a SCREEN point, and that point in its local space. */
  private diskUnder(screen: Point): { disk: DiskState; local: Point } | null {
    const workspace = this.toWorkspace(screen.x, screen.y);
    const placement = diskAt(this.placements(), workspace);
    if (!placement) return null;
    const disk = this.diskById(placement.id);
    if (!disk) return null;
    return { disk, local: toDiskLocal(workspace, placement) };
  }

  /** Screen position of a secondary disk's `×` — the middle of its tether. */
  private closeAnchorScreen(disk: DiskState): Point | null {
    const curve = this.tetherOf(disk);
    return curve ? this.toScreen(closeAnchor(curve)) : null;
  }

  /** The secondary disk whose `×` a screen point is on, if any. */
  private closeButtonUnder(screen: Point): DiskState | null {
    if (this.disks.length < 2) return null;
    for (const disk of this.disks) {
      if (disk.primary) continue;
      const anchor = this.closeAnchorScreen(disk);
      if (!anchor) continue;
      if (Math.hypot(screen.x - anchor.x, screen.y - anchor.y) <= CLOSE_HIT_PX) return disk;
    }
    return null;
  }

  /**
   * The secondary disk whose TETHER a screen point is on — what raises the `×`.
   *
   * The line is the affordance now: hover the thread between a disk and the
   * wedge it came from and the button to cut it appears on the thread itself.
   * Tested against the sampled curve with a small tolerance, exactly like an
   * edge, and it never steals the wedge hover for the same reason edges do not.
   */
  private tetherUnder(screen: Point): DiskState | null {
    if (this.disks.length < 2) return null;
    const workspace = this.toWorkspace(screen.x, screen.y);
    const tolerance = TETHER_HIT_PX / this.scale();
    let best = tolerance;
    let found: DiskState | null = null;
    for (const disk of this.disks) {
      const curve = this.tetherOf(disk);
      if (!curve) continue;
      const distance = distanceToPolyline(tetherPolyline(curve), workspace.x, workspace.y);
      if (distance < best) {
        best = distance;
        found = disk;
      }
    }
    return found;
  }

  private readonly onPointerMove = (event: PointerEvent): void => {
    const position = this.pointerPosition(event);
    const drag = this.drag;
    if (drag) {
      const dx = position.x - drag.lastX;
      const dy = position.y - drag.lastY;
      drag.x = position.x;
      drag.y = position.y;
      if (!drag.moved && Math.hypot(position.x - drag.startX, position.y - drag.startY) < DRAG_SLOP) {
        return;
      }
      drag.moved = true;
      drag.lastX = position.x;
      drag.lastY = position.y;

      if (drag.mode === 'pan') {
        this.panX += dx;
        this.panY += dy;
        this.cameraMoved();
        this.requestDraw();
        return;
      }
      if (drag.mode === 'move-disk') {
        const disk = this.diskById(drag.diskId);
        if (disk) {
          const scale = this.scale();
          disk.x += dx / scale;
          disk.y += dy / scale;
          this.edgesDirty = true;
          this.requestDraw();
        }
        return;
      }
      if (drag.mode === 'wedge') {
        this.updateWedgeDrag(drag, position);
        return;
      }
      return;
    }
    if (this.disks.some((disk) => disk.transitionStart > 0)) return;
    this.updateHover(position);
  };

  /**
   * The spawn threshold: has the pointer left the source disk?
   *
   * Crossing the disk's own outer radius is the gesture, not a pixel distance —
   * "I pulled this out of there" is a spatial claim, and the rim is where the
   * user sees the disk end. Coming back inside cancels it again, so the gesture
   * is reversible right up to the release.
   */
  private updateWedgeDrag(drag: DragState, position: Point): void {
    const disk = this.diskById(drag.diskId);
    if (!disk) return;
    const workspace = this.toWorkspace(position.x, position.y);
    const radius = disk.layout?.maxRadius ?? MAX_RADIUS;
    const distance = Math.hypot(workspace.x - disk.x, workspace.y - disk.y);
    const outside = distance > radius;
    if (outside && !drag.preview && drag.nodeId && this.model) {
      // One layout, computed the moment the ghost appears (and cached, so the
      // drop itself is free) — the preview circle is then the disk's real size.
      drag.preview = this.layoutFor(drag.nodeId);
    }
    drag.outside = outside;
    this.canvas.style.cursor = outside ? 'copy' : 'grabbing';
    this.requestDraw();
  }

  /**
   * Where a gesture is decided. Three of them share the canvas, and the
   * ambiguity is resolved entirely by WHAT IS UNDER THE POINTER AT PRESS TIME:
   *
   *  - a wedge that renders a node → a **spawn** candidate. It becomes a spawn
   *    only if the pointer crosses the disk's outer radius before release;
   *    otherwise it is a no-op and the click underneath does the selecting.
   *  - anywhere else inside a disk — the centre circle, the gaps between
   *    wedges, a `+N` fold arc, a wedge whose category the legend switched off
   *    → **move that disk**. Anything that is not a wedge is grab-able, which
   *    is the robust reading: the alternative (a dedicated handle) is a target
   *    the user has to find.
   *  - empty canvas → **pan** the workspace camera, unchanged from phase F.
   *  - a secondary disk's `×` → close it on release.
   *
   * Pressing anywhere inside a disk also FOCUSES it, so the keyboard follows
   * the pointer without a second gesture.
   */
  private readonly onPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0) return;
    const position = this.pointerPosition(event);

    const base: DragState = {
      mode: 'pan',
      moved: false,
      lastX: position.x,
      lastY: position.y,
      startX: position.x,
      startY: position.y,
      x: position.x,
      y: position.y,
      diskId: null,
      nodeId: null,
      label: '',
      outside: false,
      preview: null,
    };

    const closing = this.closeButtonUnder(position);
    if (closing) {
      this.drag = { ...base, mode: 'close', diskId: closing.id };
    } else {
      const hit = this.diskUnder(position);
      if (!hit) {
        this.drag = base;
      } else {
        const refocused = this.focusedDiskId !== hit.disk.id;
        this.focusedDiskId = hit.disk.id;
        if (refocused) this.emitSummary();
        const layout = hit.disk.layout;
        const arc = layout ? this.hitArc(layout, hit.local.x, hit.local.y) : null;
        if (arc?.nodeId) {
          this.drag = {
            ...base,
            mode: 'wedge',
            diskId: hit.disk.id,
            nodeId: arc.nodeId,
            label: this.model?.get(arc.nodeId)?.name ?? arc.label,
          };
        } else {
          this.drag = { ...base, mode: 'move-disk', diskId: hit.disk.id };
        }
        this.requestDraw();
      }
    }

    // Capture so a gesture that leaves the canvas keeps tracking. Both calls
    // are guarded: releasing a pointer the browser already released throws.
    try {
      this.canvas.setPointerCapture(event.pointerId);
    } catch {
      /* capture is an optimisation, not a requirement */
    }
  };

  private readonly onPointerUp = (event: PointerEvent): void => {
    const drag = this.drag;
    this.drag = null;
    try {
      this.canvas.releasePointerCapture(event.pointerId);
    } catch {
      /* already released (pointercancel) */
    }
    if (!drag) return;
    const position = this.pointerPosition(event);
    this.canvas.style.cursor = 'default';

    if (drag.mode === 'close') {
      const still = this.closeButtonUnder(position);
      this.suppressClick = true;
      if (still && still.id === drag.diskId) this.closeDisk(drag.diskId);
      return;
    }

    if (drag.mode === 'wedge') {
      if (drag.moved && drag.outside && drag.nodeId) {
        this.spawnDisk(
          drag.nodeId,
          this.toWorkspace(position.x, position.y),
          drag.diskId,
          drag.preview
        );
        this.suppressClick = true;
        return;
      }
      // A drag that never left the disk is a no-op: the click that follows does
      // the selecting, exactly as if the pointer had never moved.
      this.suppressClick = false;
      this.requestDraw();
      return;
    }

    this.suppressClick = drag.moved;
  };

  private readonly onPointerLeave = (): void => {
    this.drag = null;
    this.closeHoverDiskId = null;
    this.tetherHoverDiskId = null;
    this.setHover(null, null, null);
  };

  private readonly onClick = (event: MouseEvent): void => {
    if (this.suppressClick) {
      this.suppressClick = false;
      return;
    }
    const model = this.model;
    if (!model) return;
    const position = this.pointerPosition(event);
    const hit = this.diskUnder(position);
    if (!hit) {
      this.selected = null;
      this.edgesDirty = true;
      this.requestDraw();
      this.callbacks.onSelect(null);
      return;
    }
    const { disk, local } = hit;
    // A click landing mid-transition would be hit-tested against the settled
    // geometry while the user is looking at the animating one. It also makes
    // the second click of a double-click on a directory re-root twice.
    if (disk.transitionStart > 0) return;
    const layout = disk.layout;
    if (!layout) return;
    this.focusedDiskId = disk.id;

    if (Math.hypot(local.x, local.y) <= layout.centreRadius) {
      const parent = model.get(disk.rootId)?.parent;
      if (parent) this.setDiskRoot(disk, parent);
      return;
    }

    const arc = this.hitArc(layout, local.x, local.y);
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
      if (arc.parentNodeId !== disk.rootId) this.setDiskRoot(disk, arc.parentNodeId);
      return;
    }

    const node = model.get(arc.nodeId);
    if (!node) return;
    if (node.kind === DIRECTORY_KIND) {
      this.setDiskRoot(disk, node.id);
      return;
    }
    this.selected = node.id;
    this.edgesDirty = true;
    this.requestDraw();
    this.callbacks.onSelect(node);
  };

  /** Double-click drills into anything with children — files included. */
  private readonly onDoubleClick = (event: MouseEvent): void => {
    const model = this.model;
    if (!model) return;
    const position = this.pointerPosition(event);
    const hit = this.diskUnder(position);
    if (!hit?.disk.layout) return;
    // Double-clicking a DIRECTORY already re-rooted on the first click; the
    // arc now under the cursor belongs to a different level entirely.
    if (performance.now() - hit.disk.rootChangedAt < 450) return;
    const arc = this.hitArc(hit.disk.layout, hit.local.x, hit.local.y);
    if (!arc?.nodeId) return;
    if (model.childrenOf(arc.nodeId).length === 0) return;
    this.setDiskRoot(hit.disk, arc.nodeId);
  };

  private readonly onWheel = (event: WheelEvent): void => {
    event.preventDefault();
    const position = this.pointerPosition(event);
    const before = this.toWorkspace(position.x, position.y);
    const factor = Math.exp(-event.deltaY * 0.0015);
    const next = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, this.zoom * factor));
    if (next === this.zoom) return;
    this.zoom = next;
    // Keep the workspace point under the cursor pinned to the cursor.
    const centre = this.centre();
    const scale = this.scale();
    this.panX = position.x - before.x * scale - centre.x;
    this.panY = position.y - before.y * scale - centre.y;
    this.cameraMoved();
    this.requestDraw();
    this.emitSummary();
  };

  private updateHover(position: Point): void {
    const closeHover = this.closeButtonUnder(position);
    // The `×` sits ON the tether, so the button's own hit area always counts as
    // the line's too — the affordance cannot flicker out from under the pointer
    // on its way to the thing it raised.
    const tetherHover = closeHover ?? this.tetherUnder(position);
    if (closeHover?.id !== this.closeHoverDiskId || tetherHover?.id !== this.tetherHoverDiskId) {
      this.closeHoverDiskId = closeHover?.id ?? null;
      this.tetherHoverDiskId = tetherHover?.id ?? null;
      this.requestDraw();
    }
    if (closeHover) {
      // The pointer is on a button: no wedge hover, no tooltip, and the press
      // must not read as anything the disk underneath would have done.
      this.setHover(null, null, null);
      this.canvas.style.cursor = 'pointer';
      return;
    }

    const workspace = this.toWorkspace(position.x, position.y);

    // Edges are only hit-tested among the ones already on screen, and they do
    // NOT steal the arc hover — otherwise hovering an arc would reveal an edge
    // under the cursor, drop the arc hover, hide the edge, and loop forever.
    let edgeKey: string | null = null;
    if (this.drawnEdges.length > 0) {
      const tolerance = 5 / this.scale();
      let best = tolerance;
      for (const drawn of this.drawnEdges) {
        const owner = drawn.diskId ? this.diskById(drawn.diskId) : null;
        const x = owner ? workspace.x - owner.x : workspace.x;
        const y = owner ? workspace.y - owner.y : workspace.y;
        const distance = distanceToPolyline(drawn.points, x, y);
        if (distance < best) {
          best = distance;
          edgeKey = drawn.edge.key;
        }
      }
    }

    const hit = this.diskUnder(position);
    if (!hit?.disk.layout) {
      this.setHover(null, null, edgeKey);
      return;
    }
    const radius = Math.hypot(hit.local.x, hit.local.y);
    const arcKey =
      radius <= hit.disk.layout.centreRadius
        ? CENTRE_KEY
        : (this.hitArc(hit.disk.layout, hit.local.x, hit.local.y)?.key ?? null);
    this.setHover(hit.disk.id, arcKey, edgeKey, position.x, position.y);
  }

  /**
   * Hover is only published when the TARGET changes, never on every pointer
   * move: a tooltip that re-renders the React chrome 60 times a second is how
   * a canvas app ends up feeling slower than the canvas is.
   */
  private setHover(
    diskId: string | null,
    arcKey: string | null,
    edgeKey: string | null,
    x = 0,
    y = 0
  ): void {
    const arcChanged = arcKey !== this.hoveredKey || diskId !== this.hoveredDiskId;
    const edgeChanged = edgeKey !== this.hoveredEdgeKey;
    if (!arcChanged && !edgeChanged) return;
    this.hoveredDiskId = diskId;
    this.hoveredKey = arcKey;
    this.hoveredEdgeKey = edgeKey;
    this.canvas.style.cursor = arcKey ? 'pointer' : diskId ? 'grab' : 'default';
    if (arcChanged) this.edgesDirty = true;
    this.emitTooltips(x, y);
    this.requestDraw();
  }

  private emitTooltips(x: number, y: number): void {
    const model = this.model;
    const disk = this.diskById(this.hoveredDiskId);
    if (!model || !disk?.layout) {
      this.callbacks.onArcTooltip(null);
      return;
    }

    // An edge under the pointer highlights its rope and NOTHING else — phase F
    // removed the edge tooltip outright (see `CanvasCallbacks.onArcTooltip`).
    if (!this.hoveredKey || this.hoveredKey === CENTRE_KEY) {
      this.callbacks.onArcTooltip(null);
      return;
    }
    const arc = disk.layout.byKey.get(this.hoveredKey);
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
    if (!model) return;
    const focused = this.focused();
    if (!focused.layout) return;
    const present = new Set<string>();
    let arcs = 0;
    let rings = 0;
    let truncated = false;
    for (const disk of this.disks) {
      const layout = disk.layout;
      if (!layout) continue;
      arcs += layout.arcs.length;
      if (layout.rings > rings) rings = layout.rings;
      truncated ||= layout.truncated;
      for (const arc of layout.arcs) {
        if (!arc.nodeId) continue;
        const node = model.get(arc.nodeId);
        if (!node) continue;
        if (this.colorMode !== 'layer') {
          present.add(node.kind);
          continue;
        }
        // In the layer mode a directory is grey, not "no layer" — it gets its
        // own legend row so the two greys/teals can't be confused (phase F).
        present.add(node.kind === DIRECTORY_KIND ? DIRECTORY_LEGEND_KEY : (node.layer ?? ''));
      }
    }
    this.emittedEdges = this.drawnEdges.length;
    this.callbacks.onViewChange({
      arcs,
      rings,
      truncated,
      visibleEdges: this.drawnEdges.length,
      presentColorKeys: [...present],
      edgeKinds: [...model.edgeKinds],
      enabledKinds: [...this.enabledKinds],
      breadcrumb: focused.layout.trail.map((node) => ({ id: node.id, name: node.name })),
      zoom: this.zoom,
      disks: this.disks.length,
    });
  }
}

/** Pseudo arc key for the centre disk, so hover has one vocabulary. */
const CENTRE_KEY = '@centre';

/** The one disk the URL describes; it exists for the session's whole life. */
const PRIMARY_DISK_ID = 'primary';

/** The render budget, re-exported so the chrome can show `arcs / budget`. */
export { MAX_ARCS as ARC_BUDGET };

function makeDisk(
  id: string,
  rootId: string,
  x: number,
  y: number,
  primary: boolean,
  source: string | null,
  sourceDiskId: string | null = null
): DiskState {
  return {
    id,
    rootId,
    x,
    y,
    primary,
    source,
    sourceDiskId,
    layout: null,
    labelGeom: [],
    labelPlan: null,
    resultArcs: new Set(),
    changedArcs: new Set(),
    impactedArcs: new Set(),
    impactModeArcs: new Set(),
    hoverArcs: null,
    transitionStart: 0,
    transitionFrom: 1,
    rootChangedAt: -Infinity,
  };
}

/** Workspace point an edge attaches to: a wedge's centroid, else the centre. */
function anchorOf(disk: DiskState, arc: SunburstArc | null): Point {
  if (!arc) return { x: disk.x, y: disk.y };
  const centroid = arcCentroid(arc);
  return { x: disk.x + centroid.x, y: disk.y + centroid.y };
}

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
