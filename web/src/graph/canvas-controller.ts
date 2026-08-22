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
import {
  bundleControlPoints,
  bundleCurve,
  distanceToPolyline,
} from './bundling';
import { DIRECTORY_KIND, ROOT_ID, type GraphModel, type ModelEdge, type ModelNode } from './model';
import { colorForEdgeKind, colorForNode, type ColorMode } from './palette';
import {
  AGGREGATE_KIND,
  MAX_ARCS,
  MAX_RADIUS,
  arcAt,
  computeSunburst,
  deepestCommonAncestor,
  initialRoot,
  type Point,
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

export interface EdgeTooltip {
  x: number;
  y: number;
  kind: string;
  sourceName: string;
  targetName: string;
  heuristic: boolean;
  synthesizedBy?: string;
  registeredAt?: string;
  line?: number;
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
  onEdgeTooltip(tooltip: EdgeTooltip | null): void;
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

/** Arc must be this long (screen px) before it earns a label. */
const LABEL_MIN_ARC_PX = 38;
const LABEL_MIN_THICKNESS_PX = 11;
/** A truncation that leaves fewer than this many characters is not a label. */
const LABEL_MIN_CHARS = 5;

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
  private enabledKinds = new Set<string>();

  private selected: string | null = null;
  private hoveredKey: string | null = null;
  private hoveredEdgeKey: string | null = null;

  private resultNodes = new Set<string>();
  private changedNodes = new Set<string>();
  private impactedNodes = new Set<string>();
  private resultEdges = new Set<string>();

  /** Arc keys the result/changed sets resolve to — recomputed per layout. */
  private resultArcs = new Set<string>();
  private changedArcs = new Set<string>();
  private impactedArcs = new Set<string>();

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
    this.callbacks.onArcTooltip(null);
    this.callbacks.onEdgeTooltip(null);
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
   * `+N smaller` arc (a directory of 900 files), so the fallback re-roots onto
   * the node ITSELF: the centre disk always renders the root, so ⌘P can reach
   * anything in the graph.
   */
  reveal(id: string): boolean {
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
    this.layout = computeSunburst(model, this.rootId);
    this.rootId = this.layout.rootId;
    this.projectHighlight();
    this.edgesDirty = true;
    this.requestDraw();
    this.emitSummary();
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
    this.drawLabels(ctx, layout, model, k);

    ctx.restore();

    // The edge count is part of the summary, and it only ever changes here.
    if (this.drawnEdges.length !== this.emittedEdges) this.emitSummary();
  }

  private drawArcs(
    ctx: CanvasRenderingContext2D,
    layout: SunburstLayout,
    model: GraphModel,
    k: number
  ): void {
    const dimming = this.resultArcs.size > 0;

    for (const arc of layout.arcs) {
      const pad = Math.min(0.0022, (arc.a1 - arc.a0) * 0.14);
      const a0 = arc.a0 + pad;
      const a1 = arc.a1 - pad;
      if (a1 <= a0) continue;

      const emphasised =
        this.resultArcs.has(arc.key) ||
        this.isUnderHover(arc) ||
        (this.selected !== null && arc.nodeId === this.selected);
      let alpha = 0.94 - 0.055 * (arc.ring - 1);
      if (dimming && !emphasised) alpha *= 0.26;
      else if (emphasised) alpha = 1;

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

      if (this.changedArcs.has(arc.key)) this.strokeRim(ctx, arc, a0, a1, RIM_CHANGED, 2.8 / k);
      else if (this.impactedArcs.has(arc.key)) {
        this.strokeRim(ctx, arc, a0, a1, RIM_IMPACTED, 2 / k);
      }
    }
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

    const canGoUp = Boolean(layout.root.parent);
    const nameSize = 12.5 / k;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#dbe4f2';
    ctx.font = `600 ${nameSize}px ui-sans-serif, system-ui, sans-serif`;
    const label = fitText(ctx, layout.root.name || 'project', (layout.centreRadius - 12) * 2);
    ctx.fillText(label, 0, canGoUp ? 4 / k : 0);
    if (canGoUp) {
      ctx.font = `500 ${9.5 / k}px ui-sans-serif, system-ui, sans-serif`;
      ctx.fillStyle = 'rgba(190, 205, 230, 0.7)';
      ctx.fillText('▲ up', 0, -13 / k);
    }
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
      const color = colorForEdgeKind(drawn.edge.kind);
      ctx.strokeStyle = withAlpha(color, hovered ? 0.98 : 0.62);
      ctx.lineWidth = (hovered ? 2.4 : 1.3) / k;
      // Provenance: a synthesized (heuristic) relation is dashed, always.
      if (drawn.edge.heuristic) ctx.setLineDash([6 / k, 4 / k]);
      else ctx.setLineDash([]);
      ctx.stroke();
    }
    ctx.setLineDash([]);
  }

  private drawLabels(
    ctx: CanvasRenderingContext2D,
    layout: SunburstLayout,
    model: GraphModel,
    k: number
  ): void {
    const dimming = this.resultArcs.size > 0;
    for (const arc of layout.arcs) {
      if (dimming && !this.resultArcs.has(arc.key) && arc.key !== this.hoveredKey) continue;
      this.drawArcLabel(ctx, arc, model, k);
    }
  }

  /**
   * A label follows its arc, one glyph at a time.
   *
   * Straight text in a ring is either tiny or crooked; curved text reads at the
   * ring thickness the arc actually has. Labels on the bottom half are flipped
   * so they are never upside down, and anything that cannot fit legibly is
   * simply not drawn — a truncated `sr…` is worse than nothing.
   */
  private drawArcLabel(
    ctx: CanvasRenderingContext2D,
    arc: SunburstArc,
    model: GraphModel,
    k: number
  ): void {
    const midRadius = (arc.r0 + arc.r1) / 2;
    const span = arc.a1 - arc.a0;
    if (span * midRadius * k < LABEL_MIN_ARC_PX) return;
    const thicknessPx = (arc.r1 - arc.r0) * k;
    if (thicknessPx < LABEL_MIN_THICKNESS_PX) return;

    const fontPx = Math.max(9, Math.min(12.5, thicknessPx * 0.34));
    ctx.font = `500 ${fontPx / k}px ui-sans-serif, system-ui, sans-serif`;
    const maxWidth = span * 0.9 * midRadius;
    const text = fitText(ctx, arc.label, maxWidth);
    // `ex…` names nothing. Either the label is legible or the arc stays bare
    // and the hover tooltip carries the name instead.
    if (!text || (text.endsWith('…') && text.length < LABEL_MIN_CHARS)) return;

    const mid = (arc.a0 + arc.a1) / 2;
    const flip = Math.sin(mid) > 0;
    const total = ctx.measureText(text).width;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = readableOn(this.fillFor(arc, model));

    let angle = flip ? mid + total / midRadius / 2 : mid - total / midRadius / 2;
    for (const character of text) {
      const step = ctx.measureText(character).width / midRadius;
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
    for (const key of this.resultEdges) {
      const edge = model.edgeByKey.get(key);
      if (edge && this.enabledKinds.has(edge.kind)) wanted.set(key, edge);
      if (wanted.size >= EDGE_BUDGET) break;
    }
    if (this.selected) this.collectEdges([this.selected], wanted);
    if (this.hoveredKey && this.hoveredKey !== CENTRE_KEY) {
      const arc = layout.byKey.get(this.hoveredKey);
      if (arc) this.collectEdges(arc.nodeId ? [arc.nodeId] : arc.aggregated, wanted);
    }

    for (const edge of wanted.values()) {
      const from = this.resolveArc(edge.source);
      const to = this.resolveArc(edge.target);
      if (!from && !to) continue;
      if (from && to && from.key === to.key) continue;
      const points = bundleCurve(bundleControlPoints(from, to, layout));
      if (points.length >= 2) this.drawnEdges.push({ edge, points });
    }
  }

  private collectEdges(seeds: string[], into: Map<string, ModelEdge>): void {
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

    const arc = arcAt(layout, world.x, world.y);
    if (!arc) {
      this.selected = null;
      this.edgesDirty = true;
      this.requestDraw();
      this.callbacks.onSelect(null);
      return;
    }

    if (!arc.nodeId) {
      // A `+N smaller` arc: re-rooting onto its parent gives the folded
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
    const arc = arcAt(layout, world.x, world.y);
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
      radius <= layout.centreRadius ? CENTRE_KEY : (arcAt(layout, world.x, world.y)?.key ?? null);
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

    if (this.hoveredEdgeKey) {
      const edge = model.edgeByKey.get(this.hoveredEdgeKey);
      if (edge) {
        const tooltip: EdgeTooltip = {
          x,
          y,
          kind: edge.kind,
          sourceName: model.get(edge.source)?.name ?? edge.source,
          targetName: model.get(edge.target)?.name ?? edge.target,
          heuristic: edge.heuristic,
        };
        if (edge.synthesizedBy) tooltip.synthesizedBy = edge.synthesizedBy;
        if (edge.registeredAt) tooltip.registeredAt = edge.registeredAt;
        if (edge.line !== undefined) tooltip.line = edge.line;
        this.callbacks.onEdgeTooltip(tooltip);
        this.callbacks.onArcTooltip(null);
        return;
      }
    }
    this.callbacks.onEdgeTooltip(null);

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
      present.add(this.colorMode === 'layer' ? (node.layer ?? '') : node.kind);
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
