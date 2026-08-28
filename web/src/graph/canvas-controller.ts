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
 *  - the persistent highlight a card drives and the standing change overlay,
 *    both applied uniformly to every disk.
 *
 * Edges are **hidden at rest**. They appear for the hovered arc's subtree, the
 * current selection, or the active card's `edgeRefs` — bundled along the
 * hierarchy so a hundred relations read as one rope (`bundling.ts`) when both
 * ends live in the same disk, and as one bowed curve (`workspace.ts`) when they
 * do not.
 */
import { fetchSource, fetchSourceDiff, openInEditor, type DiffHunk } from '@/lib/api';
import { formatNumber } from '@/lib/utils';

import { BubbleView, type BubbleCallSite, type BubbleLabelGeometry } from './bubble-view';
import { spanChangeMarks, spanChangesEmpty } from './changes';
import {
  bundleControlPoints,
  bundleCurve,
  distanceToPolyline,
} from './bundling';
import { DIRECTORY_KIND, ROOT_ID, type GraphModel, type ModelEdge, type ModelNode } from './model';
import {
  CHANGE_ADDED_COLOR,
  CHANGE_REMOVED_COLOR,
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
  MIN_ARC_ANGLE,
  TAU,
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
  DISK_GAP,
  closeAnchor,
  contentBounds,
  crossDiskCurve,
  diskAt,
  fitCamera,
  placeSpawnedDisk,
  planExpansion,
  tetherCurve,
  tetherPolyline,
  toDiskLocal,
  type BubbleAnchor,
  type BubbleSpawnRequest,
  type DiskPlacement,
  type DiskSpawnRequest,
  type Rect,
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
 * What a card asks the canvas to light up.
 *
 * Just the ONE channel since round B4: "the answer to this question". Changes
 * used to ride in here too (`changed` / `impacted`), because they were a card —
 * a standing view you switched TO. They are now a standing ANNOTATION with a
 * toggle of their own ({@link ChangeOverlay}), which is a different lifetime:
 * a card's highlight is replaced whenever another card is activated, and the
 * changes must survive that.
 */
export interface CanvasHighlight {
  /** Result nodes of a card — glowed, everything else dimmed. */
  nodes?: Iterable<string>;
  /** Result edges, matched to model edges by (source, target, kind). */
  edges?: Iterable<{ source: string; target: string; kind: string }>;
}

/**
 * Uncommitted work, as a standing annotation on every disk (round B4).
 *
 * One object rather than three setters because the three parts are one fact
 * and are switched on and off together by one toggle: `markers` sizes the
 * green/red sub-wedges, `changed` gives an edited node its hot rim, `impacted`
 * gives a node that depends on one a warm rim. `null` means the toggle is off
 * (or there is nothing uncommitted) and nothing at all is drawn.
 *
 * Deliberately NOT a focus channel: unlike a card's result it dims nothing, so
 * it can be on while you read anything else.
 */
export interface ChangeOverlay {
  /** File node id → the share of its lines added / removed. */
  markers: Iterable<[string, ChangeMarker]>;
  /** Nodes with uncommitted edits — hot rim. */
  changed: Iterable<string>;
  /** Nodes within the impact radius of a change — warm rim. */
  impacted: Iterable<string>;
}

/**
 * One spawned disk, as the workspace is written down and read back (round
 * G5.2). Node ids are the model's own — the same ones the URL hash carries in
 * `r`/`s` — so a stored workspace survives a re-index of the same project.
 */
export interface StoredDisk {
  rootId: string;
  /** The node it was spawned from; it may never be rooted above this. */
  floorId: string | null;
  x: number;
  y: number;
}

/**
 * One code bubble, as the workspace is written down and read back (phase B1).
 *
 * The node id is the model's own, so a stored bubble survives a re-index; one
 * that no longer resolves is dropped on restore exactly like a stored disk is.
 * The source itself is never stored — it is re-fetched, because the file on
 * disk is the truth and a cached copy of it would be a stale one.
 *
 * Restoring reads the fields below and ignores everything else it finds, so a
 * payload written by an older build — which described a presentation that no
 * longer exists — loads as the bubble it always was. Nothing is migrated,
 * because nothing needs to be: `w`/`h` are plain CSS px under B2.1's fixed
 * frame, which is what they always effectively were.
 */
export interface StoredBubble {
  nodeId: string;
  /** Workspace coordinates of the bubble's TOP-LEFT corner. */
  x: number;
  y: number;
  /** Frame size in CSS px — the user's own drag, clamped. Never zoomed. */
  w: number;
  h: number;
  /** The scrollport's offset, in the same plain CSS px the DOM reports. */
  scrollTop: number;
  /** Showing the whole file rather than the symbol's own span. */
  expanded: boolean;
  /**
   * Phase B2, both optional so a pre-B2 workspace restores unchanged: the NODE
   * whose call site opened this bubble, and the line it was called on. The
   * caller is re-found by node id on restore, since bubble ids are per-session.
   */
  originNodeId?: string;
  originLine?: number;
}

/**
 * The part of the workspace that is NOT in the URL: which disks are open and
 * where everything sits.
 *
 * The primary disk's root, selection and camera stay hash-owned — they are the
 * view you would send someone — so only its POSITION is here.
 */
export interface StoredWorkspace {
  primaryX: number;
  primaryY: number;
  disks: StoredDisk[];
  /**
   * Optional so a workspace stored before phase B1 still restores: an older
   * payload simply has no bubbles, which is exactly what it described.
   */
  bubbles?: StoredBubble[];
}

export interface CanvasCallbacks {
  onSelect(node: ModelNode | null): void;
  onViewChange(summary: ViewSummary): void;
  /**
   * The workspace's SHAPE changed — a disk was spawned, closed, moved or
   * re-rooted. Fired on the pointer's own cadence while a disk is dragged; the
   * shell is expected to debounce before it persists anything.
   */
  onWorkspaceChange?(workspace: StoredWorkspace): void;
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
 * Radial text is why files and symbols get the deeper wedge — see
 * `depthFactor` — the depth IS the label's room. That room is a CONSTANT per
 * kind as of round B4: a name too long for it is ellipsised here rather than
 * pushing its own wedge outward past its siblings'.)
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

/**
 * Slack, in SCREEN px, added to the viewport before anything is culled.
 *
 * Everything a wedge paints outside its own annulus lives inside it: focus and
 * hover outlines (≤2px), the changed/impacted rim, the change markers, and the
 * glyphs of a curved label. The margin is what makes the conservative cull
 * predicate cover them without any of them being modelled — see
 * {@link makeCull}.
 */
const CULL_MARGIN_PX = 24;

/**
 * How recently the camera must have moved for a frame to be served by the
 * INCREMENTAL BLIT rather than by a scene pass over the whole viewport
 * (performance round G5.3).
 *
 * Culling made a gesture frame cheap in *geometry*, but not in *pixels*: arc
 * fills and per-glyph curved labels rasterise at commit, so a culled frame
 * still hands the compositor megapixels of fresh ink. A camera-only gesture
 * changes nothing about the scene, only where it sits, so the frame is the last
 * one moved — one `drawImage` of a snapshot the size of the viewport, plus a
 * live scene pass over the sliver the move exposed.
 *
 * Deliberately SHORTER than {@link LABEL_SETTLE_MS}: the settle window keeps the
 * frame loop alive for 100ms after the gesture stops, so a window of 50ms
 * guarantees the loop reaches a frame that is a real (full) redraw — which is
 * what repaints exactly, re-plans the labels and refreshes the snapshot.
 */
const BLIT_GESTURE_MS = 50;

/**
 * How far a wheel gesture's accumulated zoom may drift from the snapshot it is
 * scaling before the blit is abandoned for the rest of that gesture.
 *
 * A zoom blit resamples, so it is soft until the settle window lands the real
 * redraw — the same trade the label plan already makes. Past this ratio the
 * softness stops being "slightly soft" and starts being a different picture, so
 * the frames go direct instead. There is no re-capture during a zoom (see
 * {@link CanvasController.captureSnapshot}), which is what makes "the rest of
 * the gesture" fall out of the ratio rather than needing a flag.
 */
const ZOOM_BLIT_MAX_RATIO = 3;

/**
 * Device px by which the zoom blit's exposed frame overlaps the scaled
 * snapshot.
 *
 * A pan blit lands on whole device pixels, so its exposed strips abut the blit
 * exactly and one device px is one device px. A zoom blit lands on fractional
 * ones, where an exactly-abutting clip can leave a hairline of stale pixels;
 * one px of deliberate overlap costs a sliver of double-drawn scene and cannot
 * leave a seam.
 */
const ZOOM_BLIT_BLEED_PX = 1;

/**
 * How far past the viewport the LABEL PLAN is built, in CSS px per side.
 *
 * Painting is culled to the pixels being painted; PLANNING is not. A gesture
 * strip replays the plan rather than rebuilding it (rebuilding from a strip
 * would throw away every label outside the strip), so a wedge the pan has just
 * pulled into view has no planned label until the camera settles. Planning one
 * screen-third past every edge at each full pass means a pan of up to that far
 * arrives label-complete; it costs one extra `measureText` pass over the wedges
 * in the margin, and nothing extra at paint time.
 */
const LABEL_PLAN_MARGIN_PX = 200;

/** Entries a colour cache holds before it is dropped wholesale and refilled. */
const COLOR_CACHE_MAX = 4000;

/**
 * Room left around a wedge that a ⌘P jump had to pan onto the screen.
 *
 * Big enough that the wedge lands *inside* the picture rather than flush
 * against an edge with its label cut off, small enough that the pan stays the
 * minimal one anybody would call minimal.
 */
const REVEAL_PAD_PX = 90;

/** ⌘P reveal pulse: three gentle breaths on the wedge the user landed on. */
const PULSE_MS = 1000;
const PULSE_CYCLES = 3;

/**
 * Change markers: green/red **sub-wedges** inside a changed file's own wedge
 * (round B4 — this replaces the two rounded bars on the outer rim).
 *
 * The bars were wrong twice over. They sat at the wedge's outer END, which is
 * where the ring below it starts, so they read as a hairline belonging to the
 * gap rather than to the file; and they were STROKED arcs, so their ends were
 * capped round, which on a disk made of hard-edged sectors reads as a different
 * kind of object entirely.
 *
 * A sub-wedge is the same shape as the thing it annotates: the wedge's own
 * angular span, its FULL radial depth (`r0 → r1`, so it is unmistakably part of
 * the wedge and not of the gap), filled — never stroked — so every corner is
 * square. Green takes the leading edge of the span, red follows it, and each
 * one's angular width is its share of the FILE's line count: a file whose half
 * was rewritten shows half its wedge coloured, a two-line typo fix a sliver.
 * The rest of the span keeps the wedge's kind colour, which is what makes the
 * proportion readable at all.
 *
 * Painted slightly translucent so the kind colour still shows through the
 * change rather than being replaced by it, and always on the SCENE path (it is
 * part of the picture, not chrome), so a blitted gesture frame carries it.
 */
const MARKER_ADDED = CHANGE_ADDED_COLOR;
const MARKER_REMOVED = CHANGE_REMOVED_COLOR;
/** Fill opacity of a sub-wedge, before the wedge's own dim/emphasis alpha. */
const MARKER_ALPHA = 0.82;
/**
 * Thinnest a sub-wedge is ever drawn, in radians — a quarter of the layout's
 * own {@link MIN_ARC_ANGLE} sliver, so a one-line change in a 4,000-line file
 * is still a visible tick and still visibly narrower than any real wedge.
 */
const MARKER_MIN_ANGLE = MIN_ARC_ANGLE / 4;

/**
 * Caps on ONE "expand all changes" click (B4.7).
 *
 * The button's promise is "every change at a glance", and a glance has a size:
 * a workspace of 200 bubbles is not a picture of a changeset, it is a wall.
 * So the expansion is bounded on both axes, and the bounds are chosen to keep
 * the RESULT usable rather than to keep the work small:
 *
 *  - {@link MAX_CHANGE_DISKS} disks, because the cover below is already trying
 *    to answer with as few as possible — hitting this bound means the changes
 *    are scattered across more of the tree than one screen can hold anyway;
 *  - {@link MAX_CHANGE_BUBBLES} bubbles, allocated **breadth first**: every
 *    changed file is offered its first bubble before any file is offered its
 *    second (the same rule the disk's own arc budget follows), so a single
 *    heavily-edited file cannot spend the whole budget and hide the other
 *    nineteen files you touched.
 *
 * Hitting either cap is silent — there is no toast surface in this UI, and the
 * alternative (an error) is worse than a workspace that shows the twenty-four
 * largest changes. The button's tooltip states the number up front.
 */
const MAX_CHANGE_DISKS = 8;
const MAX_CHANGE_BUBBLES = 24;
/** Ancestor levels of a hidden changed file offered to the disk cover. */
const CHANGE_COVER_LEVELS = 4;
/** Distinct roots the cover will lay out and score. */
const MAX_COVER_CANDIDATES = 48;

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
/** Radius of the direction dot at the tether's arrival end, in SCREEN px. */
const TETHER_DOT_PX = 3.2;
/** Screen-space tolerance of the tether's own hit test (the `×` affordance). */
const TETHER_HIT_PX = 6;
/** Ring around the focused disk's centre, drawn only once there are several. */
const FOCUS_RING = 'rgba(125, 211, 252, 0.55)';

/**
 * Phase B2 — the call thread between two bubbles.
 *
 * Unlike the workspace tether above, this one IS a relation in the code, so it
 * borrows the vocabulary relations already have: the OUTGOING amber of the
 * direction palette (it leaves the caller), dashed when the hop was synthesized
 * rather than parsed. What it adds is where it leaves FROM — the call-site line
 * itself, not the box — which is the whole point of the phase.
 */
const CALL_TETHER_COLOR = 'rgba(245, 165, 36, 0.66)';
/**
 * Relations that draw a thread between bubbles.
 *
 * `calls` is the phase's subject. `references` earns its place because that is
 * the kind the framework resolvers emit for a route reaching its handler — the
 * flow a developer traces most often and the one that has no `calls` edge to
 * ride. Everything else (imports, extends, instantiates…) is structure rather
 * than flow, and belongs to the disks that already draw it.
 */
const CALL_TETHER_KINDS = new Set(['calls', 'references']);
/** A bubble that was raised instead of re-opened flashes its thread, briefly. */
const CALL_TETHER_COLOR_HOT = 'rgba(250, 204, 21, 0.95)';
/**
 * The same thread when the callee is only a WEDGE: deliberately subordinate —
 * thinner and much fainter — so a workspace of bubbles reads as one system
 * without the disk threads competing with the bubble-to-bubble ones.
 */
const CALL_DISK_TETHER_COLOR = 'rgba(245, 165, 36, 0.26)';
const CALL_TETHER_WIDTH_PX = 1.4;
const CALL_DISK_TETHER_WIDTH_PX = 0.9;
const CALL_TETHER_DOT_PX = 2.8;
/** Bezier arm as a share of the gap, the shape the bubble tether already uses. */
const CALL_TETHER_ARM_SHARE = 0.45;
const CALL_TETHER_MIN_ARM = 10;
/** How long a re-raised bubble's thread stays hot. */
const CALL_FLASH_MS = 900;
/**
 * Cap on bubble→WEDGE threads per frame, nearest first.
 *
 * A file bubble can carry hundreds of outgoing calls, and drawing every one of
 * them to a wedge would wallpaper the canvas with exactly the noise the disks
 * avoid by hiding edges at rest. Two bounds: at most this many are DRAWN, and
 * at most {@link CALL_DISK_TETHER_SCAN} are examined to find them, so the
 * per-frame cost has a ceiling that does not depend on the file's size.
 */
const CALL_DISK_TETHER_MAX = 24;
const CALL_DISK_TETHER_SCAN = 400;
/** Where a callee bubble lands: this far right of the caller's box, in SCREEN px. */
const CALL_OPEN_GAP_PX = 28;

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
 * A rectangle of the canvas, in CSS px, that a scene pass is being run for.
 *
 * A full frame's is the whole viewport; a gesture frame runs one per exposed
 * strip. Everything below {@link CanvasController.cullFor} is written against
 * this rather than against `(this.width, this.height)`, which is what lets a
 * strip use the same painting code as a full frame.
 */
export interface ViewRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** A device-px rectangle of the backing store. */
export interface BlitRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * The camera a snapshot of the last full frame was painted under.
 *
 * A camera is exactly (origin, scale) — every disk, arc, rope and tether is
 * placed through those two — so re-projecting a finished frame onto a new
 * camera is one `drawImage`: `new = newOrigin + (old − oldOrigin) × ratio`,
 * which composes a pan and a cursor-anchored zoom alike. The device pixel ratio
 * and the CSS size ride along because a change to either means the snapshot's
 * pixels no longer describe this canvas at all.
 *
 * The snapshot is always exactly the size of the VISIBLE canvas. Round G5.1
 * painted a 2w × 2h one so a pan could read margin pixels instead of exposing
 * background, and on a large display at ratio 2 that put the backing store past
 * the GPU's maximum texture dimension: the "one drawImage" fell off the
 * accelerated path and took 84ms. Never again — the exposed region is filled
 * live instead, which costs a thin strip of scene and no memory at all.
 */
export interface SnapshotCamera {
  /** Camera origin, in CSS px, that the snapshot's pixels actually show. */
  originX: number;
  originY: number;
  scale: number;
  ratio: number;
  /** CSS size of the canvas the snapshot mirrors. */
  width: number;
  height: number;
}

/** How a gesture frame reuses the snapshot: where it lands, what it misses. */
export interface GestureBlit {
  /** `'pan'` is a whole-device-px translation; `'zoom'` resamples. */
  kind: 'pan' | 'zoom';
  /** Device-px rect the whole snapshot is stamped into. */
  dest: BlitRect;
  /**
   * The viewport minus `dest`, in device px — disjoint rects which together
   * with the on-screen part of `dest` tile the viewport exactly.
   */
  exposed: BlitRect[];
  /**
   * Camera origin, in CSS px, that the exposed region must be painted under —
   * for a pan the ROUNDED one the blitted pixels show, so the strips agree with
   * them; for a zoom the true one, which `dest` was derived from exactly.
   */
  originX: number;
  originY: number;
}

/**
 * The viewport, expressed in the LOCAL units of whatever is being painted, plus
 * the two conservative windows an annulus sector is tested against.
 *
 * See {@link makeCull} for the geometry and {@link arcVisible} for the
 * correctness rule (a reject must be provable; drawing something offscreen is
 * merely wasteful).
 */
export interface ViewCull {
  /** The padded screen rect in local units. */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** Distance interval from the local origin to the rect. */
  dMin: number;
  dMax: number;
  /** True when the rect contains the origin — then every angle is on screen. */
  full: boolean;
  /** Angular window the rect subtends at the origin (only when `!full`). */
  a0: number;
  a1: number;
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

/** Angular width, in radians, of one changed wedge's two sub-wedges. */
export interface ChangeSubWedgeSpans {
  added: number;
  removed: number;
}

/**
 * How wide a changed wedge's green and red sub-wedges are (round B4).
 *
 * Pure arithmetic over three numbers, so it is probeable and byte-deterministic
 * — the painter does nothing to these values except draw them.
 *
 * The rules, in the order they apply:
 *
 *  1. **Proportional.** A share is "lines added (or removed) ÷ the file's own
 *     line count", so a half-rewritten file colours half its span and a file
 *     rewritten twice over colours all of it (the share is clamped at 1).
 *  2. **Minimum visible span.** A change that is real but tiny still gets
 *     {@link MARKER_MIN_ANGLE} rather than a sub-pixel nothing — "there is an
 *     edit here" is the more useful fact than "the edit is 0.3% of the file".
 *     The floor is itself capped at half the wedge, so the two floors together
 *     can never exceed the span they sit in. A share of exactly 0 gets nothing
 *     at all: no change is not a small change.
 *  3. **Capped by the wedge.** If the two together still want more than the
 *     whole span (a file whose added AND removed both approach its length),
 *     both are scaled by the same factor, so the ratio between them survives
 *     and green + red exactly fills the wedge and never overruns its neighbour.
 */
export function changeSubWedgeSpans(
  span: number,
  addedShare: number,
  removedShare: number
): ChangeSubWedgeSpans {
  if (!(span > 0)) return { added: 0, removed: 0 };
  const floor = Math.min(MARKER_MIN_ANGLE, span / 2);
  const want = (share: number): number =>
    share > 0 ? Math.max(floor, span * Math.min(1, share)) : 0;
  let added = want(addedShare);
  let removed = want(removedShare);
  const total = added + removed;
  if (total > span) {
    const factor = span / total;
    added *= factor;
    removed *= factor;
  }
  return { added, removed };
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
  /**
   * The highest node this disk may ever be rooted at — the node it was spawned
   * from, fixed for its whole life. `null` on the primary disk, which the
   * project root already stops.
   *
   * A spawned disk means "show me THIS subtree, over here". Letting it walk
   * above its own origin breaks that claim in two ways at once: two disks end
   * up pointing at the same root, or a secondary quietly drifts up to the
   * project root and becomes a second copy of the primary — and the tether
   * still says it came out of a wedge that is now above it. So the floor is a
   * property of the DISK, not of its current root: drilling in and re-rooting
   * back out inside the subtree are both free, going above it is simply not a
   * move this disk has.
   */
  floorId: string | null;

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

/**
 * One code bubble on the canvas (phase B1).
 *
 * A bubble is a scrollable slice of SOURCE pinned to the workspace: DOM in an
 * overlay above the canvas, never painted into it. The controller owns its
 * geometry and its lifecycle; {@link BubbleView} owns its elements. The only
 * per-frame work is one CSS transform each.
 */
interface BubbleState {
  id: string;
  /** The node whose source this shows — also the wedge its tether points at. */
  nodeId: string;
  /** Workspace coordinates of the top-left corner — the only thing the camera moves. */
  x: number;
  y: number;
  /** Frame size in CSS px, fixed in SCREEN space: the camera never scales it (B2.1). */
  w: number;
  h: number;
  /** Whole file instead of the symbol's own span. */
  expanded: boolean;
  scrollTop: number;
  /** Stacking order among bubbles — a press raises one to the top. */
  z: number;
  /** Disk the drag-away started in; the tether prefers it. */
  sourceDiskId: string | null;
  view: BubbleView;
  /** Rising per fetch, so a slow response cannot overwrite a newer one. */
  requestSeq: number;
  /** Line to scroll to once the pending fetch lands (`null` = keep `scrollTop`). */
  pendingLine: number | null;
  /**
   * The scale the body is CURRENTLY laid out at (B2.3).
   *
   * The applied value, not the camera's — and deliberately behind it during a
   * gesture, since a re-layout is real work and the transform is already
   * drawing the right picture. It catches up on the settled frame, which is
   * where it is the `fromScale` the centre-line rule re-anchors against. It
   * also stops following the camera while the bubble is showing its label,
   * since laying out type nobody can read would be a layout for nothing.
   */
  fontScale: number;

  // ---- phase B2: call tracing. All of this is rebuilt on a content load, and
  // never on a frame — a frame does anchor arithmetic and drawing, nothing else.
  /** Where this bubble came from. A wedge (B1) or another bubble's call site. */
  origin: BubbleOrigin;
  /** Outgoing relations of everything this bubble displays, cached. */
  calls: BubbleCall[];
  /** Displayed line → callee node ids, the gutter's marker plan. */
  callLines: Map<number, string[]>;
  /** Measured body geometry, or the fallback until there is a body to measure. */
  metrics: BubbleBodyMetrics;
  /**
   * The zoomed-out face's own size in SCREEN px, measured when the header was
   * last written (B3.1), or `null` if it has never had one.
   *
   * Scale-free, so it is measured once rather than per frame: the label
   * counter-scales against the root's transform, which is what makes the block
   * the same size on screen at every zoom — and what makes it, rather than the
   * shrinking frame, the thing a tether has to land on down there.
   */
  labelSize: BubbleLabelGeometry | null;
  /** Has {@link BubbleView.bodyGeometry} answered for the CURRENT content yet? */
  measured: boolean;
  /** Real file line of the first displayed row, and how many rows there are. */
  firstLine: number;
  lineCount: number;
  /** `performance.now()` this bubble's threads stop flashing at (0 = not). */
  flashUntil: number;
}

/**
 * Where a bubble's thread goes back to (phase B2 extends B1's single case).
 *
 * B1 knew one origin: the WEDGE the bubble was dragged out of. A bubble opened
 * from a gutter call marker has a different one — the caller's own call site —
 * and pointing it at a wedge instead would claim the disk sent it, which is not
 * what happened. The caller is held by NODE id rather than by bubble id so the
 * link survives being written down and read back, where bubble ids do not.
 */
export type BubbleOrigin =
  | { kind: 'wedge' }
  | { kind: 'bubble'; callerNodeId: string; line: number | null };

/**
 * One outgoing relation of a bubble, cached at content-load time.
 *
 * `line` is the call site in the CALLER's file, 1-indexed, and is absent on
 * edges whose resolver did not record one — which the anchor maths treats as
 * "this bubble calls it" rather than "this line does".
 */
interface BubbleCall {
  targetId: string;
  line: number | null;
  kind: string;
  heuristic: boolean;
  synthesizedBy?: string;
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
  /** Is ⌥ down right now? It FLIPS what the release will create, live. */
  alt: boolean;
  /**
   * What the release would spawn, recomputed whenever ⌥ or the node changes.
   *
   * The default is the node's own shape — a LEAF has no subtree to draw, so a
   * disk of it is an empty centre circle and a bubble of it is its source;
   * anything with children is a disk. ⌥ flips it in both directions, and the
   * ghost follows so the gesture never lies about its outcome.
   */
  spawn: 'disk' | 'bubble';
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
  /**
   * How many folded children each `+N` arc still stands for under the current
   * legend filters — memoised per arc, dropped whenever the filters, the colour
   * mode or the layouts change ({@link invalidateAggregates}).
   */
  private aggregateCounts = new Map<SunburstArc, number>();

  /** File node id → what changed in it, sizing its change sub-wedges. */
  private changeMarkers = new Map<string, ChangeMarker>();

  /**
   * The bubbles' half of the changes toggle (B4.6): a file path → its hunks
   * against `HEAD`, or `null` for a file whose diff could not be read.
   *
   * Cached PER FILE rather than per bubble, and fetched unfiltered, because
   * several bubbles routinely show different spans of one edited file (the
   * "expand all changes" button spawns a bubble per changed symbol) — one
   * `git diff` then serves all of them and the span filtering is pure
   * arithmetic ({@link spanChangeMarks}).
   *
   * `null` is the graceful end of every failure: a file outside git, a request
   * that 404s, a diff that cannot be parsed. Nothing is drawn and nothing is
   * said — a bubble that cannot show its changes is still a bubble showing its
   * code, which is what the user asked for.
   */
  private readonly changeDiffs = new Map<string, DiffHunk[] | null>();
  /** Files whose diff is in flight, so N bubbles make one request. */
  private readonly changeDiffPending = new Set<string>();
  /**
   * Rises whenever the change payload itself moves (a re-index, the toggle).
   *
   * It is the cache's generation: a response that was already in flight when
   * the epoch turned is dropped rather than stored, so a stale diff can never
   * land on a bubble showing freshly re-indexed lines.
   */
  private changeEpoch = 0;

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
  /** `(colour mode, arc key)` → the arc's base fill, before any alpha. */
  private readonly arcFills = new Map<string, string>();
  /** When the camera last moved — the label pass waits for this to go stale. */
  private cameraMovedAt = -Infinity;

  /**
   * Anything but the camera changed since the last full redraw (round G5.3).
   *
   * Set by {@link requestDraw}, which is what EVERY mutation path already calls
   * — so a new one is dirty by default and the snapshot can only ever be blitted
   * for a frame that is genuinely a camera transform of the last one. The two
   * camera-only paths (a pan drag, the wheel) opt out through
   * {@link requestCameraDraw}. A path that forgets is merely slower, never
   * wrong, which is the right way round for a cache like this.
   */
  private sceneDirty = true;
  /** When a camera-ONLY gesture last moved the camera. */
  private cameraGestureAt = -Infinity;
  /** Which camera-only gesture that was — a zoom never re-captures. */
  private cameraGestureKind: 'pan' | 'zoom' | null = null;
  /** The last exactly-painted scene, at the backing-store resolution. */
  private snapshotCanvas: HTMLCanvasElement | null = null;
  /** The camera those pixels show — `null` when they describe nothing. */
  private snapshotCamera: SnapshotCamera | null = null;

  /**
   * A pointer position whose hit test was deferred because the camera was in
   * motion. Applied on the first settled frame, so a wheel zoom neither pays
   * for a hit test per frame nor leaves the hover pointing at the wedge that
   * used to be under the cursor.
   */
  private pendingHover: Point | null = null;

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

  /**
   * The bubble overlay (phase B1) — a DOM layer over the canvas.
   *
   * It is `pointer-events: none` and each bubble re-enables them, so the canvas
   * keeps every gesture that does not land on a bubble. Nothing in here is ever
   * painted into the canvas, so bubbles are invisible to the incremental blit:
   * they cannot dirty the scene by existing, and they cannot be baked into a
   * snapshot.
   */
  private readonly bubbleLayer: HTMLDivElement;
  private bubbles: BubbleState[] = [];
  private bubbleSeq = 0;
  private bubbleZ = 1;

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

    // Above the canvas, below the shell's panels (which are later siblings of
    // this whole container in the document).
    this.bubbleLayer = document.createElement('div');
    Object.assign(this.bubbleLayer.style, {
      position: 'absolute',
      inset: '0',
      overflow: 'hidden',
      pointerEvents: 'none',
    });
    container.appendChild(this.bubbleLayer);

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
    this.aggregateCounts.clear();
    // Fills are derived from (node, colour mode, the model's layer vocabulary),
    // so a new model is the one thing that can change one without the key.
    this.arcFills.clear();

    if (!previous || !sameProject) {
      this.clearBubbles();
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
      const before = this.disks.length;
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
      const bubblesBefore = this.bubbles.length;
      this.refreshBubbles();
      // A re-index that removed a disk's root removed the disk with it — the
      // stored workspace has to lose it too, and the same goes for a bubble.
      if (this.disks.length !== before || this.bubbles.length !== bubblesBefore) {
        this.notifyWorkspace();
      }
    }
    this.rebuildAllLayouts();
  }

  setColorMode(mode: ColorMode): void {
    if (this.colorMode === mode) return;
    this.colorMode = mode;
    // The legend's categories are named per MODE (kinds vs layers), so which
    // wedges — and which folded children — a filter hides changes with it.
    this.invalidateAggregates();
    this.edgesDirty = true;
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
    this.aggregateCounts.clear();
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
   *
   * Everything derived from "what is on screen" follows the filter: a `+N` fold
   * arc recounts (and vanishes when nothing it folded is left), and a relation
   * with a hidden endpoint is not drawn at all — an invisible wedge must not be
   * reachable as the far end of a rope either.
   */
  setHiddenColorKeys(keys: Iterable<string>): void {
    const next = new Set(keys);
    if (next.size === this.hiddenColorKeys.size && [...next].every((k) => this.hiddenColorKeys.has(k))) {
      return;
    }
    this.hiddenColorKeys = next;
    this.invalidateAggregates();
    this.edgesDirty = true;
    this.requestDraw();
  }

  /**
   * Show (or hide) uncommitted work — the "changes" toggle's one entry point.
   *
   * Round B4 folded the three parts of it into one call. They used to arrive
   * separately, and from two different places: the markers through a setter of
   * their own, the changed/impacted rims as two fields of the CARD highlight,
   * which meant activating any question card silently wiped the change rims
   * because a card's highlight replaces the whole highlight. Changes are not a
   * card and never were — they are a standing annotation, on whatever you are
   * looking at, so they get a lifetime of their own and one switch.
   *
   * `null` draws none of it. Ids the model doesn't know are dropped silently
   * (a payload can name a file the index has not caught up with yet).
   */
  setChangeOverlay(overlay: ChangeOverlay | null): void {
    const model = this.model;
    const known = (ids: Iterable<string>): Set<string> => {
      const out = new Set<string>();
      for (const id of ids) if (!model || model.nodes.has(id)) out.add(id);
      return out;
    };
    this.changeMarkers = new Map(overlay?.markers ?? []);
    this.changedNodes = known(overlay?.changed ?? []);
    this.impactedNodes = known(overlay?.impacted ?? []);
    // The bubbles are governed by this one switch too (B4.6), so the payload
    // that sizes the sub-wedges is also what re-decorates their gutters — a
    // new epoch drops the diff cache, and every open bubble re-asks.
    this.changeEpoch += 1;
    this.changeDiffs.clear();
    this.changeDiffPending.clear();
    for (const bubble of this.bubbles) this.applyBubbleChanges(bubble);
    this.projectHighlight();
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

  /** The workspace as it stands, for the shell to write down. */
  workspaceLayout(): StoredWorkspace {
    const primary = this.primary();
    return {
      primaryX: primary.x,
      primaryY: primary.y,
      disks: this.disks
        .filter((disk) => !disk.primary)
        .map((disk) => ({
          rootId: disk.rootId,
          floorId: disk.floorId,
          x: disk.x,
          y: disk.y,
        })),
      // `scrollTop` is the cached value the scroll handler keeps, never a live
      // DOM read: this runs on the pointer's cadence while a disk is dragged.
      bubbles: this.bubbles.map((bubble) => {
        const stored: StoredBubble = {
          nodeId: bubble.nodeId,
          x: bubble.x,
          y: bubble.y,
          w: bubble.w,
          h: bubble.h,
          scrollTop: bubble.scrollTop,
          expanded: bubble.expanded,
        };
        // Phase B2: a bubble opened from a call marker remembers WHICH call
        // opened it, by node id — bubble ids are per-session, node ids are not.
        if (bubble.origin.kind === 'bubble') {
          stored.originNodeId = bubble.origin.callerNodeId;
          if (bubble.origin.line !== null) stored.originLine = bubble.origin.line;
        }
        return stored;
      }),
    };
  }

  /**
   * Put a stored workspace back — the page-refresh half of {@link workspaceLayout}.
   *
   * Deliberately quiet: no transitions, no camera move, no selection, and the
   * primary disk's ROOT is not touched at all (the hash owns it, and the hash
   * wins). A stored disk whose root no longer exists is dropped silently — a
   * re-index between two visits can remove nodes, and losing one disk is a much
   * better outcome than a disk rooted at nothing. Whatever survives is
   * published back through `onWorkspaceChange`, so the store is rewritten
   * without the disks that went away.
   */
  restoreWorkspace(workspace: StoredWorkspace): void {
    const model = this.model;
    if (!model) return;
    const primary = this.primary();
    if (Number.isFinite(workspace.primaryX)) primary.x = workspace.primaryX;
    if (Number.isFinite(workspace.primaryY)) primary.y = workspace.primaryY;

    for (const stored of workspace.disks) {
      if (!model.nodes.has(stored.rootId)) continue;
      if (!Number.isFinite(stored.x) || !Number.isFinite(stored.y)) continue;
      const floorId =
        stored.floorId && model.nodes.has(stored.floorId) ? stored.floorId : stored.rootId;
      this.diskSeq += 1;
      this.disks.push(
        makeDisk(
          `disk:${this.diskSeq}`,
          stored.rootId,
          stored.x,
          stored.y,
          false,
          // The tether hangs off the node the disk came out of, which is its
          // floor; the disk it was dragged FROM is not worth storing, since
          // `tetherOf` already falls back to whichever disk still shows it.
          floorId,
          PRIMARY_DISK_ID,
          floorId
        )
      );
    }
    // Bubbles come back the same way: a stale node id is dropped in silence,
    // and whatever survives re-fetches its source (the file is the truth; a
    // stored copy of it would be a stale one).
    for (const stored of workspace.bubbles ?? []) {
      if (!stored || !model.nodes.has(stored.nodeId)) continue;
      if (!Number.isFinite(stored.x) || !Number.isFinite(stored.y)) continue;
      // A stored caller that no longer resolves demotes the bubble to an
      // ordinary one (origin `wedge`) rather than dropping it: the code it
      // shows is still worth showing, it just has nothing to hang a thread on.
      const origin: BubbleOrigin =
        stored.originNodeId && model.nodes.has(stored.originNodeId)
          ? {
              kind: 'bubble',
              callerNodeId: stored.originNodeId,
              line: Number.isFinite(stored.originLine) ? stored.originLine! : null,
            }
          : { kind: 'wedge' };
      this.createBubble({
        nodeId: stored.nodeId,
        x: stored.x,
        y: stored.y,
        w: stored.w,
        h: stored.h,
        scrollTop: Number.isFinite(stored.scrollTop) ? stored.scrollTop : 0,
        expanded: Boolean(stored.expanded),
        sourceDiskId: null,
        origin,
      });
    }

    this.rebuildExpandedNodes();
    this.rebuildAllLayouts();
    this.notifyWorkspace();
  }

  /** Tell the shell the workspace moved, so it can write it down. */
  private notifyWorkspace(): void {
    this.callbacks.onWorkspaceChange?.(this.workspaceLayout());
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
    // The root it is born with IS its floor, for the rest of its life.
    const disk = makeDisk(
      `disk:${this.diskSeq}`,
      placement.rootId,
      placed.x,
      placed.y,
      false,
      nodeId,
      sourceDiskId,
      placement.rootId
    );
    this.disks.push(disk);
    this.rebuildExpandedNodes();
    this.focusedDiskId = disk.id;
    this.rebuildAllLayouts();
    this.notifyWorkspace();
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
    this.notifyWorkspace();
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

  // ------------------------------------------------------- code bubbles ---

  /**
   * Can this node be shown as a bubble at all?
   *
   * A directory has no source, and neither has a node the model knows only by
   * name. Everything else does — a file bubble is the whole file, a symbol
   * bubble its own span.
   */
  /**
   * How many lines a node's bubble will show — its own span, which is what a
   * spawn knows before any source has been fetched.
   *
   * The number the header prints ends up being the FETCHED span's length, and
   * for an ordinary node the two are the same; where they differ (a stale
   * index, a truncated read) the box is a few rows out, which is a box, not a
   * bug. `0` for a node the model does not have, which reads as the minimum.
   */
  private bubbleLoc(nodeId: string | null): number {
    const node = nodeId ? this.model?.get(nodeId) : null;
    if (!node) return 0;
    return Math.max(1, node.endLine - node.startLine + 1);
  }

  private bubbleable(nodeId: string): boolean {
    const node = this.model?.get(nodeId);
    return Boolean(node && node.kind !== DIRECTORY_KIND && node.file);
  }

  /**
   * What a drag-away of this node would spawn, given ⌥.
   *
   * The default is the node's own shape: a **leaf** has no subtree, so a disk
   * of it is a lone centre circle while a bubble of it is the thing the user
   * was actually reaching for — its code. Anything with children keeps phase
   * G's disk. ⌥ flips it in both directions, because the default is a good
   * guess and a good guess needs an override, not an argument.
   *
   * **A FILE is a bubble by default too (round B4)**, even though it has
   * children. Structurally it is a branch — it contains its symbols — but that
   * is not what dragging one out means to a reader: "show me this file" is
   * "show me its code", and a disk of a file is a ring of its symbols with the
   * code nowhere on screen. The file bubble is the WHOLE file (a file node's
   * span is the file's own line range, and the header offers no "expand to
   * file" because there is nothing further to expand to), sized by the same
   * LoC clamp every other bubble uses. ⌥-drag still gives the disk, which is
   * where the ring of symbols lives.
   */
  private spawnKindFor(nodeId: string, alt: boolean): 'disk' | 'bubble' {
    const model = this.model;
    if (!model) return 'disk';
    const leaf = model.childrenOf(nodeId).length === 0;
    const prefersBubble = leaf || model.get(nodeId)?.kind === 'file';
    const wantsBubble = prefersBubble !== alt;
    return wantsBubble && this.bubbleable(nodeId) ? 'bubble' : 'disk';
  }

  /**
   * Spawn a bubble — the drop half of a leaf drag-away.
   *
   * `at` is the pointer's workspace position; the box is centred on it, which
   * is where the ghost was, so the bubble lands exactly where it was promised.
   */
  private spawnBubble(nodeId: string, at: Point, sourceDiskId: string | null): void {
    if (!this.bubbleable(nodeId)) return;
    // The size is the DEFAULT in frame px, whatever the zoom — a bubble spawned
    // while zoomed out or in is the same box as its neighbours, drawn at the
    // same scale as them, not a giant or a speck. Centring it on the drop point
    // crosses two factors — frame px → screen px (the frame scale, which is
    // what the ghost was drawn at) and screen px → world units (the camera's)
    // — and since B2.3 those two ARE the same number: a bubble's footprint in
    // the world is exactly its frame px, at every zoom, which is what being a
    // world object means.
    //
    // B3: that default is now the node's OWN size — three lines of code get a
    // three-line box — from the same pure helper the ghost was drawn from, so
    // the release lands exactly the rectangle the drag promised.
    const scale = this.scale();
    const frameScale = bubbleFrameScale(scale);
    const size = bubbleDefaultSize(this.bubbleLoc(nodeId));
    const halfW = (size.w * frameScale) / 2 / scale;
    const halfH = (size.h * frameScale) / 2 / scale;
    this.createBubble({
      nodeId,
      x: at.x - halfW,
      y: at.y - halfH,
      w: size.w,
      h: size.h,
      scrollTop: 0,
      expanded: false,
      sourceDiskId,
      origin: { kind: 'wedge' },
    });
    this.notifyWorkspace();
  }

  /** Build one bubble's state and DOM, and start its fetch. Shared with restore. */
  private createBubble(init: {
    nodeId: string;
    x: number;
    y: number;
    w: number;
    h: number;
    scrollTop: number;
    expanded: boolean;
    sourceDiskId: string | null;
    origin: BubbleOrigin;
  }): BubbleState | null {
    const model = this.model;
    const node = model?.get(init.nodeId);
    if (!model || !node) return null;
    const size = clampBubbleSize(init.w, init.h);
    this.bubbleSeq += 1;
    this.bubbleZ += 1;
    const id = `bubble:${this.bubbleSeq}`;

    const view = new BubbleView(this.bubbleLayer, {
      onClose: () => this.closeBubble(id),
      onRaise: () => this.raiseBubble(id),
      onMove: (dx, dy) => this.moveBubble(id, dx, dy),
      onResize: (dx, dy) => this.resizeBubble(id, dx, dy),
      onScroll: (scrollTop, programmatic) => this.bubbleScrolled(id, scrollTop, programmatic),
      onToggleExpand: () => this.toggleBubbleExpand(id),
      onOpenInEditor: () => this.openBubbleInEditor(id),
      onOpenCallee: (line, calleeId) => this.openCallee(id, line, calleeId),
    });

    const bubble: BubbleState = {
      id,
      nodeId: init.nodeId,
      x: init.x,
      y: init.y,
      w: size.w,
      h: size.h,
      expanded: init.expanded,
      scrollTop: Math.max(0, init.scrollTop),
      z: this.bubbleZ,
      sourceDiskId: init.sourceDiskId,
      view,
      requestSeq: 0,
      pendingLine: null,
      fontScale: bubbleFontScale(this.scale()),
      origin: init.origin,
      calls: [],
      callLines: new Map(),
      metrics: BUBBLE_METRICS_FALLBACK,
      labelSize: null,
      measured: false,
      firstLine: node.startLine,
      lineCount: 0,
      flashUntil: 0,
    };
    this.bubbles.push(bubble);
    // The layout scale first: it is what the size below is expressed through.
    // A bubble spawned at camera 3 is laid out crisp from its first frame —
    // there is nothing to preserve yet, so none of the settle machinery
    // applies.
    view.setFontScale(bubble.fontScale);
    view.setSize(size.w, size.h);
    view.setZ(bubble.z);
    this.refreshBubbleHeader(bubble);
    this.loadBubbleSource(bubble);
    this.syncBubbles();
    // The tether is canvas chrome, so a new bubble needs a frame — and a frame
    // through the DIRTY path, never the camera one.
    this.requestDraw();
    return bubble;
  }

  private bubbleById(id: string): BubbleState | null {
    return this.bubbles.find((bubble) => bubble.id === id) ?? null;
  }

  /**
   * Re-print the header — and, with it, the centred label the frame shows when
   * the camera is too far out to read type (B2.1: they carry the same facts,
   * from the same place, so the two faces of a bubble can never disagree).
   *
   * `loc` is the line count of what is ACTUALLY in the box — the symbol's span
   * until an "expand to file" lands, the file's own length after it — so the
   * number never disagrees with the line numbers beside the code.
   */
  private refreshBubbleHeader(bubble: BubbleState, loc?: number): void {
    const node = this.model?.get(bubble.nodeId);
    if (!node) return;
    bubble.view.setHeader({
      name: node.name,
      kind: node.kind,
      loc: loc ?? Math.max(1, node.endLine - node.startLine + 1),
      canExpand: node.kind !== 'file',
      expanded: bubble.expanded,
    });
    // The one place the label's text changes is the line above, so it is the
    // one place its painted size can change (B3.1). Read here, cached in the
    // state, and never read again: the tether that ends on this block is drawn
    // every frame, and a frame does arithmetic over measured numbers or it
    // does nothing.
    bubble.labelSize = bubble.view.labelGeometry();
  }

  /**
   * Fetch a bubble's source.
   *
   * A failure prints inside the bubble and nowhere else: the canvas is not
   * involved, the other bubbles are not involved, and the user can close the
   * one box that could not read its file. `requestSeq` is the race guard — a
   * slow "expand to file" must never land on top of a newer collapse.
   */
  private loadBubbleSource(bubble: BubbleState): void {
    const node = this.model?.get(bubble.nodeId);
    if (!node) return;
    const seq = ++bubble.requestSeq;
    bubble.view.setContent({ status: 'loading' });
    const request = bubble.expanded
      ? fetchSource(node.file)
      : fetchSource(node.file, node.startLine, node.endLine);
    void request
      .then((span) => {
        if (seq !== bubble.requestSeq || !this.bubbles.includes(bubble)) return;
        bubble.view.setContent({
          status: 'ready',
          file: span.file,
          startLine: span.startLine,
          text: span.content,
          truncated: span.truncated,
        });
        this.refreshBubbleHeader(bubble, Math.max(1, span.endLine - span.startLine + 1));
        // The call cache is rebuilt HERE and only here: what a bubble displays
        // is what decides which edges are its own, and that changes exactly
        // when the text does (a load, an expand, a re-index).
        this.rebuildBubbleCalls(bubble, span.startLine, span.endLine, span.file);
        // …and so is the change decoration, for the same reason: the rows it
        // rides were just rebuilt, and the span they cover is only known now.
        this.applyBubbleChanges(bubble);
        if (bubble.pendingLine !== null) {
          bubble.view.scrollToLine(bubble.pendingLine);
          bubble.pendingLine = null;
        } else if (bubble.scrollTop > 0) {
          bubble.view.setScrollTop(bubble.scrollTop);
        }
        // The tethers are chrome and their anchors just changed under them.
        this.requestDraw();
      })
      .catch((error: unknown) => {
        if (seq !== bubble.requestSeq || !this.bubbles.includes(bubble)) return;
        bubble.view.setContent({
          status: 'error',
          message: error instanceof Error ? error.message : String(error),
        });
      });
  }

  private closeBubble(id: string): void {
    const bubble = this.bubbleById(id);
    if (!bubble) return;
    bubble.requestSeq++;
    bubble.view.destroy();
    this.bubbles = this.bubbles.filter((entry) => entry.id !== id);
    this.requestDraw();
    this.notifyWorkspace();
  }

  /** A press anywhere in a bubble puts it on top of its siblings. */
  private raiseBubble(id: string): void {
    const bubble = this.bubbleById(id);
    if (!bubble || bubble.z === this.bubbleZ) return;
    this.bubbleZ += 1;
    bubble.z = this.bubbleZ;
    bubble.view.setZ(bubble.z);
  }

  /** Header drag: screen px in, WORLD units out — the anchor is a world point. */
  private moveBubble(id: string, dx: number, dy: number): void {
    const bubble = this.bubbleById(id);
    if (!bubble) return;
    const scale = this.scale();
    bubble.x += dx / scale;
    bubble.y += dy / scale;
    this.syncBubbles();
    this.requestDraw();
    this.notifyWorkspace();
  }

  /**
   * Corner drag: screen px in, frame px out, across the frame's own scale.
   *
   * The frame is stored in frame px and drawn at the camera's scale (B2.3), so
   * the grip divides by that one number, in both directions now — drag 40
   * screen px at scale 0.5 and the frame grows 80 frame px; drag the same 40
   * at scale 2 and it grows 20. Either way that is 40 px on screen, so the box
   * follows the cursor 1:1 at every zoom, which is the only behaviour a grip
   * can have; what changes with the zoom is how much box that buys.
   */
  private resizeBubble(id: string, dx: number, dy: number): void {
    const bubble = this.bubbleById(id);
    if (!bubble) return;
    const frameScale = Math.max(1e-6, bubbleFrameScale(this.scale()));
    const size = clampBubbleSize(bubble.w + dx / frameScale, bubble.h + dy / frameScale);
    if (size.w === bubble.w && size.h === bubble.h) return;
    bubble.w = size.w;
    bubble.h = size.h;
    bubble.view.setSize(size.w, size.h);
    // A narrower box wraps more lines and a wider one fewer (B3), so the row
    // offsets the threads are drawn from are only true for the width they were
    // measured at. The browser has to reflow for the resize anyway; this reads
    // the result of that reflow back rather than forcing a second one.
    this.measureBubbleBody(bubble);
    this.requestDraw();
    this.notifyWorkspace();
  }

  private bubbleScrolled(id: string, scrollTop: number, programmatic: boolean): void {
    const bubble = this.bubbleById(id);
    if (!bubble || bubble.scrollTop === scrollTop) return;
    // The DOM's answer wins either way: it has clamped the offset to a content
    // height only it knows exactly, and state that disagreed with it would
    // walk the threads off the line they claim.
    bubble.scrollTop = scrollTop;
    this.notifyWorkspace();
    // Phase B2: a call thread leaves the call-site LINE, so scrolling the body
    // moves every thread that leaves this bubble. It goes through the ordinary
    // dirty path — a scroll is not a camera gesture, so it must never reuse the
    // snapshot — and the chrome pass re-derives the anchors from the new offset.
    //
    // B2.1: unless this is the echo of the re-anchoring the zoom itself just
    // did. That frame is already being drawn, and dirtying the scene from it
    // would take a wheel gesture off the blit for its whole duration.
    if (!programmatic) this.requestDraw();
  }

  /**
   * Grow a symbol bubble into its whole file, or shrink it back.
   *
   * Expanding keeps the SYMBOL in view — the file is context for the thing the
   * user dragged out, not a replacement for it — so the fetch lands scrolled to
   * the symbol's first line rather than at the top of the file.
   */
  private toggleBubbleExpand(id: string): void {
    const bubble = this.bubbleById(id);
    const node = this.model?.get(bubble?.nodeId ?? '');
    if (!bubble || !node) return;
    bubble.expanded = !bubble.expanded;
    bubble.pendingLine = bubble.expanded ? node.startLine : null;
    if (!bubble.expanded) bubble.scrollTop = 0;
    this.refreshBubbleHeader(bubble);
    this.loadBubbleSource(bubble);
    this.notifyWorkspace();
  }

  /** The header's jump. Same order the node panel uses: configured command wins. */
  private openBubbleInEditor(id: string): void {
    const bubble = this.bubbleById(id);
    const node = this.model?.get(bubble?.nodeId ?? '');
    if (!bubble || !node) return;
    void openInEditor(node.file, node.startLine).then((result) => {
      if (result.ok || result.reason !== 'unconfigured') return;
      // Nothing configured server-side: hand the OS the URL scheme instead,
      // exactly as the node panel does.
      const base = (this.model?.root ?? '').replace(/[\\/]+$/, '');
      const joined = base ? `${base}/${node.file}` : node.file;
      const absolute = joined.replace(/\\/g, '/');
      const path = absolute.startsWith('/') ? absolute : `/${absolute}`;
      window.location.href = `vscode://file${path}:${node.startLine}`;
    });
  }

  /**
   * Place every bubble for this frame — the ONLY per-frame bubble work.
   *
   * One transform each, from the camera the canvas is about to be (or has just
   * been) drawn under. No React, no layout read, no canvas call: bubbles are
   * DOM and the blit never learns they exist. The frame's `width`/`height` are
   * still not touched here — they change only on a resize or a re-layout — but
   * the transform carries the frame SCALE as well as the position (B2.3),
   * which is a composited write that reflows nothing. Which is why a zoom
   * gesture is free: the whole of a bubble's response to it is this string.
   */
  private syncBubbles(): void {
    if (this.bubbles.length === 0) return;
    const origin = this.origin();
    const scale = this.scale();
    const presentation = bubblePresentation(scale);
    for (const bubble of this.bubbles) {
      bubble.view.place(
        origin.x + bubble.x * scale,
        origin.y + bubble.y * scale,
        presentation.label,
        presentation.frameScale,
        // The camera's scale, less whatever this bubble's LAYOUT has already
        // taken (B2.3). Written here and nowhere else, from the layout scale
        // the settle pass above has already applied, so the transform and the
        // box the DOM was given always multiply back to the frame scale on the
        // line beside it.
        bubbleRootScale(presentation.frameScale, bubble.fontScale)
      );
    }
  }

  /**
   * Re-lay every bubble at the camera's own scale, on the frame the camera
   * SETTLES (B2.3) — the sharp half of the zoom model.
   *
   * Zooming a bubble is a transform, which is smooth and costs nothing and
   * upscales a raster taken at the old scale. That is the right trade for the
   * duration of a gesture and the wrong one to leave the picture in, so when
   * the camera stops the frame is laid out at the size it is being read at and
   * the root's transform is divided by the same number: the picture does not
   * move, and the type stops being an enlargement of an 11px raster and starts
   * being 11px of type at 3×.
   *
   * The settle gate is the same one the disks' label pass uses
   * ({@link cameraSettling}), for the same reason — this is a real layout of
   * every row of every open bubble, and paying it once per gesture rather than
   * once per frame is the difference between a wheel zoom that is free and one
   * that is not. The frame after the window closes is guaranteed: a settling
   * frame always schedules its successor.
   *
   * It runs at the TOP of a frame, before the chrome pass, so the DOM the user
   * sees and the arithmetic the threads are drawn from describe the same body.
   * It is a no-op on every frame that is not a settled scale change — which is
   * every pan, every hover, every selection — and while a bubble is showing
   * its label there is nothing to lay out, so it is skipped there too and
   * picked up on the way back in.
   */
  private syncBubbleFont(): void {
    if (this.bubbles.length === 0 || this.cameraSettling()) return;
    const presentation = bubblePresentation(this.scale());
    if (presentation.label) return;
    for (const bubble of this.bubbles) {
      if (bubble.fontScale === presentation.fontScale) continue;
      const from = bubble.fontScale;
      bubble.fontScale = presentation.fontScale;
      bubble.view.setFontScale(presentation.fontScale);
      if (!bubble.measured) continue;
      // The frame was just re-laid out at a different size of type, and type
      // does not wrap at exactly proportional places at every size (B3) — so
      // the row offsets are re-read from the layout that was just written,
      // before anything is computed from them.
      this.measureBubbleBody(bubble);
      // The centre-line rule: whatever was in the middle of the frame stays in
      // the middle of it. Under a frame that scales as one thing that is the
      // offset it already had — but the DOM holds the offset in LAYOUT px, so
      // the same reading position is a different number over there, and the
      // view is told again in frame px so it can write the new one. Applied
      // AFTER the layout write, so the scrollport it lands in is the one the
      // new layout made.
      const next = bubbleScrollForFontScale({
        scrollTop: bubble.scrollTop,
        viewportHeight: this.bubbleViewportHeight(bubble),
        padTop: bubble.metrics.padTop,
        padBottom: bubble.metrics.padBottom,
        lineHeight: bubble.metrics.lineHeight,
        lineCount: bubble.lineCount,
        // What the scrollport can actually scroll, measured (B3): with
        // wrapping, `rows × lineHeight` is a floor on the content, not the
        // content, and a limit built from it would clamp the offset short.
        ...(bubble.metrics.contentHeight !== undefined
          ? { contentHeight: bubble.metrics.contentHeight }
          : {}),
        fromScale: from,
        toScale: presentation.fontScale,
      });
      bubble.scrollTop = next;
      bubble.view.setScrollTop(next);
    }
  }

  /** The scrolling part of a frame: its height less the header and its borders. */
  private bubbleViewportHeight(bubble: BubbleState): number {
    return Math.max(0, bubble.h - bubble.metrics.headerHeight - BUBBLE_FRAME_BORDER_PX * 2);
  }

  /**
   * Where a bubble's FRAME sits on screen right now, and how big it is drawn.
   *
   * Its size is the user's own frame px times the camera's scale, at every
   * zoom (B2.3) — read from the same helper the DOM transform composes to, so
   * the canvas and the overlay cannot disagree about how big a bubble is. The
   * position is derived from the LIVE camera rather than from anything the
   * last frame stored, so a tether cannot lag the frame it leaves by a frame
   * during a gesture.
   */
  private bubbleScreenRect(bubble: BubbleState): BubbleRect {
    const origin = this.origin();
    const scale = this.scale();
    const frameScale = bubbleFrameScale(scale);
    return {
      x: origin.x + bubble.x * scale,
      y: origin.y + bubble.y * scale,
      w: bubble.w * frameScale,
      h: bubble.h * frameScale,
    };
  }

  /**
   * Where a bubble's PAINTED face sits on screen right now (B3.1).
   *
   * The frame, while the frame is what is being drawn — the two rectangles are
   * then the same numbers. Below the label threshold they are not: the frame
   * keeps shrinking with the world while the label counter-scales to a fixed
   * size on screen, so what a user sees down there is the label block, and the
   * frame under it is a speck inside it. Anything that has to touch the OUTSIDE
   * of a bubble — every tether — is built from this rectangle rather than from
   * the frame, or it lands in the middle of the thing it was aiming at.
   *
   * The two are concentric, so nothing that only wants a bubble's CENTRE has to
   * choose between them.
   */
  private bubblePaintedScreenRect(bubble: BubbleState): BubbleRect {
    const frame = this.bubbleScreenRect(bubble);
    if (!bubbleIsLabel(this.scale())) return frame;
    const label = bubble.labelSize;
    if (!label) return frame;
    // The block's `max-width: 100%`, in the unit the block is painted in: its
    // ceiling is the frame's width in FRAME px, because the counter-scale gives
    // back exactly the factor the root's transform took. Measured unclamped
    // (the layout scale can widen the ceiling above 1), clamped here, so a
    // resize needs no re-measurement.
    return bubblePaintedRect(frame, { w: Math.min(label.w, bubble.w), h: label.h });
  }

  /**
   * The screen point of a bubble's ORIGIN wedge, and the wedge's outward
   * direction — `null` when no disk renders it right now.
   *
   * A disk that was closed or re-rooted away, or a legend filter that made the
   * wedge invisible, all end the same way: the tether is simply not drawn. It
   * is deliberately NOT re-attached to the disk's root or its centre — a line
   * to a wedge that is not the one the bubble came from would be a false claim
   * about where the code is.
   */
  private bubbleAnchor(bubble: BubbleState): { point: Point; out: Point } | null {
    const preferred = this.diskById(bubble.sourceDiskId);
    const candidates = preferred ? [preferred, ...this.disks] : this.disks;
    const scale = this.scale();
    const origin = this.origin();
    for (const disk of candidates) {
      const arc = disk.layout?.byNode.get(bubble.nodeId);
      if (!arc || this.isHiddenArc(arc)) continue;
      const centroid = arcCentroid(arc);
      const mid = (arc.a0 + arc.a1) / 2;
      return {
        point: {
          x: origin.x + (disk.x + centroid.x) * scale,
          y: origin.y + (disk.y + centroid.y) * scale,
        },
        out: { x: Math.cos(mid), y: Math.sin(mid) },
      };
    }
    return null;
  }

  /**
   * Bubble tethers, in SCREEN space, in the chrome pass.
   *
   * Chrome for the same reason the disk `×` is: it is drawn AFTER the snapshot
   * is captured, so it can never be baked into a blitted frame — and because it
   * is re-computed from the live camera every frame, it follows a pan or a zoom
   * gesture exactly, while the picture under it is being stamped.
   */
  private drawBubbleTethers(ctx: CanvasRenderingContext2D): void {
    if (this.bubbles.length === 0) return;
    ctx.lineCap = 'round';
    ctx.setLineDash([]);
    ctx.strokeStyle = TETHER_COLOR;
    ctx.lineWidth = TETHER_WIDTH_PX;
    for (const bubble of this.bubbles) {
      // A bubble opened from a call marker has a CALLER, not a wedge, for an
      // origin (phase B2): its thread is the call tether, drawn separately and
      // leaving the exact line that opened it. Drawing a wedge tether as well
      // would give it two origins, only one of which is true.
      if (bubble.origin.kind === 'bubble') continue;
      const anchor = this.bubbleAnchor(bubble);
      if (!anchor) continue;
      // The PAINTED rect, not the frame (B3.1): a zoomed-out bubble is its
      // label, and a line that stopped at the frame's border would stop inside
      // the block the user is looking at rather than on its edge.
      const curve = bubbleTetherAnchor(
        this.bubblePaintedScreenRect(bubble),
        anchor.point,
        anchor.out
      );
      if (!curve) continue;
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

      // The same direction dot the disk tether wears, at the end that is the
      // code: this line means "that wedge is what is in this box".
      ctx.beginPath();
      ctx.arc(curve.end.x, curve.end.y, TETHER_DOT_PX, 0, Math.PI * 2);
      ctx.fillStyle = BACKGROUND;
      ctx.fill();
      ctx.stroke();
    }
  }

  // -------------------------------------------- code bubbles: call tracing ---

  /**
   * Rebuild everything a bubble knows about its outgoing relations (phase B2).
   *
   * Called on a content load and nowhere else. Two products, both cached:
   *
   *  - `calls` — the outgoing `calls`/`references` edges of everything the
   *    bubble DISPLAYS, each with the call-site line the tether will leave by;
   *  - `callLines` — the gutter's marker plan, `mapBubbleCallSites`.
   *
   * The edge lookup rides the model's existing per-node adjacency index, so
   * this is O(the displayed subtree's edges) once, never a scan of the graph
   * and never per frame. A frame does anchor arithmetic over `calls` and
   * nothing else.
   */
  private rebuildBubbleCalls(
    bubble: BubbleState,
    firstLine: number,
    lastLine: number,
    file: string
  ): void {
    bubble.firstLine = firstLine;
    bubble.lineCount = Math.max(0, lastLine - firstLine + 1);
    bubble.measured = false;
    this.measureBubbleBody(bubble);

    bubble.calls = [];
    bubble.callLines = new Map();
    const model = this.model;
    if (!model) {
      bubble.view.setCallSites(new Map());
      return;
    }

    // What this bubble displays: its own node and everything under it, plus —
    // once it has been expanded to the whole file — that file's own subtree,
    // which is where a file bubble's calls actually come from.
    const scopeIds = new Set<string>([bubble.nodeId, ...model.descendants(bubble.nodeId)]);
    if (bubble.expanded) {
      const fileId = this.fileNodeOf(bubble.nodeId);
      if (fileId) {
        scopeIds.add(fileId);
        for (const id of model.descendants(fileId)) scopeIds.add(id);
      }
    }

    const scope: BubbleCallSiteScope = {
      ownerId: bubble.nodeId,
      file,
      firstLine: bubble.firstLine,
      lastLine: bubble.firstLine + Math.max(0, bubble.lineCount - 1),
    };
    const spans = new Map<string, BubbleCallSiteSpan>();
    const candidates: BubbleCallSiteEdge[] = [];
    const outgoing: ModelEdge[] = [];
    for (const id of scopeIds) {
      const node = model.get(id);
      if (node) spans.set(id, { file: node.file, startLine: node.startLine, endLine: node.endLine });
      for (const edge of model.edgesOf(id)) {
        if (edge.source !== id) continue;
        if (!CALL_TETHER_KINDS.has(edge.kind)) continue;
        outgoing.push(edge);
        const candidate: BubbleCallSiteEdge = {
          source: edge.source,
          target: edge.target,
          kind: edge.kind,
        };
        if (edge.line !== undefined) candidate.line = edge.line;
        candidates.push(candidate);
      }
    }

    bubble.callLines = mapBubbleCallSites(candidates, spans, scope);

    // The tether list. Same containment rule as the gutter (they must never
    // disagree about which edges a bubble owns), and the same dedupe: two
    // identical relations recorded twice are one thread, while two call sites
    // on different lines are two — that is the phase's whole claim.
    const seen = new Set<string>();
    for (const edge of outgoing) {
      if (!bubbleCallSiteInScope(spans, scope, edge.source)) continue;
      const line =
        edge.line !== undefined && edge.line >= scope.firstLine && edge.line <= scope.lastLine
          ? Math.floor(edge.line)
          : null;
      const key = `${edge.target}|${edge.kind}|${line ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const call: BubbleCall = {
        targetId: edge.target,
        line,
        kind: edge.kind,
        heuristic: edge.heuristic,
      };
      if (edge.synthesizedBy) call.synthesizedBy = edge.synthesizedBy;
      bubble.calls.push(call);
    }

    this.publishCallSites(bubble);
  }

  /** Hand the view its marker plan, with the names and openability the gutter shows. */
  private publishCallSites(bubble: BubbleState): void {
    const model = this.model;
    const sites = new Map<number, BubbleCallSite[]>();
    for (const [line, targets] of model ? bubble.callLines : new Map<number, string[]>()) {
      const entries: BubbleCallSite[] = [];
      for (const id of targets) {
        const node = model?.get(id);
        if (!node) continue;
        entries.push({
          id,
          name: node.name,
          kind: node.kind,
          available: this.bubbleable(id),
        });
      }
      if (entries.length > 0) sites.set(line, entries);
    }
    bubble.view.setCallSites(sites);
  }

  // -------------------------------------------------- bubble change marks ---

  /**
   * Decorate one bubble's gutter with what changed since `HEAD` (B4.6) — the
   * bubble half of the changes toggle.
   *
   * The gate is the SAME state the sub-wedges are drawn from: no change
   * markers means the toggle is off (or there is nothing to show), and a
   * bubble whose file is not one of the edited ones is left alone without a
   * request ever being made. So switching the toggle off clears every bubble
   * in the same turn as the click, and switching it on re-decorates without
   * touching the source the bubbles are already displaying.
   *
   * The span is the one the body is ACTUALLY showing (`firstLine` /
   * `lineCount`, both measured from the loaded rows), not the node's span in
   * the index — an "expand to file" and a stale index both move one without
   * moving the other, and a mark on the wrong row is worse than no mark.
   */
  private applyBubbleChanges(bubble: BubbleState): void {
    const model = this.model;
    if (this.changeMarkers.size === 0 || !model || bubble.lineCount <= 0) {
      bubble.view.setChangeMarks(null);
      return;
    }
    const fileId = this.fileNodeOf(bubble.nodeId);
    const path = fileId && this.changeMarkers.has(fileId) ? model.get(fileId)?.file : null;
    if (!path) {
      bubble.view.setChangeMarks(null);
      return;
    }
    const hunks = this.changeDiffs.get(path);
    if (hunks === undefined) {
      // Not fetched yet. The response re-enters here for every bubble on the
      // file, so there is nothing to draw and nothing to clear right now.
      this.loadChangeDiff(path);
      return;
    }
    if (!hunks) {
      bubble.view.setChangeMarks(null);
      return;
    }
    const marks = spanChangeMarks(hunks, bubble.firstLine, bubble.firstLine + bubble.lineCount - 1);
    bubble.view.setChangeMarks(spanChangesEmpty(marks) ? null : marks);
  }

  /**
   * Fetch one edited file's hunks, once, and decorate every bubble showing it.
   *
   * Failure is recorded as `null` rather than retried: the same request would
   * fail the same way for every other bubble on that file, and a bubble that
   * cannot show its diff simply shows its code. The epoch check is what keeps
   * a response that outlived its payload from landing.
   */
  private loadChangeDiff(path: string): void {
    if (this.changeDiffPending.has(path)) return;
    this.changeDiffPending.add(path);
    const epoch = this.changeEpoch;
    void fetchSourceDiff(path)
      .then((diff) => (Array.isArray(diff.hunks) ? diff.hunks : null))
      .catch(() => null)
      .then((hunks) => {
        if (epoch !== this.changeEpoch || this.disposed) return;
        this.changeDiffPending.delete(path);
        this.changeDiffs.set(path, hunks);
        for (const bubble of this.bubbles) {
          const fileId = this.fileNodeOf(bubble.nodeId);
          if (fileId && this.model?.get(fileId)?.file === path) this.applyBubbleChanges(bubble);
        }
      });
  }

  /** The `file` node a bubble's node belongs to — itself, or the nearest ancestor. */
  private fileNodeOf(nodeId: string): string | null {
    const model = this.model;
    if (!model) return null;
    if (model.get(nodeId)?.kind === 'file') return nodeId;
    for (const ancestor of model.ancestors(nodeId)) {
      if (model.get(ancestor)?.kind === 'file') return ancestor;
    }
    return null;
  }

  /**
   * Read the body's geometry back out of the DOM — once per content load.
   *
   * The one layout read a bubble ever costs. Everything the tethers do
   * afterwards is arithmetic over these three numbers, so a frame with twenty
   * threads on it still touches the DOM exactly zero times.
   */
  private measureBubbleBody(bubble: BubbleState): boolean {
    const geometry = bubble.view.bodyGeometry();
    if (!geometry) return false;
    bubble.measured = true;
    bubble.metrics = {
      headerHeight: geometry.headerHeight,
      padTop: geometry.padTop,
      padBottom: geometry.padBottom,
      lineHeight: geometry.lineHeight,
      // B3: where every row actually is, since a wrapped line is no longer at
      // its index times a row height. Carried as data so the anchor stays a
      // pure function of numbers the DOM was asked for once.
      rowEdges: geometry.rowEdges,
      contentHeight: geometry.contentHeight,
    };
    bubble.firstLine = geometry.firstLine;
    bubble.lineCount = geometry.lineCount;
    return true;
  }

  /** The bubble showing `nodeId`, if one is open — the topmost, so a raise wins. */
  private bubbleForNode(nodeId: string): BubbleState | null {
    let best: BubbleState | null = null;
    for (const bubble of this.bubbles) {
      if (bubble.nodeId !== nodeId) continue;
      if (!best || bubble.z > best.z) best = bubble;
    }
    return best;
  }

  /**
   * The caller-side anchor of one thread: the call-site line, on the border
   * that faces the other end.
   */
  private bubbleCallAnchorOf(
    bubble: BubbleState,
    line: number | null,
    towardX: number
  ): BubbleCallAnchorPoint {
    const presentation = bubblePresentation(this.scale());
    return bubbleCallAnchor({
      // Same rectangle the origin tether leaves (B3.1). Above the threshold it
      // IS the frame, number for number, so every regime that reads a header or
      // a row offset out of it is untouched; below it, where the only regime is
      // the centred one, it is the label block the thread has to reach.
      rect: this.bubblePaintedScreenRect(bubble),
      label: presentation.label,
      // The scale the DOM composes to — the same helper the rect and `place`
      // read, so the canvas and the overlay share one number. How the frame
      // splits it between a layout and a transform is not in here, because it
      // cancels out of the picture entirely (B2.3).
      frameScale: presentation.frameScale,
      metrics: bubble.metrics,
      firstLine: bubble.firstLine,
      lineCount: bubble.lineCount,
      scrollTop: bubble.scrollTop,
      line,
      towardX,
    });
  }

  /** The callee-side anchor: the header (or the centred label), on the facing border. */
  private bubbleHeaderAnchor(bubble: BubbleState, towardX: number): BubbleCallAnchorPoint {
    return this.bubbleCallAnchorOf(bubble, null, towardX);
  }

  /**
   * Click-to-open, the other half of the tracing loop (phase B2).
   *
   * The callee lands to the RIGHT of its caller, level with the call site, so a
   * traced chain reads left to right the way the calls do. A callee that is
   * already open is not duplicated — it is raised and its thread flashes, which
   * answers "where did that go" without adding a second copy of the same code
   * to the workspace. A callee with no source (external, unresolved) is a
   * no-op: the marker's own title says why, and nothing errors.
   */
  private openCallee(callerId: string, line: number, calleeId: string): void {
    const caller = this.bubbleById(callerId);
    const model = this.model;
    if (!caller || !model || !model.get(calleeId)) return;

    const existing = this.bubbleForNode(calleeId);
    if (existing) {
      this.raiseBubble(existing.id);
      existing.flashUntil = performance.now() + CALL_FLASH_MS;
      this.requestDraw();
      return;
    }
    if (!this.bubbleable(calleeId)) return;

    const scale = this.scale();
    const origin = this.origin();
    const frameScale = bubbleFrameScale(scale);
    const rect = this.bubbleScreenRect(caller);
    const anchor = this.bubbleCallAnchorOf(caller, line, Number.POSITIVE_INFINITY);
    // Screen px back into world units. Both frame-px quantities — the gap and
    // the header lift — are drawn through the frame scale, so they cross it
    // before the camera's (B2.3); since those two are now the same number the
    // placement is pure WORLD arithmetic at every zoom, and "to the right,
    // level with the call site" holds throughout instead of sliding as the
    // camera moves. The top is lifted by the header so it is the
    // new bubble's CONTENT that lands level with the call site, which is what
    // "level with" has to mean for the eye.
    const x = (rect.x + rect.w + CALL_OPEN_GAP_PX * frameScale - origin.x) / scale;
    const y = (anchor.y - caller.metrics.headerHeight * frameScale - origin.y) / scale;

    // The chain keeps its COLUMN — the callee is as wide as the caller, so a
    // traced flow reads as a row of boxes rather than a ragged one, and a
    // width the user dragged carries down the chain. Its HEIGHT is its own
    // (B3): the callee is usually far shorter than whatever opened it, and
    // inheriting a tall box gave a four-line function twenty lines of nothing.
    const size = clampBubbleSize(caller.w, bubbleDefaultSize(this.bubbleLoc(calleeId)).h);
    this.createBubble({
      nodeId: calleeId,
      x,
      y,
      w: size.w,
      h: size.h,
      scrollTop: 0,
      expanded: false,
      sourceDiskId: null,
      origin: { kind: 'bubble', callerNodeId: caller.nodeId, line },
    });
    this.notifyWorkspace();
  }

  /**
   * Call threads, in SCREEN space, in the chrome pass — the phase's picture.
   *
   * Chrome for exactly the reasons B1's origin tether is: drawn after
   * `captureSnapshot`, recomputed from the live camera, so it can never be
   * baked into a blitted frame and it follows a pan, a zoom, a bubble drag and
   * a bubble SCROLL live. Two passes, and the order is the subordination: the
   * fainter bubble→wedge threads go down first, the bubble→bubble ones on top.
   */
  private drawBubbleCallTethers(ctx: CanvasRenderingContext2D): void {
    if (this.bubbles.length === 0) return;
    const byNode = new Map<string, BubbleState[]>();
    for (const bubble of this.bubbles) {
      const list = byNode.get(bubble.nodeId);
      if (list) list.push(bubble);
      else byNode.set(bubble.nodeId, [bubble]);
    }
    this.drawBubbleDiskTethers(ctx, byNode);
    this.drawBubbleToBubbleTethers(ctx, byNode);
  }

  /** Threads whose callee is another open bubble. */
  private drawBubbleToBubbleTethers(
    ctx: CanvasRenderingContext2D,
    byNode: Map<string, BubbleState[]>
  ): void {
    const now = performance.now();
    const drawn = new Set<string>();
    for (const bubble of this.bubbles) {
      for (const call of bubble.calls) {
        if (!this.enabledKinds.has(call.kind)) continue;
        const targets = byNode.get(call.targetId);
        if (!targets) continue;
        for (const target of targets) {
          if (target === bubble) continue;
          // Exact duplicates collapse; two call sites on different lines do not.
          const key = `${bubble.id}|${target.id}|${call.kind}|${call.line ?? ''}`;
          if (drawn.has(key)) continue;
          drawn.add(key);

          const targetRect = this.bubbleScreenRect(target);
          const sourceRect = this.bubbleScreenRect(bubble);
          const from = this.bubbleCallAnchorOf(bubble, call.line, targetRect.x + targetRect.w / 2);
          const to = this.bubbleHeaderAnchor(target, sourceRect.x + sourceRect.w / 2);
          const hot = target.flashUntil > now || bubble.flashUntil > now;
          this.strokeCallTether(ctx, from, to, {
            color: hot ? CALL_TETHER_COLOR_HOT : CALL_TETHER_COLOR,
            width: hot ? CALL_TETHER_WIDTH_PX * 1.8 : CALL_TETHER_WIDTH_PX,
            dashed: call.heuristic,
            label: call.heuristic ? (call.synthesizedBy ?? 'synthesized') : null,
          });
        }
      }
    }
  }

  /**
   * Threads whose callee is not open as a bubble but IS on screen as a wedge.
   *
   * Capped at {@link CALL_DISK_TETHER_MAX}, nearest first, from at most
   * {@link CALL_DISK_TETHER_SCAN} candidates per bubble: a file bubble with
   * eight hundred calls must not be able to wallpaper the canvas, and the
   * nearest threads are the ones whose geometry the eye can actually follow.
   * Visibility is the legend-aware one ⌘P uses — a wedge a filter switched off
   * is not on screen, so nothing is drawn to where it would have been.
   */
  private drawBubbleDiskTethers(
    ctx: CanvasRenderingContext2D,
    byNode: Map<string, BubbleState[]>
  ): void {
    type Candidate = {
      from: BubbleCallAnchorPoint;
      to: Point;
      out: Point;
      distance: number;
      call: BubbleCall;
    };
    const candidates: Candidate[] = [];
    for (const bubble of this.bubbles) {
      let scanned = 0;
      const rect = this.bubbleScreenRect(bubble);
      const centre = { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 };
      for (const call of bubble.calls) {
        if (scanned >= CALL_DISK_TETHER_SCAN) break;
        scanned += 1;
        if (!this.enabledKinds.has(call.kind)) continue;
        if (byNode.has(call.targetId)) continue; // A bubble owns it — see above.
        const wedge = this.nearestVisibleWedge(call.targetId, centre);
        if (!wedge) continue;
        candidates.push({
          from: this.bubbleCallAnchorOf(bubble, call.line, wedge.point.x),
          to: wedge.point,
          out: wedge.out,
          distance: wedge.distance,
          call,
        });
      }
    }
    if (candidates.length === 0) return;
    candidates.sort((a, b) => a.distance - b.distance);
    for (const candidate of candidates.slice(0, CALL_DISK_TETHER_MAX)) {
      this.strokeCallTether(
        ctx,
        candidate.from,
        { x: candidate.to.x, y: candidate.to.y, side: 'right', clamped: false, mode: 'header' },
        {
          color: CALL_DISK_TETHER_COLOR,
          width: CALL_DISK_TETHER_WIDTH_PX,
          dashed: candidate.call.heuristic,
          label: null,
          endOut: candidate.out,
        }
      );
    }
  }

  /**
   * The nearest disk that renders `nodeId` as a visible wedge, and how far its
   * centroid is from `from` on screen.
   *
   * "Renders" is `diskShowing`'s notion — a wedge of its own, not hidden by the
   * legend — because a thread to a `+N` fold or to an ancestor would point at
   * something that is not the callee.
   */
  private nearestVisibleWedge(
    nodeId: string,
    from: Point
  ): { point: Point; out: Point; distance: number } | null {
    const origin = this.origin();
    const scale = this.scale();
    let best: { point: Point; out: Point; distance: number } | null = null;
    for (const disk of this.disks) {
      const arc = disk.layout?.byNode.get(nodeId);
      if (!arc || this.isHiddenArc(arc)) continue;
      const centroid = arcCentroid(arc);
      const point = {
        x: origin.x + (disk.x + centroid.x) * scale,
        y: origin.y + (disk.y + centroid.y) * scale,
      };
      const distance = Math.hypot(point.x - from.x, point.y - from.y);
      if (best && best.distance <= distance) continue;
      const mid = (arc.a0 + arc.a1) / 2;
      best = { point, out: { x: Math.cos(mid), y: Math.sin(mid) }, distance };
    }
    return best;
  }

  /**
   * One thread: a cubic that leaves the caller sideways and arrives at the
   * callee sideways, with the direction dot at the CALLEE end.
   *
   * Horizontal arms rather than the wedge tether's radial ones — two boxes are
   * side by side, so a thread that leaves and arrives horizontally reads as a
   * flow across the workspace instead of a lasso around it.
   */
  private strokeCallTether(
    ctx: CanvasRenderingContext2D,
    from: BubbleCallAnchorPoint,
    to: BubbleCallAnchorPoint,
    style: {
      color: string;
      width: number;
      dashed: boolean;
      label: string | null;
      endOut?: Point;
    }
  ): void {
    if (!Number.isFinite(from.x) || !Number.isFinite(from.y)) return;
    if (!Number.isFinite(to.x) || !Number.isFinite(to.y)) return;
    const gap = Math.hypot(to.x - from.x, to.y - from.y);
    if (!(gap > 1e-6)) return;
    const arm = Math.min(Math.max(CALL_TETHER_MIN_ARM, gap * CALL_TETHER_ARM_SHARE), gap / 2);
    const outX = from.side === 'right' ? arm : -arm;
    const endArm = style.endOut
      ? { x: style.endOut.x * arm, y: style.endOut.y * arm }
      : { x: to.side === 'right' ? arm : -arm, y: 0 };

    ctx.lineCap = 'round';
    ctx.strokeStyle = style.color;
    ctx.lineWidth = style.width;
    ctx.setLineDash(style.dashed ? [5, 4] : []);
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.bezierCurveTo(
      from.x + outX,
      from.y,
      to.x + endArm.x,
      to.y + endArm.y,
      to.x,
      to.y
    );
    ctx.stroke();
    ctx.setLineDash([]);

    // The direction dot, at the end that is the CALLEE: without it a thread
    // between two boxes is undirected, and "which of these two calls the
    // other" is the one thing it exists to say.
    ctx.beginPath();
    ctx.arc(to.x, to.y, CALL_TETHER_DOT_PX, 0, Math.PI * 2);
    ctx.fillStyle = BACKGROUND;
    ctx.fill();
    ctx.stroke();

    if (style.label) {
      // A synthesized hop is dashed like every other heuristic relation, and
      // says WHO wired it — the one fact a dashed line cannot carry on its own.
      ctx.font = '500 9px ui-sans-serif, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = style.color;
      ctx.fillText(style.label, (from.x + to.x) / 2, (from.y + to.y) / 2 - 6);
      ctx.textAlign = 'left';
      ctx.textBaseline = 'alphabetic';
    }
  }

  /** Is any bubble's thread still flashing? Keeps the frame loop alive if so. */
  private bubblesFlashing(): boolean {
    if (this.bubbles.length === 0) return false;
    const now = performance.now();
    return this.bubbles.some((bubble) => bubble.flashUntil > now);
  }

  /** Drop every bubble — a different project has different nodes. */
  private clearBubbles(): void {
    for (const bubble of this.bubbles) {
      bubble.requestSeq++;
      bubble.view.destroy();
    }
    this.bubbles = [];
  }

  /**
   * A re-index: a bubble whose node went away goes with it, and the survivors
   * re-fetch, since a file's lines move under a node that kept its id.
   */
  private refreshBubbles(): void {
    const model = this.model;
    if (!model) return;
    // A re-index moves lines under every hunk we cached, so the diffs go with
    // the source (B4.6). The refreshed `/api/changes` payload lands a moment
    // later and bumps the epoch again; both paths converge on one re-fetch per
    // file, and neither can leave a mark on a row it no longer describes.
    this.changeEpoch += 1;
    this.changeDiffs.clear();
    this.changeDiffPending.clear();
    const gone = this.bubbles.filter((bubble) => !model.nodes.has(bubble.nodeId));
    for (const bubble of gone) {
      bubble.requestSeq++;
      bubble.view.destroy();
    }
    if (gone.length > 0) {
      this.bubbles = this.bubbles.filter((bubble) => model.nodes.has(bubble.nodeId));
    }
    for (const bubble of this.bubbles) {
      this.refreshBubbleHeader(bubble);
      this.loadBubbleSource(bubble);
    }
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

  /**
   * May this disk be rooted at `id`? Everything at or below its floor, which is
   * everything for the primary.
   *
   * Written as a containment test rather than as `rootId === floorId` so it
   * holds no matter how the disk got where it is — a re-root that somehow
   * landed outside the subtree is refused rather than silently allowed to keep
   * climbing.
   */
  private canRootAt(disk: DiskState, id: string): boolean {
    const floor = disk.floorId;
    if (!floor || id === floor) return true;
    const model = this.model;
    if (!model) return true;
    return model.ancestors(id).includes(floor);
  }

  /**
   * Where this disk's centre circle goes when clicked — `null` when there is
   * nowhere up, which is the project root for the primary disk and the FLOOR
   * for a spawned one. The `▲ <parent>` hint reads off the same answer, so the
   * button and the affordance offering it can never disagree.
   */
  private upTarget(disk: DiskState): string | null {
    const parent = this.model?.get(disk.rootId)?.parent ?? null;
    return parent && this.canRootAt(disk, parent) ? parent : null;
  }

  /** Re-root one disk. Secondary disks never touch the URL or the history. */
  private setDiskRoot(disk: DiskState, id: string, animate = true): void {
    const model = this.model;
    if (!model || !model.nodes.has(id) || id === disk.rootId) return;
    // The floor is enforced HERE — the one funnel every re-root goes through
    // (the centre circle, Backspace, Enter, a card, ⌘P's drill-down) — rather
    // than at each of them.
    if (!this.canRootAt(disk, id)) return;
    const previousDepth = model.get(disk.rootId)?.depth ?? 0;
    const nextDepth = model.get(id)?.depth ?? 0;
    disk.rootId = id;
    disk.rootChangedAt = performance.now();
    // The CAMERA does not move. Drilling into a wedge used to reset the primary
    // disk's zoom and pan, which yanked the picture back to the default framing
    // — in a workspace where the user has panned to a corner (or zoomed into a
    // second disk) that is the whole view moving because one disk re-rooted.
    // A disk drills IN PLACE, at its workspace position; re-framing is `fit`,
    // and it is an explicit gesture. The wedge-morph animation below stays.
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
    // The primary's root is the hash's business; a secondary's is the store's.
    if (!disk.primary) this.notifyWorkspace();
  }

  /**
   * Step one level out — Backspace and the centre circle both do this.
   *
   * A disk already sitting on its floor has nowhere up: nothing happens. It is
   * deliberately a no-op and not "close the disk" — Backspace is navigation,
   * and a key that navigates four times and then destroys the thing you were
   * navigating is a key nobody can hold down.
   */
  rootUp(): void {
    const disk = this.focused();
    const parent = this.upTarget(disk);
    if (parent) this.setDiskRoot(disk, parent);
  }

  /**
   * Re-root onto a result set — what a card does.
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
   * and pulse there, and take the focus with it. Nothing re-roots, because the
   * thing the user asked for is already drawn; re-rooting to show a second copy
   * of it would be strictly worse. The camera does move, but only if it has to
   * and only as far as it has to: {@link panIntoView} slides the wedge onto the
   * screen and changes nothing else — no zoom, no re-framing.
   *
   * Otherwise the node has to be drilled to, and the disk that drills is the
   * one already CLOSEST to it: the disk whose root is the deepest ancestor of
   * the target (the focused one first on a tie). That keeps a ⌘P jump inside
   * the subtree the user is standing in instead of always yanking the primary
   * disk somewhere else — and, because a disk only ever qualifies for a target
   * inside its own subtree, it can never take a secondary disk above its floor.
   * "Visible" then means an arc actually exists: re-rooting to the parent is
   * the normal answer, but a node can still be swallowed by its parent's `+N`
   * fold arc (a directory of 900 files), so the fallback re-roots onto the node
   * ITSELF — the centre disk always renders the root, so ⌘P can reach anything.
   */
  reveal(id: string, pulse = false): boolean {
    const model = this.model;
    if (!model) return false;
    const node = model.get(id);
    if (!node) return false;

    const showing = this.diskShowing(id);
    const disk = showing ?? this.drillDiskFor(id);
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
    this.panIntoView(disk, id);

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
   *
   * "Renders" honours the legend: a wedge whose category is switched off is not
   * painted at all, so a disk holding only that is not showing the node and the
   * drill-down below has to answer instead. The disk's own ROOT always counts —
   * the centre circle is drawn whatever the filters say.
   */
  private diskShowing(id: string): DiskState | null {
    const shows = (disk: DiskState): boolean => {
      if (disk.rootId === id) return true;
      const arc = disk.layout?.byNode.get(id);
      return arc !== undefined && !this.isHiddenArc(arc);
    };
    const focused = this.focused();
    if (shows(focused)) return focused;
    return this.disks.find(shows) ?? null;
  }

  /**
   * The disk a ⌘P jump should DRILL when no disk renders the target: the one
   * whose root is the deepest ancestor of it, i.e. the shortest way down.
   *
   * Ties go to the focused disk, which is the pre-existing behaviour and the
   * right one — "the disk I am working in" is the answer the user expects when
   * two of them are equally close. A disk only ever qualifies for a node inside
   * its own subtree, so a secondary disk chosen here is drilling DOWN by
   * construction and its floor is never in question.
   */
  private drillDiskFor(id: string): DiskState {
    const model = this.model;
    const primary = this.primary();
    if (!model) return primary;
    const focused = this.focused();
    const chain = new Set([id, ...model.ancestors(id)]);
    let best: DiskState | null = null;
    let bestDepth = -1;
    for (const disk of this.disks) {
      if (!chain.has(disk.rootId)) continue;
      const depth = model.get(disk.rootId)?.depth ?? 0;
      if (depth > bestDepth || (depth === bestDepth && disk.id === focused.id)) {
        best = disk;
        bestDepth = depth;
      }
    }
    return best ?? primary;
  }

  /**
   * Slide the camera the SMALLEST distance that puts a node's wedge on screen.
   *
   * A jump that lands on something already visible must not move the picture at
   * all, and one that lands off screen must not re-frame the workspace either —
   * the user's zoom is theirs. So this is a pure translation, computed from the
   * wedge's own anchor (its centroid, or the disk's centre when the node IS the
   * root) against the free viewport inset by {@link REVEAL_PAD_PX}, and it is a
   * no-op whenever the anchor is already inside that box.
   */
  private panIntoView(disk: DiskState, id: string): void {
    const arc = disk.layout?.byNode.get(id) ?? null;
    const point = this.toScreen(anchorOf(disk, arc));
    const gutter = this.width > GUTTER_MIN_WIDTH ? PANEL_GUTTER : 0;
    const left = gutter + REVEAL_PAD_PX;
    const right = Math.max(left, this.width - REVEAL_PAD_PX);
    const top = REVEAL_PAD_PX;
    const bottom = Math.max(top, this.height - REVEAL_PAD_PX);

    let dx = 0;
    let dy = 0;
    if (point.x < left) dx = left - point.x;
    else if (point.x > right) dx = right - point.x;
    if (point.y < top) dy = top - point.y;
    else if (point.y > bottom) dy = bottom - point.y;
    if (dx === 0 && dy === 0) return;

    this.panX += dx;
    this.panY += dy;
    this.cameraMoved();
    this.emitSummary();
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
    // Bubbles are in the frame too since B4.7. They were left out while a
    // bubble was something the user had just dragged out and was looking at;
    // one click can now open two dozen of them, and a fit that framed only the
    // disks would leave most of what it just created off screen.
    const bounds = contentBounds(this.placements(), this.bubbleRects());
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

  // ------------------------------------------------- expand all changes ---

  /**
   * Open the WHOLE changeset at once (B4.7) — the legend's `expand` button.
   *
   * One click, and the workspace becomes a picture of everything uncommitted:
   * every changed file has a wedge you can actually see, and every changed
   * symbol has its code on the canvas. It is the one question this UI is asked
   * more than any other ("what did the agent just do") answered without a
   * single navigation.
   *
   * Four steps, in this order and for these reasons:
   *
   *  1. **Which files.** The change payload's own files, ordered by how much of
   *     each actually changed (lines touched, not file size), so every cap
   *     below spends its budget on the biggest edits.
   *  2. **Make them visible.** A changed file already drawn in some disk needs
   *     nothing. The rest are covered by as FEW new disks as possible —
   *     {@link coverChangedFiles} — rather than one disk per file: eight disks
   *     of one file each is not a picture of a changeset.
   *  3. **Open the code.** A bubble per changed symbol, breadth first across
   *     the files; a file whose changes hit no symbol at all (top-level code, a
   *     brand-new file the index has no symbols for) gets one bubble of its
   *     own, so no change is silently unrepresented.
   *  4. **Frame it.** The existing fit, which now includes bubbles.
   *
   * **Idempotent.** A symbol that already has a bubble is skipped and a file
   * already on screen spawns nothing, so clicking twice with nothing new
   * changed spawns nothing and simply re-fits. Everything it creates is an
   * ORDINARY disk or bubble — movable, closable, persisted — because a special
   * kind of disk would be a second thing to learn and a second thing to
   * maintain.
   */
  expandAllChanges(): void {
    const model = this.model;
    if (!model || this.changeMarkers.size === 0) {
      this.fitView();
      return;
    }

    const files = this.changedFilesByWeight();
    const roots = this.coverChangedFiles(files.filter((id) => !this.diskShowing(id)));
    const targets = this.changeBubbleTargets(files);
    if (roots.length === 0 && targets.length === 0) {
      this.fitView();
      return;
    }

    // ---- plan: one pure pass over what is here and what was asked for ----
    const planIds = new Map<string, string>();
    const layouts = new Map<string, SunburstLayout>();
    const diskRequests: DiskSpawnRequest[] = roots.map((rootId, index) => {
      const id = `plan:${index}`;
      const layout = this.layoutFor(rootId);
      planIds.set(id, rootId);
      layouts.set(id, layout);
      return { id, radius: layout.maxRadius, near: this.changeSpawnNear(rootId, layout.maxRadius) };
    });

    const fallback = this.changeSpawnFallback();
    const bubbleRequests: BubbleSpawnRequest[] = targets.map((target) => {
      const size = bubbleDefaultSize(this.bubbleLoc(target.nodeId));
      return {
        id: target.nodeId,
        w: size.w,
        h: size.h,
        anchor: this.changeBubbleAnchor(target, layouts),
        near: fallback,
      };
    });

    const plan = planExpansion(this.placements(), this.bubbleRects(), {
      disks: diskRequests,
      bubbles: bubbleRequests,
    });

    // ---- apply -----------------------------------------------------------
    const spawned = new Map<string, string>();
    for (const placed of plan.disks) {
      const rootId = planIds.get(placed.id);
      if (!rootId) continue;
      const source = this.diskShowing(rootId)?.id ?? PRIMARY_DISK_ID;
      // The planned point already clears every disk by the gap `placeSpawnedDisk`
      // enforces, so the spawn's own nudge is a no-op and the disk lands exactly
      // where the plan (which also knew about the bubbles) put it.
      const disk = this.spawnDisk(
        rootId,
        { x: placed.x, y: placed.y },
        source,
        layouts.get(placed.id) ?? null
      );
      if (disk) spawned.set(placed.id, disk.id);
    }

    for (const placed of plan.bubbles) {
      const anchor = bubbleRequests.find((request) => request.id === placed.id)?.anchor ?? null;
      const anchorDisk = anchor ? (spawned.get(anchor.diskId) ?? anchor.diskId) : null;
      this.createBubble({
        nodeId: placed.id,
        x: placed.x,
        y: placed.y,
        w: placed.w,
        h: placed.h,
        scrollTop: 0,
        expanded: false,
        sourceDiskId: this.diskById(anchorDisk)?.id ?? null,
        origin: { kind: 'wedge' },
      });
    }

    this.notifyWorkspace();
    this.fitView();
  }

  /** Bubble footprints in WORLD units — a bubble's frame px are its size there. */
  private bubbleRects(): Rect[] {
    return this.bubbles.map((bubble) => ({ x: bubble.x, y: bubble.y, w: bubble.w, h: bubble.h }));
  }

  /**
   * Changed files, biggest edit first.
   *
   * "Biggest" is LINES TOUCHED, reconstructed from the same two shares the disk
   * sizes its sub-wedges from (each is a fraction of the file's own length, so
   * multiplying by that length gives the count back). Ranking by file size
   * instead would put a 4,000-line file with a typo above a 40-line file that
   * was rewritten, which is the opposite of what a reviewer wants first.
   */
  private changedFilesByWeight(): string[] {
    const model = this.model;
    if (!model) return [];
    const entries: Array<{ id: string; score: number; path: string }> = [];
    for (const [fileId, marker] of this.changeMarkers) {
      const node = model.get(fileId);
      if (!node) continue;
      const loc = Math.max(1, node.weight);
      entries.push({
        id: fileId,
        score: (marker.added + marker.removed) * loc,
        path: node.file || node.name,
      });
    }
    entries.sort(
      (a, b) => b.score - a.score || a.path.localeCompare(b.path) || a.id.localeCompare(b.id)
    );
    return entries.map((entry) => entry.id);
  }

  /**
   * The fewest disk roots that make every hidden changed file visible.
   *
   * A greedy set cover over the files' own ancestor directories, and the
   * coverage test is not a guess — it is the REAL layout: a candidate covers a
   * file when `computeSunburst` rooted there actually renders that file's arc
   * and the legend has not switched it off. So a directory of 900 files that
   * would fold the one you edited into a `+N` scores zero for it and is not
   * chosen, which is exactly the case a "just root at the parent" heuristic
   * gets wrong.
   *
   * Ties go to the SHALLOWER candidate (it has more room to absorb the files
   * still uncovered), then to the lower id, so the answer is stable for a given
   * workspace and changeset. Candidates are capped per file and in total — the
   * cover is a click's worth of work, not a search.
   *
   * A file no ancestor can surface gets a disk rooted at ITSELF: a disk always
   * draws its own root as the centre circle, so that is the one root guaranteed
   * to show it.
   */
  private coverChangedFiles(needy: readonly string[]): string[] {
    const model = this.model;
    if (!model || needy.length === 0) return [];

    const candidates: string[] = [];
    const seen = new Set<string>();
    for (const file of needy) {
      let levels = 0;
      for (const ancestor of model.ancestors(file)) {
        if (levels++ >= CHANGE_COVER_LEVELS) break;
        if (seen.has(ancestor)) continue;
        seen.add(ancestor);
        candidates.push(ancestor);
        if (candidates.length >= MAX_COVER_CANDIDATES) break;
      }
      if (candidates.length >= MAX_COVER_CANDIDATES) break;
    }

    const coverage = new Map<string, Set<string>>();
    for (const candidate of candidates) {
      const layout = this.layoutFor(candidate);
      const covered = new Set<string>();
      for (const file of needy) {
        if (layout.rootId === file) {
          covered.add(file);
          continue;
        }
        const arc = layout.byNode.get(file);
        if (arc && !this.isHiddenArc(arc)) covered.add(file);
      }
      if (covered.size > 0) coverage.set(candidate, covered);
    }

    const remaining = new Set(needy);
    const roots: string[] = [];
    while (remaining.size > 0 && roots.length < MAX_CHANGE_DISKS) {
      let best: string | null = null;
      let bestCount = 0;
      let bestDepth = 0;
      for (const [candidate, covered] of coverage) {
        let count = 0;
        for (const file of covered) if (remaining.has(file)) count++;
        if (count === 0) continue;
        const depth = model.get(candidate)?.depth ?? 0;
        const better =
          best === null ||
          count > bestCount ||
          (count === bestCount && (depth < bestDepth || (depth === bestDepth && candidate < best)));
        if (!better) continue;
        best = candidate;
        bestCount = count;
        bestDepth = depth;
      }
      if (!best) break;
      roots.push(best);
      for (const file of coverage.get(best) ?? []) remaining.delete(file);
    }

    for (const file of needy) {
      if (roots.length >= MAX_CHANGE_DISKS) break;
      if (!remaining.has(file)) continue;
      remaining.delete(file);
      roots.push(file);
    }
    return roots;
  }

  /**
   * Which nodes get a bubble, BREADTH FIRST across the changed files.
   *
   * Round-robin rather than file-by-file: every changed file is offered its
   * first bubble before any file is offered its second, so a single file with
   * forty edited methods cannot spend the whole budget. Within a file the
   * symbols come in declaration order, which is the order the reviewer reads
   * them in.
   *
   * A file whose changes intersect no symbol falls back to a bubble of the file
   * itself — an untracked file the index has no symbols for, or an edit to
   * top-level code — because "there is a change here and nothing on screen says
   * so" is the one outcome this button must not produce.
   */
  private changeBubbleTargets(
    files: readonly string[]
  ): Array<{ nodeId: string; fileId: string }> {
    const model = this.model;
    if (!model) return [];

    const perFile = new Map<string, string[]>();
    for (const id of this.changedNodes) {
      const node = model.get(id);
      if (!node || node.kind === 'file' || node.kind === DIRECTORY_KIND) continue;
      if (!this.bubbleable(id)) continue;
      const fileId = this.fileNodeOf(id);
      if (!fileId) continue;
      const list = perFile.get(fileId);
      if (list) list.push(id);
      else perFile.set(fileId, [id]);
    }
    for (const [fileId, list] of perFile) {
      list.sort((a, b) => {
        const first = model.get(a);
        const second = model.get(b);
        return (first?.startLine ?? 0) - (second?.startLine ?? 0) || a.localeCompare(b);
      });
      if (list.length === 0) perFile.delete(fileId);
    }

    const picksOf = (fileId: string): string[] => {
      const symbols = perFile.get(fileId);
      if (symbols && symbols.length > 0) return symbols;
      return this.bubbleable(fileId) ? [fileId] : [];
    };

    const targets: Array<{ nodeId: string; fileId: string }> = [];
    for (let round = 0; targets.length < MAX_CHANGE_BUBBLES; round++) {
      let offered = false;
      for (const fileId of files) {
        const nodeId = picksOf(fileId)[round];
        if (nodeId === undefined) continue;
        offered = true;
        // Already open — the whole reason a second click spawns nothing.
        if (this.bubbleForNode(nodeId)) continue;
        if (targets.length >= MAX_CHANGE_BUBBLES) break;
        targets.push({ nodeId, fileId });
      }
      if (!offered) break;
    }
    return targets;
  }

  /**
   * Which disk a change bubble should sit beside, and on what bearing.
   *
   * Its own wedge if any disk (existing or about to exist) draws it, otherwise
   * its file's wedge — the bubble then lands just outside that disk's rim on
   * the wedge's own mid angle, which is where its tether will attach, so the
   * tether stays short and readable instead of crossing the workspace.
   */
  private changeBubbleAnchor(
    target: { nodeId: string; fileId: string },
    planned: ReadonlyMap<string, SunburstLayout>
  ): BubbleAnchor | null {
    const find = (id: string): BubbleAnchor | null => {
      for (const disk of this.disks) {
        const arc = disk.layout?.byNode.get(id);
        if (arc && !this.isHiddenArc(arc)) return { diskId: disk.id, angle: (arc.a0 + arc.a1) / 2 };
      }
      for (const [planId, layout] of planned) {
        const arc = layout.byNode.get(id);
        if (arc) return { diskId: planId, angle: (arc.a0 + arc.a1) / 2 };
      }
      return null;
    };
    return find(target.nodeId) ?? find(target.fileId);
  }

  /** Where a change disk would like to open: beside the wedge it expands. */
  private changeSpawnNear(rootId: string, radius: number): Point {
    for (const disk of this.disks) {
      const arc = disk.layout?.byNode.get(rootId);
      if (!arc || this.isHiddenArc(arc)) continue;
      const angle = (arc.a0 + arc.a1) / 2;
      const reach = (disk.layout?.maxRadius ?? MAX_RADIUS) + DISK_GAP + radius;
      return { x: disk.x + Math.cos(angle) * reach, y: disk.y + Math.sin(angle) * reach };
    }
    return this.changeSpawnFallback();
  }

  /** Off the right-hand edge of everything on the canvas — the last resort. */
  private changeSpawnFallback(): Point {
    const bounds = contentBounds(this.placements(), this.bubbleRects());
    return { x: bounds.maxX + DISK_GAP, y: bounds.cy };
  }

  destroy(): void {
    this.disposed = true;
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.resizeObserver.disconnect();
    window.removeEventListener('keydown', this.onModifierChange);
    window.removeEventListener('keyup', this.onModifierChange);
    this.clearBubbles();
    this.bubbleLayer.remove();
    this.canvas.remove();
    // The snapshot is a second backing store the size of the canvas — let it go
    // with the canvas it mirrors.
    this.snapshotCanvas = null;
    this.snapshotCamera = null;
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

  /** The legend row a NODE belongs to — the unit an interactive legend hides. */
  private legendKeyForNode(node: ModelNode): string {
    if (this.colorMode !== 'layer') return node.kind;
    return node.kind === DIRECTORY_KIND ? DIRECTORY_LEGEND_KEY : (node.layer ?? '');
  }

  /** The legend row a wedge belongs to. `null` for a `+N` fold arc. */
  private legendKeyFor(arc: SunburstArc): string | null {
    const node = arc.nodeId ? this.model?.get(arc.nodeId) : undefined;
    return node ? this.legendKeyForNode(node) : null;
  }

  /** Is this NODE switched off in the legend? The unit every filter reads. */
  private isHiddenNode(id: string): boolean {
    if (this.hiddenColorKeys.size === 0) return false;
    const node = this.model?.get(id);
    return node ? this.hiddenColorKeys.has(this.legendKeyForNode(node)) : false;
  }

  /**
   * Is this wedge switched off in the legend?
   *
   * A `+N` fold arc has no kind of its own — it stands in for the children it
   * folded, so the legend reaches it through THEM: the arc is hidden exactly
   * when every node it folded is hidden. A `+15` holding three methods reads
   * `+12` with methods switched off (see {@link visibleAggregatedCount}) and
   * disappears entirely once nothing it stands for is left, because a fold arc
   * that folds nothing visible is a promise of content that is not there.
   */
  private isHiddenArc(arc: SunburstArc): boolean {
    if (this.hiddenColorKeys.size === 0) return false;
    if (!arc.nodeId) {
      return arc.aggregated.length > 0 && this.visibleAggregatedCount(arc) === 0;
    }
    const key = this.legendKeyFor(arc);
    return key !== null && this.hiddenColorKeys.has(key);
  }

  /**
   * The folded children a `+N` arc still stands for — its layout metadata
   * (`SunburstArc.aggregated`, the folded node ids) minus the categories the
   * legend switched off.
   *
   * The count is baked into the arc's label at LAYOUT time, and the layout is a
   * pure function of (model, root, options) that deliberately knows nothing
   * about the legend — a filter that re-flowed the disk would be a filter you
   * cannot use to compare two states. So the recount happens here, at render
   * time, from the ids the layout exposes.
   */
  private visibleAggregated(arc: SunburstArc): string[] {
    if (this.hiddenColorKeys.size === 0) return arc.aggregated;
    return arc.aggregated.filter((id) => !this.isHiddenNode(id));
  }

  /** Same recount, memoised per arc — the painter asks once per wedge per frame. */
  private visibleAggregatedCount(arc: SunburstArc): number {
    if (this.hiddenColorKeys.size === 0) return arc.aggregated.length;
    const cached = this.aggregateCounts.get(arc);
    if (cached !== undefined) return cached;
    let count = 0;
    for (const id of arc.aggregated) if (!this.isHiddenNode(id)) count++;
    this.aggregateCounts.set(arc, count);
    return count;
  }

  /** What a wedge is CALLED on screen — a fold arc's `+N` is recounted. */
  private labelTextFor(arc: SunburstArc): string {
    if (arc.nodeId || this.hiddenColorKeys.size === 0) return arc.label;
    return `+${this.visibleAggregatedCount(arc)}`;
  }

  /** Drop the memoised fold-arc counts — the filters or the arcs changed. */
  private invalidateAggregates(): void {
    this.aggregateCounts.clear();
    for (const disk of this.disks) disk.labelPlan = null;
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

  /**
   * Ask for a frame because SOMETHING CHANGED — the model, the layouts, the
   * hover, a filter, a card, a disk's position…
   *
   * This is the default and every mutation path uses it: it marks the scene
   * dirty, which is what forbids the next frame from reusing the snapshot. A
   * path that genuinely only moved the camera opts out explicitly
   * ({@link requestCameraDraw}); anything that forgets to is merely slower, not
   * wrong, which is the right way round for a cache like this.
   */
  private requestDraw(): void {
    this.sceneDirty = true;
    this.scheduleFrame();
  }

  /**
   * Ask for a frame after a CAMERA-ONLY gesture — a pan drag, a wheel zoom.
   *
   * Exactly two callers, and adding a third means proving the scene is
   * bit-identical under the new camera.
   */
  private requestCameraDraw(kind: 'pan' | 'zoom'): void {
    this.cameraGestureAt = performance.now();
    this.cameraGestureKind = kind;
    this.scheduleFrame();
  }

  /** One frame, coalesced. Neither marks nor clears {@link sceneDirty}. */
  private scheduleFrame(): void {
    if (this.frame !== null || this.disposed) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = null;
      if (this.disposed) return;
      this.draw();
      if (this.disks.some((disk) => disk.transitionStart > 0)) this.scheduleFrame();
    });
  }

  private draw(): void {
    const ratio = window.devicePixelRatio || 1;

    // Before anything is painted: on a SETTLED camera, re-lay every bubble at
    // the scale it is being read at and re-anchor its scroll (B2.3). It has to
    // happen ahead of the chrome pass, because that pass draws threads from
    // the very metrics this updates — and it is a no-op on any frame the
    // settled scale did not change on, which is every frame of a gesture.
    this.syncBubbleFont();

    // A hit test the camera's motion deferred lands here, on the first settled
    // frame, so the hover it produces is painted by the redraw below rather
    // than by a frame of its own.
    if (this.pendingHover && !this.cameraSettling()) {
      const at = this.pendingHover;
      this.pendingHover = null;
      this.updateHover(at);
    }

    // Mid-gesture, with nothing but the camera changed: stamp the last exact
    // frame back through the camera delta and paint only what the move exposed.
    if (this.drawGesture(ratio)) {
      this.syncBubbles();
      return;
    }
    this.drawFull(ratio);
    // Bubbles are DOM: they ride the same camera the frame was painted under,
    // but they are placed AFTER it and never touch the canvas — so a bubble can
    // neither dirty the scene nor end up inside a snapshot.
    this.syncBubbles();
  }

  /**
   * A frame with nothing to reuse: clear, paint the whole viewport, keep it.
   *
   * The picture is written straight onto the visible canvas in CSS px — there
   * is no offscreen scene canvas, and there never will be again (see
   * {@link SnapshotCamera}). The snapshot is taken from the finished pixels,
   * BEFORE the chrome goes on: the `×` and the tether dot are hover-gated and
   * hover is frozen for the duration of a gesture, so baking them in would
   * stamp a button that the pointer has since left. The chrome is screen-space
   * and costs two circles, so every frame — full or gesture — simply draws it
   * fresh on top of a chrome-less scene.
   */
  private drawFull(ratio: number): void {
    // Cleared BEFORE painting: a mutation that lands mid-frame (a summary
    // callback re-entering the controller) must survive as dirty, so the next
    // frame is a real redraw and the capture below is skipped.
    const sceneChanged = this.sceneDirty;
    this.sceneDirty = false;

    const ctx = this.ctx;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.globalAlpha = 1;
    ctx.clearRect(0, 0, this.width, this.height);
    ctx.fillStyle = BACKGROUND;
    ctx.fillRect(0, 0, this.width, this.height);

    const model = this.model;
    if (!model) {
      this.snapshotCamera = null;
      return;
    }

    if (this.edgesDirty) this.rebuildEdges();

    const origin = this.origin();
    const scale = this.scale();
    this.paintScene(ctx, model, origin, scale, this.viewport(), true);

    this.captureSnapshot(ratio, origin, scale, sceneChanged);

    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.globalAlpha = 1;
    this.drawDiskChrome(ctx);
    this.drawBubbleTethers(ctx);
    this.drawBubbleCallTethers(ctx);
    this.drawGhost(ctx);

    // Two things keep the frame loop alive on their own: the ⌘P pulse, and the
    // camera-settle window that owes the labels one more (full) pass.
    if (this.pulseNodeId !== null || this.cameraSettling() || this.bubblesFlashing()) {
      this.scheduleFrame();
    }

    // The edge count is part of the summary, and it only ever changes here.
    if (this.drawnEdges.length !== this.emittedEdges) this.emitSummary();
  }

  /**
   * The camera-gesture fast path: move the last exact frame and fill in what
   * moving it exposed. `true` when the frame was served this way.
   *
   * Culling made a gesture frame cheap in geometry but not in pixels — arc
   * fills and per-glyph curved labels rasterise at commit, so a culled frame
   * still hands the compositor the whole viewport of fresh ink. Here the
   * viewport arrives as one `drawImage` (GPU, viewport-sized, never larger) and
   * the only scene work is the strip the move uncovered: one or two thin edges
   * for a pan, a thin frame for a zoom out. Because a pan RE-CAPTURES the
   * composed result each frame, the next frame's strip is only the next few
   * pixels — the strip cost is O(this frame's delta), not O(the whole pan).
   *
   * Every condition below is a reason the snapshot cannot describe this frame:
   * the scene changed, a disk is animating, the pulse is breathing, the canvas
   * or its device pixel ratio moved under it, a NON-camera drag is in flight
   * (the wedge ghost, a disk being moved), or the gesture has simply stopped.
   */
  private drawGesture(ratio: number): boolean {
    const snapshot = this.snapshotCamera;
    const source = this.snapshotCanvas;
    const model = this.model;
    if (!snapshot || !source || !model || this.sceneDirty) return false;
    if (performance.now() - this.cameraGestureAt >= BLIT_GESTURE_MS) return false;
    if (snapshot.ratio !== ratio) return false;
    if (snapshot.width !== this.width || snapshot.height !== this.height) return false;
    if (this.pulseNodeId !== null) return false;
    if (this.drag !== null && this.drag.mode !== 'pan') return false;
    if (this.disks.some((disk) => disk.transitionStart > 0)) return false;

    const origin = this.origin();
    const scale = this.scale();
    const plan = planGestureBlit(snapshot, origin.x, origin.y, scale);
    if (!plan) return false;

    const ctx = this.ctx;

    // 1. The snapshot, moved. A pan is a whole-device-px translation of an
    //    image onto itself at its own size, so it cannot resample; a zoom is
    //    the same image scaled about the point the wheel pinned, which is
    //    exactly what (origin, scale) then vs now says.
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.imageSmoothingEnabled = plan.kind === 'zoom';
    ctx.drawImage(source, plan.dest.x, plan.dest.y, plan.dest.w, plan.dest.h);
    ctx.imageSmoothingEnabled = true;

    // 2. What the move exposed, painted LIVE — the same scene code, clipped to
    //    the strip and culled to it. Black edges are impossible by
    //    construction: the blit's on-screen part and these rects tile the
    //    viewport exactly, and every one of them is background-filled first.
    if (this.edgesDirty) this.rebuildEdges();
    const stripOrigin = { x: plan.originX, y: plan.originY };
    for (const rect of plan.exposed) {
      ctx.save();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.beginPath();
      ctx.rect(rect.x, rect.y, rect.w, rect.h);
      ctx.clip();
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      ctx.globalAlpha = 1;
      const view: ViewRect = {
        x0: rect.x / ratio,
        y0: rect.y / ratio,
        x1: (rect.x + rect.w) / ratio,
        y1: (rect.y + rect.h) / ratio,
      };
      ctx.fillStyle = BACKGROUND;
      ctx.fillRect(view.x0, view.y0, view.x1 - view.x0, view.y1 - view.y0);
      this.paintScene(ctx, model, stripOrigin, scale, view, false);
      ctx.restore();
    }

    // 3. Keep the composed result, and advance the stored camera to the ROUNDED
    //    one the pixels now show. A zoom deliberately does not: re-capturing a
    //    resampled image would compound its blur frame over frame, so a wheel
    //    gesture keeps scaling the last SETTLED snapshot until it runs out of
    //    ratio (see {@link ZOOM_BLIT_MAX_RATIO}).
    if (plan.kind === 'pan') this.captureSnapshot(ratio, stripOrigin, snapshot.scale, false);

    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.globalAlpha = 1;
    this.drawDiskChrome(ctx);
    this.drawBubbleTethers(ctx);
    this.drawBubbleCallTethers(ctx);
    this.drawGhost(ctx);

    if (this.pulseNodeId !== null || this.cameraSettling() || this.bubblesFlashing()) {
      this.scheduleFrame();
    }
    return true;
  }

  /**
   * The scene itself — every disk, then the workspace-space ropes — for one
   * rectangle of the canvas.
   *
   * The rectangle is the whole viewport for a full frame and one exposed strip
   * for a gesture frame, and NOTHING here knows which: a strip is the same
   * arcs, centres, edges, tethers and labels in the same order, clipped by the
   * caller and culled to the same rect. `planLabels` is the one distinction —
   * see {@link drawLabels}.
   */
  private paintScene(
    ctx: CanvasRenderingContext2D,
    model: GraphModel,
    origin: Point,
    scale: number,
    view: ViewRect,
    planLabels: boolean
  ): void {
    // Planning is deliberately WIDER than painting: see LABEL_PLAN_MARGIN_PX.
    const planView: ViewRect | null = planLabels
      ? {
          x0: view.x0 - LABEL_PLAN_MARGIN_PX,
          y0: view.y0 - LABEL_PLAN_MARGIN_PX,
          x1: view.x1 + LABEL_PLAN_MARGIN_PX,
          y1: view.y1 + LABEL_PLAN_MARGIN_PX,
        }
      : null;

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

      // A disk whose whole bounding circle is off screen paints nothing: no
      // arcs, no centre, no labels, no ropes of its own. Its TETHER and its
      // cross-disk relations are not its own — they live in workspace space and
      // are culled by their own curve below, since either can cross a viewport
      // that neither of its two disks touches.
      const k = scale * animationScale;
      const cx = origin.x + disk.x * scale;
      const cy = origin.y + disk.y * scale;
      const cull = this.cullFor(cx, cy, k, view);
      if (cull.dMin > layout.maxRadius) continue;

      ctx.save();
      ctx.translate(cx, cy);
      ctx.scale(k, k);
      ctx.globalAlpha = progress < 1 ? 0.25 + 0.75 * eased : 1;

      this.drawArcs(ctx, disk, layout, model, k, cull);
      if (cull.dMin <= layout.centreRadius) this.drawCentre(ctx, disk, layout, k);
      this.drawEdges(ctx, disk.id, k, cull);
      this.drawLabels(
        ctx,
        disk,
        model,
        k,
        cull,
        planView ? this.cullFor(cx, cy, k, planView) : null
      );

      ctx.restore();
    }

    // Cross-disk relations live in workspace space and are drawn once, over the
    // disks: a curve that vanished under an opaque wedge would claim a
    // connection it never showed.
    const workspaceCull = this.cullFor(origin.x, origin.y, scale, view);
    ctx.save();
    ctx.translate(origin.x, origin.y);
    ctx.scale(scale, scale);
    // Tethers first, so a code edge is never hidden under one.
    this.drawTethers(ctx, scale, workspaceCull);
    this.drawEdges(ctx, null, scale, workspaceCull);
    ctx.restore();
  }

  /**
   * Keep the pixels just painted, with the camera they show.
   *
   * The snapshot canvas is exactly the size of the visible backing store, and
   * the copy is canvas → canvas, never `getImageData`: this is a GPU blit,
   * a readback is a synchronisation point.
   *
   * Skipped — and the previous snapshot dropped — while anything is animating:
   * a transition or pulse frame is a moment in an animation, not a scene at
   * rest, and reusing one after the animation finished would show the picture
   * mid-morph. Dropping rather than keeping is the safe direction: no snapshot
   * simply means the next gesture frame is a full redraw.
   */
  private captureSnapshot(
    ratio: number,
    origin: Point,
    scale: number,
    sceneChanged: boolean
  ): void {
    // A wheel gesture blits from the last SETTLED snapshot and never refreshes
    // it, which is also what makes the ratio bound stick: once the zoom leaves
    // the snapshot, nothing re-bases it, so the rest of the gesture is direct
    // redraws. The one thing that overrides that is the scene itself changing
    // under the gesture — then the held snapshot describes a picture that no
    // longer exists, and it is dropped rather than kept.
    if (
      this.cameraGestureKind === 'zoom' &&
      performance.now() - this.cameraGestureAt < BLIT_GESTURE_MS
    ) {
      if (sceneChanged) this.snapshotCamera = null;
      return;
    }
    const animating =
      this.sceneDirty || this.pulseNodeId !== null || this.disks.some((d) => d.transitionStart > 0);
    const width = this.canvas.width;
    const height = this.canvas.height;
    if (animating || width === 0 || height === 0) {
      this.snapshotCamera = null;
      return;
    }
    let target = this.snapshotCanvas;
    if (!target) {
      target = document.createElement('canvas');
      this.snapshotCanvas = target;
    }
    if (target.width !== width || target.height !== height) {
      target.width = width;
      target.height = height;
    }
    const ctx = target.getContext('2d');
    if (!ctx) {
      this.snapshotCamera = null;
      return;
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, width, height);
    ctx.drawImage(this.canvas, 0, 0);
    this.snapshotCamera = {
      originX: origin.x,
      originY: origin.y,
      scale,
      ratio,
      width: this.width,
      height: this.height,
    };
  }

  /** The whole visible canvas, in CSS px. */
  private viewport(): ViewRect {
    return { x0: 0, y0: 0, x1: this.width, y1: this.height };
  }

  /**
   * A rect of the canvas in the local units of a frame whose origin sits at
   * screen `(cx, cy)` and whose unit is `k` screen px — a disk's frame, or the
   * workspace's.
   *
   * `view` is the CSS-px rect actually being painted, padded by
   * {@link CULL_MARGIN_PX} for the strokes and glyphs that sit slightly outside
   * their wedge at its own edge. For a full frame that is the visible canvas;
   * for a gesture strip it is the strip, which is what makes the strip nearly
   * free — the cull rejects everything the pan did not uncover.
   */
  private cullFor(cx: number, cy: number, k: number, view: ViewRect): ViewCull {
    return makeCull(
      (view.x0 - CULL_MARGIN_PX - cx) / k,
      (view.y0 - CULL_MARGIN_PX - cy) / k,
      (view.x1 + CULL_MARGIN_PX - cx) / k,
      (view.y1 + CULL_MARGIN_PX - cy) / k
    );
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
    k: number,
    cull: ViewCull
  ): void {
    const pulseAlpha = disk.id === this.pulseDiskId ? this.pulseAlpha() : 0;
    const focus = this.hasFocus();
    for (const arc of layout.arcs) {
      // Off screen: rejected before any path work, and before the rim and the
      // change markers that ride the same wedge. Iteration order and everything
      // painted for a surviving arc are untouched.
      if (!arcVisible(cull, arc)) continue;
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
      // A wedge expanded as its own disk is drawn HOLLOW: the canvas's own
      // background inside, its normal colour on the outline. Stretched to the
      // rim it is by far the largest shape on the disk, and painted solid it
      // dominated a picture whose subject is somewhere else entirely — the
      // other disk. An outline says "this is an open channel, the content is
      // over there" and still reads as the wedge's own colour under the active
      // mode. Its label, hit test and tether anchor are untouched.
      const fill = this.fillFor(arc, model);
      const hollow = arc.nodeId !== null && layout.collapsed.has(arc.nodeId);
      if (hollow) {
        ctx.fillStyle = BACKGROUND;
        ctx.fill();
        ctx.strokeStyle = withAlpha(fill, Math.max(alpha, 0.85));
        ctx.lineWidth = 1.6 / k;
        ctx.stroke();
      } else {
        ctx.fillStyle = withAlpha(fill, alpha);
        ctx.fill();
      }

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
   * Uncommitted edits, as sub-wedges of the file's own wedge.
   *
   * Green (added) takes the leading edge of the wedge's angular span, red
   * (removed) follows it, both at the wedge's full radial depth and both
   * FILLED, so the corners are square and the pair reads as part of the wedge.
   * The widths come from {@link changeSubWedgeSpans} — pure arithmetic over the
   * span and the two shares, so what is painted is exactly what that function
   * can be probed for.
   *
   * Slightly translucent: this is a standing annotation on the normal view, not
   * a mode, so it has to survive being always on — and the wedge's kind colour
   * has to stay legible under it.
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
    const spans = changeSubWedgeSpans(a1 - a0, marker.added, marker.removed);
    if (spans.added <= 0 && spans.removed <= 0) return;

    let cursor = a0;
    const sub = (extent: number, color: string): void => {
      if (extent <= 0) return;
      const end = cursor + extent;
      // A filled annular sector: out along the leading edge, around the rim,
      // back down the trailing edge, around the inner arc. No stroke anywhere,
      // so nothing here can acquire a cap or a join.
      ctx.beginPath();
      ctx.arc(0, 0, arc.r1, cursor, end);
      ctx.arc(0, 0, arc.r0, end, cursor, true);
      ctx.closePath();
      ctx.fillStyle = withAlpha(color, MARKER_ALPHA * alpha);
      ctx.fill();
      cursor = end;
    };

    sub(spans.added, MARKER_ADDED);
    sub(spans.removed, MARKER_REMOVED);
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
    // the name (`▲ <parent>`); where there is nowhere up — the project root on
    // the primary disk, the FLOOR on a spawned one — the hint is simply absent,
    // which is the whole of how the floor is advertised.
    const parentId = this.upTarget(disk);
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
  private drawTethers(ctx: CanvasRenderingContext2D, k: number, cull: ViewCull): void {
    if (this.disks.length < 2) return;
    ctx.lineCap = 'round';
    ctx.setLineDash([]);
    for (const disk of this.disks) {
      const curve = this.tetherOf(disk);
      if (!curve) continue;
      // A tether belongs to neither disk's frame, so it is culled by its own
      // hull: the curve can cross a viewport that shows neither of its ends.
      if (!boxVisible(cull, [curve.start, curve.control1, curve.control2, curve.end])) continue;
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

      // A small dot where the tether ARRIVES, on the expanded disk's rim: the
      // line is symmetric, so without it the pair reads as an undirected thread
      // and "which of these two is the expansion" has to be worked out from the
      // wedge at the other end. Screen-sized (like the `×`), hollow, and NOT a
      // button — the close affordance stays on the middle of the line.
      const dot = TETHER_DOT_PX / k;
      ctx.beginPath();
      ctx.arc(curve.end.x, curve.end.y, dot, 0, Math.PI * 2);
      ctx.fillStyle = BACKGROUND;
      ctx.fill();
      ctx.strokeStyle = hot ? TETHER_COLOR_HOVER : TETHER_COLOR;
      ctx.lineWidth = TETHER_WIDTH_PX / k;
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
  private drawEdges(
    ctx: CanvasRenderingContext2D,
    diskId: string | null,
    k: number,
    cull: ViewCull
  ): void {
    if (this.drawnEdges.length === 0) return;
    ctx.lineCap = 'round';
    for (const drawn of this.drawnEdges) {
      if (drawn.diskId !== diskId) continue;
      if (drawn.points.length < 2) continue;
      // A rope is culled by its own bounding box, in the frame its polyline is
      // expressed in — the same rule for a bundled curve and a cross-disk one.
      if (!boxVisible(cull, drawn.points)) continue;
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
    k: number,
    cull: ViewCull,
    planCull: ViewCull | null
  ): void {
    // While the camera is moving the last PLAN is replayed through arithmetic
    // gates only. Rebuilding it costs an orientation choice and a `measureText`
    // per candidate wedge, which at 60fps is exactly the judder the round-4
    // review reported; the gates below are a handful of multiplications and the
    // real pass runs the moment the gesture stops.
    //
    // `planCull === null` means this pass is one EXPOSED STRIP of a gesture
    // frame, and it replays or it draws nothing: a plan built from a strip
    // would be a plan for the strip, and storing it would throw away every
    // label on the rest of the screen. A wedge the pan has just uncovered
    // therefore arrives bare and is named when the camera settles — which the
    // wide planning margin makes rare, since a plan already covers a screen
    // third past every edge.
    const build = planCull !== null && !(this.cameraSettling() && disk.labelPlan !== null);
    let plan: PlannedLabel[];
    if (build) {
      plan = this.buildLabelPlan(ctx, disk, k, planCull!);
      disk.labelPlan = plan;
    } else if (disk.labelPlan !== null) {
      plan = disk.labelPlan;
    } else {
      return;
    }
    const reuse = !build;

    for (const label of plan) {
      const arc = label.geom.arc;
      // Off screen: rejected before the ink is even resolved. A replayed plan
      // was measured against a different viewport, so the gate belongs here as
      // well as in the pass that builds one.
      if (!arcVisible(cull, arc)) continue;
      if (this.isHiddenArc(arc)) continue;
      if (reuse && !this.planStillFits(label, k)) continue;
      // A hollow (expanded-away) wedge has the canvas background behind its
      // name, not its own colour, so the ink that would be readable ON the
      // colour can be the wrong one — it wears the colour itself instead.
      const hollow = arc.nodeId !== null && (disk.layout?.collapsed.has(arc.nodeId) ?? false);
      const ink = this.isDimmed(disk, arc)
        ? DIM_LABEL_COLOR
        : hollow
          ? this.fillFor(arc, model)
          : readableOn(this.fillFor(arc, model));
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
    k: number,
    cull: ViewCull
  ): PlannedLabel[] {
    const plan: PlannedLabel[] = [];
    for (const geom of disk.labelGeom) {
      // The `measureText` this pass exists to spend is spent on what is on
      // screen, plus {@link LABEL_PLAN_MARGIN_PX} of slack so a modest pan is
      // label-complete before the camera settles. The plan is therefore
      // viewport-shaped — which is exactly what the replay above re-checks it
      // against, at the real (unexpanded) rect.
      if (!arcVisible(cull, geom.arc)) continue;
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
    // A `+N` fold arc is named by what it still stands for, which the legend
    // can change without the layout moving — everything else wears the name the
    // layout baked in.
    const text = this.labelTextFor(geom.arc);
    if (geom.tangential > geom.radial) {
      return this.planCurved(ctx, geom, text, k) ?? this.planRadial(ctx, geom, text, k);
    }
    return this.planRadial(ctx, geom, text, k) ?? this.planCurved(ctx, geom, text, k);
  }

  /**
   * Curved layout: the name follows the arc. `null` when the wedge is too
   * short or too thin for it, or when what fits is not a name any more.
   */
  private planCurved(
    ctx: CanvasRenderingContext2D,
    geom: ArcLabelGeom,
    text: string,
    k: number
  ): PlannedLabel | null {
    const thicknessPx = geom.radial * k;
    if (geom.tangential * k < LABEL_MIN_ARC_PX || thicknessPx < LABEL_MIN_THICKNESS_PX) return null;
    const fontPx = curvedFontPx(thicknessPx);
    const fitted = this.fitLabel(ctx, text, geom.tangential * 0.9 * k, fontPx, k);
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
    text: string,
    k: number
  ): PlannedLabel | null {
    const lengthPx = geom.radial * k;
    const heightPx = geom.tangential * k;
    if (lengthPx < RLABEL_MIN_LENGTH_PX || heightPx < RLABEL_MIN_HEIGHT_PX) return null;
    const fontPx = radialFontPx(heightPx);
    const fitted = this.fitLabel(ctx, text, geom.radial * 0.92 * k, fontPx, k);
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

  /**
   * An arc's BASE fill — before any alpha, emphasis or dimming.
   *
   * Memoised per `(colour mode, arc key)`, which is the whole of what it
   * depends on: an arc key is a node id (or `agg|…`), and the palette's answer
   * for a node under a mode is fixed for the lifetime of the model. Without the
   * cache this was a `model.get` plus a `colorForNode` per arc per frame, twice
   * over for a labelled one. Dropped whole when a new model arrives (that is
   * the one thing that can change a colour without changing the key) and when
   * it outgrows its cap; the mode is in the key, so switching modes needs
   * nothing.
   */
  private fillFor(arc: SunburstArc, model: GraphModel): string {
    const key = `${this.colorMode}|${arc.key}`;
    const cached = this.arcFills.get(key);
    if (cached !== undefined) return cached;
    const node = arc.nodeId ? model.get(arc.nodeId) : undefined;
    const fill = node ? colorForNode(node, this.colorMode, model.layers) : AGGREGATE_FILL;
    if (this.arcFills.size >= COLOR_CACHE_MAX * 4) this.arcFills.clear();
    this.arcFills.set(key, fill);
    return fill;
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
    // Two outcomes, two ghosts. The shape IS the promise: a rounded rectangle
    // the size the bubble will actually be, or the disk's own circle. ⌥ swaps
    // them mid-drag, so what the release does is never a surprise.
    if (drag.spawn === 'bubble') {
      this.drawBubbleGhost(ctx, drag);
      return;
    }
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

  /**
   * The bubble half of the ghost: the frame, where it will be, at exactly the
   * size it will READ at — the default box drawn through the frame scale
   * (B2.3), so a spawn at any zoom promises the box it is actually going to
   * produce rather than one that then changes size under the cursor.
   */
  private drawBubbleGhost(ctx: CanvasRenderingContext2D, drag: DragState): void {
    const frameScale = bubbleFrameScale(this.scale());
    // The same pure helper `spawnBubble` uses, off the same node: B3 sizes a
    // bubble to its code, so the ghost has to be sized to it too or the release
    // would produce a different box from the one the drag drew.
    const size = bubbleDefaultSize(this.bubbleLoc(drag.nodeId));
    const width = size.w * frameScale;
    const height = size.h * frameScale;
    const x = drag.x - width / 2;
    const y = drag.y - height / 2;
    const corner = Math.min(8, width / 2, height / 2);

    ctx.beginPath();
    ctx.roundRect(x, y, width, height, corner);
    ctx.fillStyle = GHOST_FILL;
    ctx.fill();
    ctx.strokeStyle = GHOST_STROKE;
    ctx.lineWidth = 1.4;
    ctx.setLineDash([5, 4]);
    ctx.stroke();
    ctx.setLineDash([]);

    // A hairline where the header will be, so the shape reads as a panel
    // rather than as a plain rectangle.
    const headerHeight = Math.min(20, height * 0.28);
    ctx.beginPath();
    ctx.moveTo(x, y + headerHeight);
    ctx.lineTo(x + width, y + headerHeight);
    ctx.stroke();

    ctx.font = '600 12px ui-sans-serif, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#dbe4f2';
    ctx.fillText(fitText(ctx, drag.label, width - 12), x + width / 2, y + headerHeight / 2);
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
      if (edge && this.enabledKinds.has(edge.kind) && !this.hasHiddenEndpoint(edge)) {
        wanted.set(key, edge);
      }
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
        // A `+N` wedge stands in for the nodes it folded — the ones it still
        // stands in for, i.e. minus whatever the legend switched off (item: a
        // hidden category is absent, and an absent node has no relations here).
        hoveredArc.nodeId ? [hoveredArc.nodeId] : this.visibleAggregated(hoveredArc),
        hoverEdges,
        directions,
        // A card with an edge set scopes the hover to that set; the Project
        // view, which has no edges of its own, leaves the hover unfiltered.
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
      else for (const id of this.visibleAggregated(hoveredArc)) nodes.add(id);
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
   * Does either end of this relation belong to a category the legend switched
   * off?
   *
   * A hidden wedge is not painted and the pointer goes straight through it, so
   * it cannot be the SUBJECT of a hover — but it could still turn up as the far
   * end of somebody else's rope, i.e. as a relation pointing at nothing
   * visible. It doesn't: a filtered-out node is absent from every edge display
   * (hover, selection, card, impact, cross-disk), on both sides.
   */
  private hasHiddenEndpoint(edge: ModelEdge): boolean {
    if (this.hiddenColorKeys.size === 0) return false;
    return this.isHiddenNode(edge.source) || this.isHiddenNode(edge.target);
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
    // An INVISIBLE wedge cannot stand in for anything: a rope that ended on one
    // would point at empty disk. Such an arc is skipped and the ladder carries
    // on — the endpoint attaches to the next visible ancestor, or to the centre.
    const direct = layout.byNode.get(nodeId);
    if (direct && !this.isHiddenArc(direct)) return { score: 4, arc: direct };
    const folded = layout.aggregatedInto.get(nodeId);
    if (folded && !this.isHiddenArc(folded)) return { score: 3, arc: folded };
    // The disk's own root has no arc — the centre circle IS its wedge.
    if (nodeId === disk.rootId) return { score: 3, arc: null };
    for (const ancestor of model.ancestors(nodeId)) {
      const arc = layout.byNode.get(ancestor);
      if (arc && !this.isHiddenArc(arc)) return { score: 2, arc };
      const aggregate = layout.aggregatedInto.get(ancestor);
      if (aggregate && !this.isHiddenArc(aggregate)) return { score: 2, arc: aggregate };
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
      if (this.isHiddenNode(id)) continue;
      for (const edge of model.edgesOf(id)) {
        if (into.size >= EDGE_BUDGET) return;
        if (!this.enabledKinds.has(edge.kind)) continue;
        if (edge.source === edge.target) continue;
        if (only && !only.has(edge.key)) continue;
        if (this.hasHiddenEndpoint(edge)) continue;
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
    // ⌥ flips what a drag-away spawns, and it has to flip WHILE the pointer is
    // held still — a pointer event would not arrive. Read-only and scoped to a
    // wedge drag: nothing here consumes a key the shell routes.
    window.addEventListener('keydown', this.onModifierChange);
    window.addEventListener('keyup', this.onModifierChange);
  }

  /** ⌥ went down or up during a wedge drag — re-decide what the release makes. */
  private readonly onModifierChange = (event: KeyboardEvent): void => {
    const drag = this.drag;
    if (!drag || drag.mode !== 'wedge' || !drag.nodeId) return;
    if (event.altKey === drag.alt) return;
    drag.alt = event.altKey;
    this.applySpawnKind(drag);
    this.requestDraw();
  };

  /**
   * Decide (again) what this wedge drag would spawn, and make sure the ghost
   * has what it needs to preview it.
   *
   * The disk ghost needs the prospective disk's real radius, which costs one
   * layout — computed the first time it is actually needed and then cached on
   * the drag, so flipping ⌥ back and forth is free and the drop itself is too.
   */
  private applySpawnKind(drag: DragState): void {
    if (!drag.nodeId) return;
    drag.spawn = this.spawnKindFor(drag.nodeId, drag.alt);
    if (drag.spawn === 'disk' && drag.outside && !drag.preview && this.model) {
      drag.preview = this.layoutFor(drag.nodeId);
    }
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
        // Camera only: the scene is unchanged, so the frame is the last one
        // shifted plus the strip the shift uncovered — see `drawGesture`. One
        // of exactly two sites that opt out of the dirty default.
        this.requestCameraDraw('pan');
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
          this.notifyWorkspace();
        }
        return;
      }
      if (drag.mode === 'wedge') {
        this.updateWedgeDrag(drag, position, event.altKey);
        return;
      }
      return;
    }
    if (this.disks.some((disk) => disk.transitionStart > 0)) return;
    // A hit test costs an angle-first search per disk plus a pass over every
    // rope, and a hover change rebuilds the edge set on top of that — both of
    // which would land in the middle of a wheel zoom, which has no drag to
    // suppress it the way a pan does. It is deferred to the settled frame
    // instead: the pointer has not moved, only what is under it, so answering
    // once at the end is the same answer for less work. (Kept through rounds
    // G5.2 and G5.3: the hit test the deferral skips is exactly the per-tick
    // work a wheel gesture cannot afford, whatever the frame is made of.)
    if (this.cameraSettling()) {
      this.pendingHover = position;
      // `scheduleFrame`, not `requestDraw`: parking a hover changes nothing on
      // screen, and dirtying the scene here would cancel the blit for every
      // pointer move a wheel zoom happens to sit under.
      this.scheduleFrame();
      return;
    }
    this.pendingHover = null;
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
  private updateWedgeDrag(drag: DragState, position: Point, alt: boolean): void {
    const disk = this.diskById(drag.diskId);
    if (!disk) return;
    const workspace = this.toWorkspace(position.x, position.y);
    const radius = disk.layout?.maxRadius ?? MAX_RADIUS;
    const distance = Math.hypot(workspace.x - disk.x, workspace.y - disk.y);
    const outside = distance > radius;
    drag.outside = outside;
    drag.alt = alt;
    // The kind is re-decided every move (⌥ may have changed) and the disk
    // ghost's one layout is computed the moment it is first needed — once, and
    // cached, so the drop itself is free.
    this.applySpawnKind(drag);
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
    // A hover the camera deferred is abandoned, not delivered late: a gesture
    // has started, and every drag suppresses the hover for its duration.
    this.pendingHover = null;

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
      alt: event.altKey,
      spawn: 'disk',
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
          this.applySpawnKind(this.drag);
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
        const at = this.toWorkspace(position.x, position.y);
        if (drag.spawn === 'bubble') {
          this.spawnBubble(drag.nodeId, at, drag.diskId);
        } else {
          this.spawnDisk(drag.nodeId, at, drag.diskId, drag.preview);
        }
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
    this.pendingHover = null;
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
      // At the floor (or the project root) the centre is not a button at all —
      // it carries no `▲` hint, and clicking it does nothing.
      const parent = this.upTarget(disk);
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
    // Camera only, exactly like a pan: the blit scales the last settled frame
    // about the point the gesture pinned, which is what (origin, scale) then vs
    // now says. The other of the two sites that opt out of the dirty default.
    this.requestCameraDraw('zoom');
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
    // A fold arc reports what it still folds under the legend's filters, so the
    // tooltip and the `+N` painted on the wedge can never disagree.
    const tooltip: ArcTooltip = {
      x,
      y,
      name: node?.name ?? this.labelTextFor(arc),
      path: node?.file ?? '',
      kind: node?.kind ?? AGGREGATE_KIND,
      loc: arc.weight,
      aggregate: !arc.nodeId,
      hiddenChildren: arc.nodeId ? arc.hiddenChildren : this.visibleAggregatedCount(arc),
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
  sourceDiskId: string | null = null,
  floorId: string | null = null
): DiskState {
  return {
    id,
    rootId,
    x,
    y,
    primary,
    source,
    sourceDiskId,
    floorId,
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

// --------------------------------------------------------- code bubbles ---

/**
 * A bubble's on-screen box, in CSS px. `x`/`y` is its top-left corner.
 *
 * A bubble is anchored to a WORLD point and sized in FRAME px — the numbers
 * the user dragged the corner to. This rect is those numbers as they are
 * DRAWN: `w`/`h` carry the frame scale (`min(camera, 1)`), so they are the
 * user's own px at camera 1 and above, and shrink with the world below it
 * (B2.2). Everything screen-space downstream — both tether families, the
 * click-to-open placement — is built from this one rect, so there is a single
 * place the scale enters.
 */
export interface BubbleRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * The largest the frame is ever LAID OUT at (B2.3).
 *
 * The layout scale exists to rasterise type at the size it is being read at,
 * and it costs a real layout and a layer the size of the laid-out box — so it
 * is capped rather than left to follow the camera forever. Four is generous
 * for what it buys: at camera 4 the type is rasterised at 4×, and past that
 * the glyphs on screen are already so large that upscaling a 4× raster is not
 * something the eye can find. The picture is unaffected either way — the cap
 * changes how sharp a bubble is at extreme zoom, never how big it is.
 */
export const BUBBLE_MAX_FONT_SCALE = 4;
/** Under this camera scale the body is replaced by a centred label (B2.1). */
export const BUBBLE_LABEL_BELOW = 0.5;
/**
 * Quantisation of the layout scale, in scale units.
 *
 * A layout-scale write re-lays every row of a body out, so it is rounded to 5%
 * steps: a camera walked across the whole range re-lays a bubble out about
 * sixty times rather than once per settle. It is also what keeps the DOM and
 * the arithmetic honest with each other — the same quantised number decides
 * the box the DOM is given and the divisor the root's transform carries, so
 * the two can never compose to anything but the camera's own scale.
 */
export const BUBBLE_FONT_SCALE_STEP = 0.05;
/** The frame's own 1px border, which the scrollport does not get to use. */
export const BUBBLE_FRAME_BORDER_PX = 1;
/**
 * Default and clamp range for the box the user drags out and resizes.
 *
 * B3 doubles the default WIDTH (B1's 380 was a column narrow enough that most
 * real code lines ran off the side of it, which is what the horizontal scroll
 * existed to paper over; lines wrap now, and a wider box is what makes a wrap
 * the exception rather than the rule) and derives the default HEIGHT from the
 * node's own line count — see {@link bubbleDefaultSize}.
 *
 * The HEIGHT floor came down with it. B1's 96 was a floor for a box that was
 * always 260 tall to begin with; a three-line function is now allowed to be a
 * three-line box, and a floor above that would inflate exactly the bubbles the
 * round exists to shrink. What is left is the smallest box that is still a
 * usable one: the header, and enough body under it to read a line in.
 */
export const BUBBLE_DEFAULT_WIDTH = 760;
export const BUBBLE_MIN_WIDTH = 200;
export const BUBBLE_MIN_HEIGHT = 56;
export const BUBBLE_MAX_WIDTH = 2000;
export const BUBBLE_MAX_HEIGHT = 1000;
/** Rows a spawned bubble shows: at least this many, at most that many (B3). */
export const BUBBLE_MIN_CONTENT_ROWS = 3;
export const BUBBLE_MAX_CONTENT_ROWS = 30;
/** Tether arms, mirroring the disk tether's own shape (`workspace.ts`). */
export const BUBBLE_TETHER_ARM_SHARE = 0.42;
export const BUBBLE_TETHER_MIN_ARM = 8;

/**
 * How a bubble reads at a given camera scale (B2.3 — it supersedes B2.2's cap
 * at camera 1, and with it the last of B2.1's fixed frame; B2.1 in turn
 * replaced B1's hybrid box scale and its title chip).
 *
 * **One regime, and it is the disks': a bubble is a WORLD object.** Its size
 * on screen is the size the user dragged it to times the camera's own scale,
 * at every zoom, in both directions:
 *
 * ```
 * s = camera.scale          // uncapped. There is no seam left to cross.
 * ```
 *
 * B2.2 capped that at 1 so a bubble stopped growing when you zoomed in, on the
 * argument that a box of text is not more useful for being enormous. Looking
 * at it settled the question the other way: a workspace where everything else
 * grows and one kind of object does not is a workspace with two zooms in it,
 * and the eye finds the exception immediately. So the cap is gone, and the
 * whole model is the one line above.
 *
 * The frame scale is applied as a transform on the bubble's root, so nothing
 * inside it reflows and its content geometry relative to the frame is constant
 * at every zoom. That leaves one real problem, which the SECOND number here
 * solves: a composited transform upscales a raster taken at the old scale, so
 * at camera 3 the type would be legible in shape and soft in fact. The frame
 * is therefore also LAID OUT larger — every length in it multiplied by
 * `fontScale` — and the root's transform divided by exactly the same number:
 *
 * ```
 * on-screen size = (frame px × fontScale) × (s / fontScale) = frame px × s
 * ```
 *
 * so the layout scale is invisible in the picture and decides only how sharp
 * it is. It is quantised ({@link BUBBLE_FONT_SCALE_STEP}), capped
 * ({@link BUBBLE_MAX_FONT_SCALE}), pinned at 1 at and below camera 1 (a
 * downscaled raster is sharp already, and a re-layout there would buy
 * nothing), and — because a re-layout is real work — it is applied only when
 * the camera SETTLES. During a gesture the transform alone does the zooming,
 * which is exactly what B2.2 did over its whole range.
 *
 * Continuity is now trivial rather than argued: the composed frame size is
 * `frame px × camera`, which is continuous and monotone everywhere, and there
 * is no longer a boundary at camera 1 for anything to pop at. The one
 * threshold left is {@link BUBBLE_LABEL_BELOW}, where only the FACE changes:
 * below it no type in the frame is readable, so the body is replaced by the
 * node's NAME, KIND and LoC, counter-scaled against the root's transform so it
 * reads at a fixed screen size while the frame keeps shrinking underneath it.
 *
 * Pure and total, so the same camera scale always produces exactly the same
 * answer and the DOM, the canvas and the anchor maths read ONE number for each
 * of the two scales.
 */
export interface BubblePresentation {
  /** What the camera draws the whole FRAME at — the camera's own scale. */
  frameScale: number;
  /** What the frame is LAID OUT at. Invisible in the picture; it buys sharpness. */
  fontScale: number;
  /** Below the readability threshold: centred label instead of source. */
  label: boolean;
}

/**
 * The scale the whole frame is drawn at — the camera's own (B2.3).
 *
 * A bubble zooms with the world in both directions, exactly as a disk does.
 * This is the single source of truth for that number: the DOM transform, the
 * screen rect the tethers are built from, the resize conversion, the spawn and
 * the ghost all read it here, so they cannot disagree.
 *
 * The fallback is 1 rather than 0 for anything that is not a usable scale: a
 * frame drawn at nothing is invisible, and every consumer downstream divides
 * by this at least once.
 */
export function bubbleFrameScale(cameraScale: number): number {
  if (!Number.isFinite(cameraScale) || !(cameraScale > 0)) return 1;
  return cameraScale;
}

/**
 * The scale the frame is LAID OUT at, for a settled camera (B2.3).
 *
 * `min(max(camera, 1), 4)`, quantised. At and below camera 1 it is 1: the
 * transform is downscaling there, which is sharp by construction, and a
 * re-layout would be work with nothing to show for it. Above it the layout
 * follows the camera up to the cap, so type is rasterised at the size it is
 * being read at.
 *
 * It changes nothing about where anything is — {@link bubbleRootScale} divides
 * it straight back out — which is what makes it safe to apply only on a
 * settled camera and to cap wherever the sharpness stops being worth a layout.
 */
export function bubbleFontScale(cameraScale: number): number {
  if (!Number.isFinite(cameraScale)) return 1;
  const clamped = Math.min(Math.max(cameraScale, 1), BUBBLE_MAX_FONT_SCALE);
  const stepped = Math.round(clamped / BUBBLE_FONT_SCALE_STEP) * BUBBLE_FONT_SCALE_STEP;
  return Math.min(BUBBLE_MAX_FONT_SCALE, Math.max(1, stepped));
}

/**
 * What the root's CSS transform scales by: the frame scale with the layout
 * scale divided back out (B2.3).
 *
 * The two always multiply back to the frame scale, which is the invariant the
 * whole round rests on — the composed picture is the camera's, and how the
 * work is split between a layout and a transform is a rasterisation detail
 * that no geometry anywhere is allowed to depend on.
 */
export function bubbleRootScale(frameScale: number, fontScale: number): number {
  const frame = Number.isFinite(frameScale) && frameScale > 0 ? frameScale : 1;
  const font = Number.isFinite(fontScale) && fontScale > 0 ? fontScale : 1;
  return frame / font;
}

/** Is the camera far enough out that no type in the frame is worth reading? */
export function bubbleIsLabel(cameraScale: number): boolean {
  return Number.isFinite(cameraScale) && cameraScale < BUBBLE_LABEL_BELOW;
}

/** The three numbers a frame needs, from one camera scale, in one place. */
export function bubblePresentation(cameraScale: number): BubblePresentation {
  return {
    frameScale: bubbleFrameScale(cameraScale),
    fontScale: bubbleFontScale(cameraScale),
    label: bubbleIsLabel(cameraScale),
  };
}

/**
 * The box a bubble is BORN in — as tall as the code it is about to show (B3).
 *
 * B1 spawned every bubble at one fixed size, which was wrong in both
 * directions at once: a three-line accessor got a box with twenty lines of
 * empty space under it, and a thousand-line file got the same box as the
 * accessor. Neither is a size anybody would have dragged. So the height is
 * derived from the node's own line count, clamped to a window that keeps both
 * ends honest — {@link BUBBLE_MIN_CONTENT_ROWS} so a one-line constant still
 * has a body to be read in, {@link BUBBLE_MAX_CONTENT_ROWS} so a long file
 * opens as a readable window onto itself rather than as a wall the workspace
 * disappears behind. Everything past that is a scroll, which is what the body
 * is for.
 *
 * Built from the same fallback metrics the anchor arithmetic falls back to
 * ({@link BUBBLE_METRICS_FALLBACK} — the CSS in `bubble-view.ts`, which is
 * what the frame will actually be laid out at) plus the frame's own two
 * borders, so the first paint fits its rows exactly rather than approximately.
 * A line count that is missing or nonsense reads as the minimum: a box is
 * always a NUMBER.
 *
 * Pure, so the ghost drawn under the cursor and the bubble the release
 * produces are the same rectangle by construction.
 */
export function bubbleDefaultSize(lineCount: number): { w: number; h: number } {
  const lines = Number.isFinite(lineCount) ? Math.floor(lineCount) : 0;
  const rows = Math.min(BUBBLE_MAX_CONTENT_ROWS, Math.max(BUBBLE_MIN_CONTENT_ROWS, lines));
  const metrics = BUBBLE_METRICS_FALLBACK;
  const height =
    metrics.headerHeight +
    metrics.padTop +
    rows * metrics.lineHeight +
    metrics.padBottom +
    BUBBLE_FRAME_BORDER_PX * 2;
  return clampBubbleSize(BUBBLE_DEFAULT_WIDTH, height);
}

/**
 * A user-dragged size, held inside the range a bubble is still usable in.
 *
 * Plainly CSS px, at every zoom — which is what the fixed frame buys: the
 * number the grip produces, the number that is stored, and the number of
 * pixels on screen are all the same number.
 */
export function clampBubbleSize(width: number, height: number): { w: number; h: number } {
  const w = Number.isFinite(width) ? width : BUBBLE_DEFAULT_WIDTH;
  const h = Number.isFinite(height) ? height : bubbleDefaultSize(0).h;
  return {
    w: Math.min(BUBBLE_MAX_WIDTH, Math.max(BUBBLE_MIN_WIDTH, w)),
    h: Math.min(BUBBLE_MAX_HEIGHT, Math.max(BUBBLE_MIN_HEIGHT, h)),
  };
}

/** Everything {@link bubbleScrollForFontScale} needs. All FRAME px except the scales. */
export interface BubbleScrollAnchorInput {
  /** The scrollport's offset now, in FRAME px. */
  scrollTop: number;
  /** Height of the scrolling body — the frame's height less its header. */
  viewportHeight: number;
  /** Padding above the first row and below the last. */
  padTop: number;
  padBottom: number;
  /** One VISUAL row, in frame px. */
  lineHeight: number;
  lineCount: number;
  /**
   * The scrolling content's measured height, in frame px (B3).
   *
   * Optional: without it the height is `padTop + lines × lineHeight +
   * padBottom`, which is exact for a body in which nothing wrapped and a floor
   * for one in which something did.
   */
  contentHeight?: number;
  /** Layout scale the body is laid out at now, and the one it is going to. */
  fromScale: number;
  toScale: number;
}

/**
 * Where the body must be scrolled to after a layout-scale change — the
 * **centre-line rule** (B2.1's rule, restated for B2.3's uniformly scaled
 * frame).
 *
 * A frame that is re-laid out has to decide what stays still, and the only
 * choice that survives zooming both ways is the line the eye is already on.
 * So: **the content point at the frame's vertical centre is preserved.**
 * Express that point as a fractional line index over the LAYOUT px the DOM
 * actually holds — `u = (scrollTop + viewportHeight / 2 − padTop) / lineHeight`,
 * every term at `fromScale` — and put the same `u` back at the centre of a
 * viewport laid out at `toScale`.
 *
 * What is new in B2.3, and the whole point of it: the re-layout scales the
 * padding and the viewport by the same factor as the rows, because the FRAME
 * scales, not just the type inside it. Work the algebra through and the answer
 * collapses to the offset it started from — expressed in frame px, the reading
 * position does not move at all, and the reading position ON SCREEN moves by
 * exactly nothing, since the root's transform gives back what the layout took.
 * B2.1 had to compute a real re-projection here because its frame stayed the
 * same size while its type did not; this one is free. The rule is still
 * written out rather than replaced by the identity, because the identity is
 * the RESULT and the rule is the reason — and because the mutation that gets
 * this wrong (B2.1's rule applied to a frame that also scaled) is exactly the
 * one this function exists to rule out.
 *
 * Deterministic and total. The result is clamped to the range the browser
 * itself would clamp to — a range that scales with the frame, so it is the
 * same range in frame px at every layout scale — which means the one case the
 * rule cannot honour, content too short to put `u` in the middle, ends at the
 * edge rather than at a lie.
 */
export function bubbleScrollForFontScale(input: BubbleScrollAnchorInput): number {
  const viewport = Math.max(0, finiteOr(input.viewportHeight, 0));
  const padTop = Math.max(0, finiteOr(input.padTop, 0));
  const padBottom = Math.max(0, finiteOr(input.padBottom, 0));
  const lineHeight = Math.max(0, finiteOr(input.lineHeight, 0));
  const count = Math.max(0, Math.floor(finiteOr(input.lineCount, 0)));
  const from = Math.max(1e-6, finiteOr(input.fromScale, 1));
  const to = Math.max(1e-6, finiteOr(input.toScale, 1));
  const scrollTop = Math.max(0, finiteOr(input.scrollTop, 0));
  // In frame px, and therefore the same at either scale: content and viewport
  // are laid out through the same factor.
  const content = finiteOr(input.contentHeight, Number.NaN);
  const height = content > 0 ? content : padTop + count * lineHeight + padBottom;
  const limit = Math.max(0, height - viewport);
  // Nothing to anchor to: there are no rows, or they have no height. The
  // offset survives, clamped — a body with no lines has nowhere else to be.
  if (!(lineHeight > 0) || count === 0) return Math.min(scrollTop, limit);
  // Layout px at `from`: what the DOM holds now.
  const centre = (scrollTop + viewport / 2) * from;
  const u = (centre - padTop * from) / (lineHeight * from);
  // Layout px at `to`, then back into the frame px everything outside is in.
  const next = (padTop * to + u * lineHeight * to - (viewport * to) / 2) / to;
  return Math.min(Math.max(0, next), limit);
}

/** A bubble's tether, in the same shape `workspace.ts` gives a disk's. */
export interface BubbleTether {
  start: Point;
  control1: Point;
  control2: Point;
  end: Point;
}

/**
 * The rectangle a bubble PAINTS, from the two rectangles it is made of (B3.1).
 *
 * A bubble's frame is drawn at `frame px × camera` (B2.3), and below the label
 * threshold its label is drawn at a fixed size on screen — the counter-scale
 * hands back exactly the factor the root's transform took. So the two disagree
 * about how big a zoomed-out bubble is, by the whole of the camera's scale, and
 * the one the eye answers with is the LARGER: the label is what a bubble looks
 * like down there, and the frame is a speck somewhere inside it.
 *
 * They are concentric — the label is centred on the frame it names — so their
 * union is exactly the per-axis maximum, and the answer keeps the frame's own
 * centre whatever happens. `face = null`, or a face no bigger than the frame,
 * returns the frame itself: above the threshold there is nothing else painted,
 * which is why every screen-space consumer can be built from this one function
 * without a second code path for the zoomed-out case.
 *
 * `face.w` / `face.h` are SCREEN px, like the rect. Total: a non-finite input
 * is dropped rather than propagated, because a NaN here would blank a frame.
 */
export function bubblePaintedRect(
  rect: BubbleRect,
  face: { w: number; h: number } | null
): BubbleRect {
  const x = finiteOr(rect.x, 0);
  const y = finiteOr(rect.y, 0);
  const w = Math.max(0, finiteOr(rect.w, 0));
  const h = Math.max(0, finiteOr(rect.h, 0));
  const centreX = x + w / 2;
  const centreY = y + h / 2;
  const width = Math.max(w, Math.max(0, finiteOr(face?.w, 0)));
  const height = Math.max(h, Math.max(0, finiteOr(face?.h, 0)));
  // The frame itself, to the bit, when nothing else is painted: re-deriving a
  // corner from a centre is not exact in floating point, and "above the
  // threshold this is the frame" should be an identity rather than an
  // approximation of one.
  if (width === w && height === h) return { x, y, w, h };
  return { x: centreX - width / 2, y: centreY - height / 2, w: width, h: height };
}

/**
 * The cubic from a bubble's edge to the wedge it was dragged out of.
 *
 * Everything is in SCREEN px, because a bubble is: its frame is a fixed size
 * in CSS px that the camera only ever moves, so there is no world rectangle to
 * anchor against — `rect` is the bubble as it is PAINTED on screen this frame.
 * Which face that is comes from {@link bubblePaintedRect}, not from here: B1
 * could hand this the frame either way, since its chip occupied exactly the
 * frame's rectangle, but a counter-scaled label (B2.1) does not, and a tether
 * built from the frame under one ends in the middle of what the user sees.
 *
 * It leaves the bubble along the line from the bubble's CENTRE to the wedge —
 * so the curve reads as coming out of the box rather than off a corner — and
 * arrives RADIALLY at the wedge (`wedgeOut` is the wedge's outward direction,
 * i.e. its mid angle), which is the same convention the disk tether uses.
 *
 * `null` — draw nothing — when the wedge is inside the bubble, when the two
 * coincide, or when any input is not a number. Same refusal as `tetherCurve`:
 * a line that points the wrong way is worse than no line.
 */
export function bubbleTetherAnchor(
  rect: BubbleRect,
  wedge: Point,
  wedgeOut: Point
): BubbleTether | null {
  const hw = rect.w / 2;
  const hh = rect.h / 2;
  if (!(hw > 0) || !(hh > 0)) return null;
  const cx = rect.x + hw;
  const cy = rect.y + hh;
  if (!Number.isFinite(cx) || !Number.isFinite(cy)) return null;
  if (!Number.isFinite(wedge.x) || !Number.isFinite(wedge.y)) return null;

  const dx = wedge.x - cx;
  const dy = wedge.y - cy;
  // Inside the box: there is no edge point between the two, so nothing honest
  // to draw — the bubble is already sitting on top of its own origin.
  if (Math.abs(dx) <= hw && Math.abs(dy) <= hh) return null;
  const distance = Math.hypot(dx, dy);
  if (!(distance > 1e-9)) return null;
  const ux = dx / distance;
  const uy = dy / distance;

  // The ray's first crossing of the box: whichever axis it leaves through
  // first. One of the two coordinates lands exactly on the border by
  // construction, and neither can exceed it.
  const tx = Math.abs(ux) > 1e-12 ? hw / Math.abs(ux) : Infinity;
  const ty = Math.abs(uy) > 1e-12 ? hh / Math.abs(uy) : Infinity;
  const t = Math.min(tx, ty);
  if (!Number.isFinite(t)) return null;
  const start = { x: cx + ux * t, y: cy + uy * t };

  const gap = Math.hypot(wedge.x - start.x, wedge.y - start.y);
  if (!(gap > 1e-9)) return null;
  const arm = Math.min(Math.max(BUBBLE_TETHER_MIN_ARM, gap * BUBBLE_TETHER_ARM_SHARE), gap / 2);

  const outLength = Math.hypot(wedgeOut.x, wedgeOut.y);
  // A wedge with no honest outward direction (the centre of a disk) still gets
  // a symmetric curve: it arrives back along the line it left on.
  const ox = outLength > 1e-9 ? wedgeOut.x / outLength : -ux;
  const oy = outLength > 1e-9 ? wedgeOut.y / outLength : -uy;

  return {
    start,
    control1: { x: start.x + ux * arm, y: start.y + uy * arm },
    control2: { x: wedge.x + ox * arm, y: wedge.y + oy * arm },
    end: { x: wedge.x, y: wedge.y },
  };
}

// --------------------------------------------- code bubbles: call tracing ---

/**
 * The vertical middle of one displayed line, from a measured edge table.
 *
 * `NaN` for anything the table cannot answer, so the caller falls back to the
 * unwrapped arithmetic rather than anchoring a thread at nothing.
 */
export function bubbleRowCentre(edges: readonly number[], index: number): number {
  if (index < 0 || index + 1 >= edges.length) return Number.NaN;
  const top = edges[index];
  const bottom = edges[index + 1];
  if (typeof top !== 'number' || typeof bottom !== 'number') return Number.NaN;
  if (!Number.isFinite(top) || !Number.isFinite(bottom)) return Number.NaN;
  // A table that is not monotonic is a table that was measured mid-relayout.
  return bottom >= top ? (top + bottom) / 2 : Number.NaN;
}

/** A finite number, or the fallback — every input below one of these comes from the DOM. */
function finiteOr(value: number | undefined | null, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/**
 * A bubble body's geometry in FRAME px, as the anchor maths needs it.
 *
 * Measured from the DOM once per content load and cached: a frame must never
 * ask the layout where a line is, or a canvas of bubbles would pay a forced
 * reflow per tether per frame.
 */
export interface BubbleBodyMetrics {
  /** The header row. */
  headerHeight: number;
  /** Padding above the first row and below the last. */
  padTop: number;
  padBottom: number;
  /**
   * One VISUAL row, top to top — the same number of frame px at every zoom.
   *
   * Since B3 a logical line can be several of these, so this is the fallback
   * unit rather than the answer: it is what the arithmetic uses when there are
   * no measured offsets (a body that has not been measured yet, or a frame
   * showing its label), and what the default box's height is built from.
   */
  lineHeight: number;
  /**
   * Where each displayed line actually STARTS, in frame px from the top of the
   * scrolling content — `lineCount + 1` entries, the last being the bottom of
   * the last row (B3).
   *
   * Measured by the view (a grid row per logical line) and passed through as
   * DATA, which is what keeps the anchor below pure while wrapping makes
   * "line N is at padTop + N × lineHeight" false. Absent — or the wrong length
   * — falls back to exactly that arithmetic, which is still correct for every
   * line that did not wrap and is the only thing available before a measure.
   */
  rowEdges?: readonly number[];
  /** Padding, rows and padding together, in frame px. Absent → derived. */
  contentHeight?: number;
}

/**
 * What a bubble reads at before it has ever been measured — the CSS in
 * `bubble-view.ts` (11px text at 1.55, a 4px-padded header whose tallest child
 * is a 16px button, over a 1px rule, and 6px of padding above the first row
 * and below the last). Used for the frame or two between a spawn and its
 * content, so an anchor is always a NUMBER — and, since B3, as the arithmetic
 * {@link bubbleDefaultSize} builds a new bubble's box out of, which is why the
 * header's number is the sum of the CSS rather than a round one near it.
 */
export const BUBBLE_METRICS_FALLBACK: BubbleBodyMetrics = {
  headerHeight: 25,
  padTop: 6,
  padBottom: 6,
  lineHeight: 17.05,
};

export type BubbleAnchorMode = 'line' | 'clamped' | 'header' | 'centered';

/** Everything the caller-side anchor depends on. All screen px except `metrics`/`scrollTop`. */
export interface BubbleCallAnchorInput {
  /** The bubble's frame as it sits on screen this frame — already scaled. */
  rect: BubbleRect;
  /** Below the readability threshold: a centred label, so there is no line to point at. */
  label: boolean;
  /**
   * What the whole frame is drawn at — the camera's own scale (B2.3).
   *
   * `rect` already carries it, but the CONTENT offsets below are in frame px
   * and have to cross the same factor to become screen px — so it is an input
   * rather than something inferred from a width whose unscaled value this
   * function never sees. It is the COMPOSED scale: how the DOM splits it
   * between a layout and a transform is not a thing this function can see, or
   * would be allowed to care about if it could.
   */
  frameScale: number;
  metrics: BubbleBodyMetrics;
  /** Real file line of the first displayed row. */
  firstLine: number;
  /** Rows displayed — 0 while the fetch is in flight. */
  lineCount: number;
  /**
   * The body's scroll offset, in FRAME px.
   *
   * One unit for the whole system: the view normalises what the DOM reports
   * out of layout px on the way through, so what is stored, what is persisted
   * and what this arithmetic subtracts are one number, whatever the frame
   * happens to be laid out at.
   */
  scrollTop: number;
  /** The call-site line, or `null` when the edge does not carry one. */
  line: number | null;
  /** Screen x of the other end: the tether leaves by the border facing it. */
  towardX: number;
}

export interface BubbleCallAnchorPoint {
  x: number;
  y: number;
  side: 'left' | 'right';
  /** The line is not where the anchor is: scrolled away, or outside the range. */
  clamped: boolean;
  mode: BubbleAnchorMode;
}

/**
 * Where a call tether leaves its CALLER — the exact call-site line (phase B2).
 *
 * This is the whole of what makes a bubble-to-bubble tether say something a
 * box-to-box line cannot: it leaves the line that makes the call, so scrolling
 * the body walks the thread up and down the code. Four regimes, and each is a
 * different honest answer rather than a degenerate case of the first:
 *
 *  - **`line`** — the row is displayed and on screen: the anchor is its middle,
 *    on the border facing the callee.
 *  - **`clamped`** — the row exists but is scrolled out of view, or lies
 *    outside the displayed range altogether: the anchor slides to the content's
 *    top or bottom edge and says so, so the caller can draw it as "up there" /
 *    "down there" instead of pretending to point at a line that is not there.
 *  - **`header`** — the edge carries no line at all (some resolvers do not
 *    record one): the thread hangs off the header, which claims the BUBBLE and
 *    not a position in it.
 *  - **`centered`** — below the readability threshold the frame holds a
 *    centred label instead of source (B2.1, where B1 had a chip): there is no
 *    row to point at, so the anchor is the frame's own middle and nothing
 *    pretends otherwise.
 *
 * The camera enters in exactly two ways and no others. It MOVES the frame —
 * translate `rect` and the anchor translates with it, exactly, at any scale —
 * and it SCALES the frame (`frameScale`, B2.3: the camera's own scale, in both
 * directions), which multiplies every content offset inside the box, because
 * the box's own contents are drawn at that same scale. Position and scale are
 * separate: at a fixed `frameScale`, panning the camera still translates this
 * answer rigidly. The frame's LAYOUT scale is deliberately not an input — it
 * cancels against the root's transform, so an anchor that could see it would
 * be an anchor that could disagree with the picture.
 *
 * Pure and total: every branch returns finite numbers for any input, because a
 * NaN here would silently poison a bezier and blank a frame.
 */
export function bubbleCallAnchor(input: BubbleCallAnchorInput): BubbleCallAnchorPoint {
  const x = finiteOr(input.rect.x, 0);
  const y = finiteOr(input.rect.y, 0);
  const w = Math.max(0, finiteOr(input.rect.w, 0));
  const h = Math.max(0, finiteOr(input.rect.h, 0));
  const centreX = x + w / 2;
  const side: 'left' | 'right' = finiteOr(input.towardX, centreX) >= centreX ? 'right' : 'left';
  const bx = side === 'right' ? x + w : x;

  if (input.label) return { x: bx, y: y + h / 2, side, clamped: false, mode: 'centered' };

  // The frame's own scale: every frame-px quantity below becomes screen px by
  // crossing it exactly once. At 1 — camera 1 — the whole of the arithmetic
  // reduces to B2.1's, term for term, and at any `s` at or below 1 it is
  // B2.2's term for term.
  const frameScale = Math.max(0, finiteOr(input.frameScale, 1));
  const headerHeight = Math.max(
    0,
    finiteOr(input.metrics?.headerHeight, BUBBLE_METRICS_FALLBACK.headerHeight)
  );
  const padTop = Math.max(0, finiteOr(input.metrics?.padTop, BUBBLE_METRICS_FALLBACK.padTop));
  const lineHeight = Math.max(
    1e-6,
    finiteOr(input.metrics?.lineHeight, BUBBLE_METRICS_FALLBACK.lineHeight)
  );

  // The header is part of the frame, so it takes the frame's scale.
  const header = Math.min(headerHeight * frameScale, h);
  const top = y + header;
  const bottom = y + h;
  const count = Math.max(0, Math.floor(finiteOr(input.lineCount, 0)));
  const line = input.line;

  if (line === null || !Number.isFinite(line) || count === 0 || !(bottom > top)) {
    return { x: bx, y: y + header / 2, side, clamped: false, mode: 'header' };
  }

  const first = Math.floor(finiteOr(input.firstLine, 1));
  const last = first + count - 1;
  if (line < first || line > last) {
    return { x: bx, y: line < first ? top : bottom, side, clamped: true, mode: 'clamped' };
  }

  // Content space is FRAME space — `scrollTop`, `padTop` and the row height are
  // all frame px of a body whose proportions do not change with the zoom — and
  // the frame is drawn at `frameScale`, so the whole offset crosses it once,
  // as a unit.
  //
  // WHERE the line is comes from the body's measured row offsets when there
  // are any (B3: a wrapped line is several visual rows tall, so its top is not
  // its index times a row height) and from that arithmetic when there are not.
  // The two agree exactly for a body in which nothing wrapped, which is what
  // makes the fallback a fallback rather than a different answer.
  const scrollTop = Math.max(0, finiteOr(input.scrollTop, 0));
  const index = line - first;
  const edges = input.metrics?.rowEdges;
  const measured =
    edges && edges.length >= count + 1 ? bubbleRowCentre(edges, index) : Number.NaN;
  const centre = Number.isFinite(measured)
    ? measured
    : padTop + index * lineHeight + lineHeight / 2;
  const offset = (centre - scrollTop) * frameScale;
  const candidate = top + offset;
  if (candidate < top) return { x: bx, y: top, side, clamped: true, mode: 'clamped' };
  if (candidate > bottom) return { x: bx, y: bottom, side, clamped: true, mode: 'clamped' };
  return { x: bx, y: candidate, side, clamped: false, mode: 'line' };
}

/** The shape of a graph edge this mapping cares about. */
export interface BubbleCallSiteEdge {
  source: string;
  target: string;
  kind: string;
  line?: number;
}

/** A node's own extent, as the containment rule reads it. */
export interface BubbleCallSiteSpan {
  file: string;
  startLine: number;
  endLine: number;
}

/** The bubble the mapping is for: its node, its file, and what it displays. */
export interface BubbleCallSiteScope {
  ownerId: string;
  file: string;
  firstLine: number;
  lastLine: number;
}

/**
 * Does `id`'s own source live inside what this bubble displays?
 *
 * The containment rule of {@link mapBubbleCallSites}, exported on its own
 * because the call TETHERS need exactly the same answer for the same reason —
 * the two must never disagree about which edges a bubble owns.
 */
export function bubbleCallSiteInScope(
  spans: ReadonlyMap<string, BubbleCallSiteSpan>,
  scope: BubbleCallSiteScope,
  id: string
): boolean {
  if (id === scope.ownerId) return true;
  const span = spans.get(id);
  if (!span || span.file !== scope.file) return false;
  const first = Math.floor(finiteOr(scope.firstLine, 1));
  const last = Math.floor(finiteOr(scope.lastLine, 0));
  return (
    Number.isFinite(span.startLine) &&
    Number.isFinite(span.endLine) &&
    span.endLine >= span.startLine &&
    span.startLine >= first &&
    span.endLine <= last
  );
}

/**
 * Displayed line → the callees called on it (phase B2).
 *
 * Built ONCE per content load or expand, never per frame — it is the gutter's
 * marker plan and it changes only when the text does.
 *
 * The containment rule is what makes an expanded FILE bubble work. A file
 * bubble displays many symbols, and the outgoing calls belong to those symbols,
 * not to the file node: an edge therefore counts when its source is the
 * bubble's own node, **or** a node whose file is this file and whose whole span
 * falls inside the displayed range. Partial overlap is deliberately excluded —
 * a symbol half of which is off the top is a symbol whose call sites this
 * bubble cannot honestly claim to be showing.
 *
 * Only `calls` edges: the gutter marker means "this line calls that", and a
 * marker that sometimes meant "this line mentions that" would make the whole
 * column untrustworthy. Callees are deduped per line, first seen first.
 */
export function mapBubbleCallSites(
  edges: readonly BubbleCallSiteEdge[],
  spans: ReadonlyMap<string, BubbleCallSiteSpan>,
  scope: BubbleCallSiteScope
): Map<number, string[]> {
  const out = new Map<number, string[]>();
  const first = Math.floor(finiteOr(scope.firstLine, 1));
  const last = Math.floor(finiteOr(scope.lastLine, 0));
  if (!(last >= first)) return out;

  const decided = new Map<string, boolean>();
  const inScope = (id: string): boolean => {
    const cached = decided.get(id);
    if (cached !== undefined) return cached;
    const ok = bubbleCallSiteInScope(spans, scope, id);
    decided.set(id, ok);
    return ok;
  };

  for (const edge of edges) {
    if (edge.kind !== 'calls') continue;
    if (edge.line === undefined || !Number.isFinite(edge.line)) continue;
    const at = Math.floor(edge.line);
    if (at < first || at > last) continue;
    if (!inScope(edge.source)) continue;
    const list = out.get(at);
    if (!list) out.set(at, [edge.target]);
    else if (!list.includes(edge.target)) list.push(edge.target);
  }
  return out;
}

// ------------------------------------------------------------------ blit ---

/**
 * The part of the viewport a blit does NOT cover, as disjoint device-px rects.
 *
 * Plain rectangle subtraction, written so the answer is a TILING rather than a
 * cover: `dest ∩ viewport` plus everything returned here is the viewport
 * exactly, with no rect overlapping another. That is the whole correctness
 * argument for the incremental blit — every pixel on screen this frame was
 * either stamped from the snapshot or painted live, and none was painted twice.
 * When `dest` misses the viewport entirely the answer is the viewport itself,
 * which degenerates the gesture frame into a full one without a special case.
 *
 * `bleed` grows the covered rect's assumed edges INWARD, so the returned rects
 * overlap the blit by that much. It is 0 for a pan, whose rects land on whole
 * device pixels and abut exactly; a zoom lands on fractional ones, where an
 * exactly-abutting clip can leave a hairline of stale pixels.
 */
export function exposedRegion(dest: BlitRect, vw: number, vh: number, bleed = 0): BlitRect[] {
  if (vw <= 0 || vh <= 0) return [];
  const whole: BlitRect[] = [{ x: 0, y: 0, w: vw, h: vh }];
  const ix0 = Math.max(0, dest.x) + bleed;
  const iy0 = Math.max(0, dest.y) + bleed;
  const ix1 = Math.min(vw, dest.x + dest.w) - bleed;
  const iy1 = Math.min(vh, dest.y + dest.h) - bleed;
  if (!(ix1 > ix0 && iy1 > iy0)) return whole;

  const out: BlitRect[] = [];
  if (iy0 > 0) out.push({ x: 0, y: 0, w: vw, h: iy0 });
  if (iy1 < vh) out.push({ x: 0, y: iy1, w: vw, h: vh - iy1 });
  if (ix0 > 0) out.push({ x: 0, y: iy0, w: ix0, h: iy1 - iy0 });
  if (ix1 < vw) out.push({ x: ix1, y: iy0, w: vw - ix1, h: iy1 - iy0 });
  return out;
}

/**
 * How a gesture frame reuses `snapshot` under the camera `(originX, originY,
 * scale)` — or `null` when it cannot, and the frame must be drawn in full.
 *
 * Two shapes, told apart by the scale ratio alone (not by which gesture is in
 * flight — a pan drag that starts before a wheel zoom has settled is still
 * looking at a snapshot taken at another scale, and must scale it):
 *
 *  - **pan** — the ratio is 1, so the snapshot only moves. The offset is
 *    rounded to whole DEVICE px and the camera returned is the rounded one, so
 *    the strips are painted under exactly the camera the blitted pixels show
 *    and the caller's re-capture stores that same camera. The next frame's
 *    offset is therefore measured against what is really on screen: the error
 *    against the true camera is at most half a device px on each axis and
 *    CANNOT accumulate, however long the drag runs. A pan of a whole viewport
 *    or more in one frame reuses nothing and is refused.
 *  - **zoom** — the snapshot is scaled about the point the wheel pinned, which
 *    falls straight out of the two cameras: `new = newOrigin + (old − oldOrigin)
 *    × ratio`. It resamples, so it is soft until the settle window repaints it,
 *    and past {@link ZOOM_BLIT_MAX_RATIO} either way it is refused — a snapshot
 *    stretched three times over has stopped being the picture.
 */
export function planGestureBlit(
  snapshot: SnapshotCamera,
  originX: number,
  originY: number,
  scale: number
): GestureBlit | null {
  const ratio = snapshot.ratio;
  const vw = Math.round(snapshot.width * ratio);
  const vh = Math.round(snapshot.height * ratio);
  if (!(vw > 0 && vh > 0) || !Number.isFinite(ratio) || ratio <= 0) return null;
  const factor = scale / snapshot.scale;
  if (!Number.isFinite(factor) || factor <= 0) return null;

  if (Math.abs(factor - 1) <= 1e-9) {
    const dx = Math.round((originX - snapshot.originX) * ratio);
    const dy = Math.round((originY - snapshot.originY) * ratio);
    if (Math.abs(dx) >= vw || Math.abs(dy) >= vh) return null;
    const dest: BlitRect = { x: dx, y: dy, w: vw, h: vh };
    return {
      kind: 'pan',
      dest,
      exposed: exposedRegion(dest, vw, vh),
      originX: snapshot.originX + dx / ratio,
      originY: snapshot.originY + dy / ratio,
    };
  }

  if (factor > ZOOM_BLIT_MAX_RATIO || factor < 1 / ZOOM_BLIT_MAX_RATIO) return null;
  const dest: BlitRect = {
    x: (originX - snapshot.originX * factor) * ratio,
    y: (originY - snapshot.originY * factor) * ratio,
    w: vw * factor,
    h: vh * factor,
  };
  return {
    kind: 'zoom',
    dest,
    exposed: exposedRegion(dest, vw, vh, ZOOM_BLIT_BLEED_PX),
    originX,
    originY,
  };
}

// ---------------------------------------------------------------- culling ---

/**
 * The viewport, as the two windows an annulus sector can be rejected against.
 *
 * **The correctness rule** (round G5): the predicate may only reject what
 * *provably* cannot touch the rect. A false negative — drawing something that
 * turns out to be off screen — costs a path nobody sees; a false positive is a
 * hole in the picture. So both windows are outer bounds and nothing here is
 * ever tightened:
 *
 *  - the **radial** window is `[closest point of the rect, farthest corner]`
 *    from the local origin — every point of the rect has a radius inside it;
 *  - the **angular** window is the cone the rect subtends at the origin. A rect
 *    that CONTAINS the origin subtends everything, so there is no angular
 *    constraint at all (`full`). Otherwise the rect is convex and misses the
 *    origin, so it sits in an open half-plane through it: the cone is narrower
 *    than π and is spanned by the four corners, which is what makes taking the
 *    minimal arc through them exact rather than a guess.
 *
 * A sector that intersects the rect has a point in both, whose radius lies in
 * both radial intervals and whose angle lies in both angular ones — so failing
 * either test is a proof of disjointness. The converse does not hold and is not
 * claimed. The rect handed in is already padded by {@link CULL_MARGIN_PX}, so
 * strokes, rims and glyphs that sit slightly outside their wedge are covered
 * without being modelled.
 */
export function makeCull(x0: number, y0: number, x1: number, y1: number): ViewCull {
  const nearX = Math.min(Math.max(0, x0), x1);
  const nearY = Math.min(Math.max(0, y0), y1);
  const dMin = Math.hypot(nearX, nearY);
  const dMax = Math.hypot(Math.max(Math.abs(x0), Math.abs(x1)), Math.max(Math.abs(y0), Math.abs(y1)));
  const full = x0 <= 0 && x1 >= 0 && y0 <= 0 && y1 >= 0;
  if (full) return { x0, y0, x1, y1, dMin, dMax, full, a0: 0, a1: TAU };

  // The rect's own centre is inside it, hence inside the cone — so every corner
  // is within π of it and the wrapped deltas order themselves without a case.
  const base = Math.atan2((y0 + y1) / 2, (x0 + x1) / 2);
  let lo = 0;
  let hi = 0;
  for (const x of [x0, x1]) {
    for (const y of [y0, y1]) {
      const delta = wrapToPi(Math.atan2(y, x) - base);
      if (delta < lo) lo = delta;
      if (delta > hi) hi = delta;
    }
  }
  return { x0, y0, x1, y1, dMin, dMax, full, a0: base + lo, a1: base + hi };
}

/** Could this wedge touch the viewport? Conservative — see {@link makeCull}. */
export function arcVisible(cull: ViewCull, arc: { r0: number; r1: number; a0: number; a1: number }): boolean {
  if (arc.r1 < cull.dMin || arc.r0 > cull.dMax) return false;
  if (cull.full) return true;
  return anglesOverlap(arc.a0, arc.a1, cull.a0, cull.a1);
}

/** Could this polyline (or Bézier hull) touch the viewport? Box test only. */
function boxVisible(cull: ViewCull, points: readonly Point[]): boolean {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const point of points) {
    if (point.x < minX) minX = point.x;
    if (point.x > maxX) maxX = point.x;
    if (point.y < minY) minY = point.y;
    if (point.y > maxY) maxY = point.y;
  }
  return !(maxX < cull.x0 || minX > cull.x1 || maxY < cull.y0 || minY > cull.y1);
}

/**
 * Do two angular intervals overlap on the circle?
 *
 * Both are given as `[start, start + length]` with a non-negative length, which
 * is how the layout writes an arc (`a1 > a0`, up to a full turn) and how
 * {@link makeCull} writes its cone. Two arcs of a circle meet exactly when one
 * of them contains the other's start — walk back from any shared point to one
 * start and you either stay inside the other arc the whole way or leave it
 * through its own start.
 */
export function anglesOverlap(a0: number, a1: number, w0: number, w1: number): boolean {
  const arcSpan = a1 - a0;
  const windowSpan = w1 - w0;
  if (arcSpan >= TAU || windowSpan >= TAU) return true;
  return wrapToTau(w0 - a0) <= arcSpan || wrapToTau(a0 - w0) <= windowSpan;
}

/** `angle` folded into `[-π, π)`. */
function wrapToPi(angle: number): number {
  const wrapped = wrapToTau(angle);
  return wrapped >= Math.PI ? wrapped - TAU : wrapped;
}

/** `angle` folded into `[0, 2π)`. */
function wrapToTau(angle: number): number {
  const wrapped = angle % TAU;
  return wrapped < 0 ? wrapped + TAU : wrapped;
}

// ----------------------------------------------------------------- colour ---

/**
 * `#rrggbb` (or `rgba(...)`) → `rgba(...)` at the given alpha.
 *
 * The uncached form. Every call site goes through {@link withAlpha}; this one
 * is what that memoises, and what a probe compares it against.
 */
export function computeWithAlpha(color: string, alpha: number): string {
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

const ALPHA_CACHE = new Map<string, string>();

/**
 * {@link computeWithAlpha}, memoised on `(colour, alpha)` — byte-identical
 * output, without the parse, the shifts and the template per arc per frame.
 *
 * The alphas are a small set by construction: the ring step
 * (`0.94 − 0.055 × (ring − 1)`), that times {@link DIM_ALPHA}, the 0.85 floors,
 * the two edge weights, and `0.85 × alpha` for a change marker. The one
 * continuous caller is the ⌘P pulse, for a second at a time — which is why the
 * cache is emptied wholesale at its cap rather than frozen: an entry the pulse
 * pushed out has to be able to come back.
 */
export function withAlpha(color: string, alpha: number): string {
  const key = `${color}|${alpha}`;
  const cached = ALPHA_CACHE.get(key);
  if (cached !== undefined) return cached;
  const value = computeWithAlpha(color, alpha);
  if (ALPHA_CACHE.size >= COLOR_CACHE_MAX) ALPHA_CACHE.clear();
  ALPHA_CACHE.set(key, value);
  return value;
}

/** Dark ink on a bright arc, light ink on a dark one. Uncached form. */
export function computeReadableOn(color: string): string {
  if (!color.startsWith('#') || color.length !== 7) return '#e6edf7';
  const value = Number.parseInt(color.slice(1), 16);
  const r = (value >> 16) & 255;
  const g = (value >> 8) & 255;
  const b = value & 255;
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.6 ? '#0b1220' : '#eef4ff';
}

const INK_CACHE = new Map<string, string>();

/** {@link computeReadableOn}, memoised — one entry per colour in the palette. */
export function readableOn(color: string): string {
  const cached = INK_CACHE.get(color);
  if (cached !== undefined) return cached;
  const ink = computeReadableOn(color);
  if (INK_CACHE.size >= COLOR_CACHE_MAX) INK_CACHE.clear();
  INK_CACHE.set(color, ink);
  return ink;
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
