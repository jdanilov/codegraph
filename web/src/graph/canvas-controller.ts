/**
 * The sigma.js canvas: everything imperative about the graph view.
 *
 * React owns the floating panels; this class owns the WebGL surface. Keeping
 * them apart matters — the layout writes 1,200 node positions per animation
 * frame, and routing that through React state would cost more than the render.
 * The controller pushes a small summary back up (`onViewChange`) and React
 * pushes user intent down (`setColorMode`, `setEdgeKinds`, `setSelected`).
 *
 * What lives here:
 *
 *  - the graphology instance holding ONLY the mounted slice (`view.ts`);
 *  - the animation loop that runs `WedgeLayout` until it settles;
 *  - hover / drag / wobble-unpin / shift+click-expand interaction;
 *  - the reducers that dim everything but the hovered node's neighbourhood.
 */
import { MultiGraph } from 'graphology';
import Sigma from 'sigma';
import type { EdgeDisplayData, NodeDisplayData } from 'sigma/types';

import {
  CURVATURE_ATTRIBUTE,
  CURVED_EDGE_TYPE,
  DASHED_EDGE_TYPE,
  createCurvedEdgeProgram,
  createDashedEdgeProgram,
} from './dashed-edge-program';
import { drawNodeHover } from './hover-renderer';
import { WedgeLayout } from './layout';
import { ROOT_ID, type GraphModel, type ModelEdge, type ModelNode } from './model';
import {
  BACKBONE_COLOR,
  BACKBONE_SATELLITE_COLOR,
  colorForEdgeKind,
  colorForNode,
  type ColorMode,
} from './palette';
import { computeMountedView, initialExpansion, toggleExpansion, type MountedView } from './view';

export interface ViewSummary {
  mounted: number;
  primaries: number;
  satellites: number;
  visibleEdges: number;
  hiddenByBudget: boolean;
  /** Kinds (or layers) present in the mounted slice — drives the legend. */
  presentColorKeys: string[];
  expandedCount: number;
  pinnedCount: number;
  /** Every non-contains kind in the graph, contract kinds first. */
  edgeKinds: string[];
  /** The subset currently drawn — the controller owns this, not React. */
  enabledKinds: string[];
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

export interface CanvasCallbacks {
  onSelect(node: ModelNode | null): void;
  onViewChange(summary: ViewSummary): void;
  onEdgeTooltip(tooltip: EdgeTooltip | null): void;
}

const BACKBONE_PREFIX = 'bb|';
const RELATION_PREFIX = 'rel|';
/** Edge revealed only while hovering, because one endpoint is collapsed away. */
const LIFTED_PREFIX = 'lift|';

/** Simulation frames run before the very first paint, so load looks instant. */
const WARMUP_TICKS = 240;

/** Wobble detector: reversals needed, and the window they must happen in. */
const WOBBLE_REVERSALS = 3;
const WOBBLE_WINDOW_MS = 800;
const WOBBLE_MIN_SWING = 6;

interface NodeAttributes {
  x: number;
  y: number;
  size: number;
  color: string;
  label: string | null;
  type?: string;
  zIndex: number;
  satellite: boolean;
  expandable: boolean;
  expanded: boolean;
}

interface EdgeAttributes {
  size: number;
  color: string;
  type: string;
  curvature?: number;
  kind: string;
  modelKey?: string;
  backbone: boolean;
}

export class CanvasController {
  private readonly graph = new MultiGraph<NodeAttributes, EdgeAttributes>();
  private readonly layout = new WedgeLayout();
  private readonly sigma: Sigma<NodeAttributes, EdgeAttributes>;
  private readonly callbacks: CanvasCallbacks;

  private model: GraphModel | null = null;
  private expanded = new Set<string>();
  private view: MountedView = { nodes: [], byId: new Map(), truncated: false };
  private colorMode: ColorMode = 'kind';
  private enabledKinds = new Set<string>();

  private hovered: string | null = null;
  private highlightNodes = new Set<string>();
  private highlightEdges = new Set<string>();
  private selected: string | null = null;

  private dragId: string | null = null;
  private dragMoved = false;
  private dragSamples: Array<{ t: number; x: number }> = [];
  private suppressClick = false;

  private frame: number | null = null;
  private pendingReveal: string | null = null;
  /** A node the camera should centre on once the layout settles (Cmd+P). */
  private pendingFocus: string | null = null;
  private pendingRevealAt = 0;
  private fitted = false;
  private disposed = false;

  constructor(container: HTMLElement, callbacks: CanvasCallbacks) {
    this.callbacks = callbacks;
    this.sigma = new Sigma<NodeAttributes, EdgeAttributes>(this.graph, container, {
      // The wedge is meaningful: never let sigma re-frame the graph when it
      // grows, or every expansion would yank the user's viewport.
      autoRescale: true,
      enableEdgeEvents: true,
      renderEdgeLabels: false,
      minEdgeThickness: 1.2,
      labelColor: { color: '#dbe4f2' },
      labelFont: 'ui-sans-serif, system-ui, sans-serif',
      labelSize: 11,
      labelWeight: '500',
      labelDensity: 0.7,
      labelGridCellSize: 70,
      labelRenderedSizeThreshold: 7,
      defaultEdgeType: 'line',
      defaultDrawNodeHover: drawNodeHover,
      edgeProgramClasses: {
        [CURVED_EDGE_TYPE]: createCurvedEdgeProgram<NodeAttributes, EdgeAttributes>(),
        [DASHED_EDGE_TYPE]: createDashedEdgeProgram<NodeAttributes, EdgeAttributes>(),
      },
      nodeReducer: (node, data) => this.reduceNode(node, data),
      edgeReducer: (edge, data) => this.reduceEdge(edge, data),
    });
    this.bindEvents();
  }

  // ---------------------------------------------------------------- data ---

  /**
   * Install a model. On a re-index (`sameProject`) the expansion set, pins and
   * camera are preserved — the contract requires liveness not to cost the user
   * their place.
   */
  setModel(model: GraphModel, sameProject: boolean): void {
    const previous = this.model;
    this.model = model;

    if (!previous || !sameProject) {
      this.expanded = initialExpansion(model);
      this.enabledKinds = new Set(model.edgeKinds);
      this.fitted = false;
      this.selected = null;
    } else {
      this.expanded = new Set([...this.expanded].filter((id) => model.nodes.has(id)));
      // A brand-new edge kind arriving mid-session should be visible, not
      // silently off; kinds that vanished are simply dropped.
      const known = new Set(previous.edgeKinds);
      for (const kind of model.edgeKinds) if (!known.has(kind)) this.enabledKinds.add(kind);
      this.enabledKinds = new Set([...this.enabledKinds].filter((k) => model.edgeKinds.includes(k)));
      this.layout.retainPins((id) => model.nodes.has(id));
      if (this.selected && !model.nodes.has(this.selected)) this.selected = null;
    }
    this.sync(!previous || !sameProject);
  }

  setColorMode(mode: ColorMode): void {
    if (this.colorMode === mode) return;
    this.colorMode = mode;
    this.repaintNodes();
    this.emitSummary();
  }

  setEdgeKinds(kinds: Iterable<string>): void {
    this.enabledKinds = new Set(kinds);
    this.sync(false);
  }

  enabledEdgeKinds(): string[] {
    return [...this.enabledKinds];
  }

  setSelected(id: string | null): void {
    this.selected = id;
    this.sigma.refresh({ skipIndexation: true });
  }

  /** Shift+click, also reachable from a keyboard shortcut later. */
  toggle(id: string): void {
    if (!this.model) return;
    const next = toggleExpansion(this.model, this.expanded, id);
    if (next.size === this.expanded.size && [...next].every((v) => this.expanded.has(v))) return;
    const expanding = next.has(id) && !this.expanded.has(id);
    this.expanded = next;
    this.sync(false);
    if (expanding) {
      // Deferred until the simulation settles: measuring the new family while
      // its members are still travelling would zoom to a box that no longer
      // exists by the time the animation lands.
      this.pendingReveal = id;
      this.pendingRevealAt = performance.now();
    }
  }

  /**
   * The current expansion set, copied.
   *
   * Phase C's Cmd+P and phase D's URL state both need to read and restore what
   * is open; the set is copied so a caller can't mutate the controller's own
   * state behind its back.
   */
  getExpanded(): Set<string> {
    return new Set(this.expanded);
  }

  /**
   * Replace the expansion set wholesale, in ONE re-mount.
   *
   * Restoring a saved view by calling `toggle()` per id would re-run the mount
   * pass (and the camera reveal) once per node; this applies the whole set and
   * syncs a single time. Ids that no longer exist are dropped, and the root
   * stays expanded so a restore can never land on an empty canvas.
   */
  setExpanded(ids: Iterable<string>): void {
    const model = this.model;
    if (!model) return;
    const next = new Set<string>();
    for (const id of ids) if (model.nodes.has(id)) next.add(id);
    if (model.childrenOf(ROOT_ID).length > 0) next.add(ROOT_ID);
    this.expanded = next;
    this.sync(false);
  }

  /**
   * Select a node and bring it on screen — the Cmd+P landing.
   *
   * Reaching a node buried in a collapsed subtree means expanding every
   * ancestor of it (never the node itself: opening a directory the user only
   * wanted to *look at* would dump its whole fan-out on them). The camera move
   * waits for the layout to settle when the mount changed, otherwise it would
   * frame a position the node is still travelling away from.
   */
  reveal(id: string): boolean {
    const model = this.model;
    if (!model) return false;
    const node = model.get(id);
    if (!node) return false;

    const next = new Set(this.expanded);
    for (const ancestor of model.ancestors(id)) next.add(ancestor);
    const grew = next.size !== this.expanded.size;
    if (grew) {
      this.expanded = next;
      this.sync(false);
    }

    this.selected = id;
    this.sigma.refresh({ skipIndexation: true });
    this.callbacks.onSelect(node);

    if (grew) {
      this.pendingFocus = id;
      this.pendingRevealAt = performance.now();
      this.startAnimation();
    } else {
      this.focusOn(id);
    }
    return true;
  }

  destroy(): void {
    this.disposed = true;
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.sigma.kill();
  }

  // ------------------------------------------------------------- mounting ---

  private sync(resetCamera: boolean): void {
    const model = this.model;
    if (!model) return;

    this.view = computeMountedView(model, this.expanded);
    this.layout.setView(model, this.view);

    if (!this.fitted) {
      for (let i = 0; i < WARMUP_TICKS && this.layout.tick(); i++) {
        /* settle before the first paint */
      }
    }

    this.rebuildNodes(model);
    this.rebuildEdges(model);

    if (!this.fitted || resetCamera) {
      this.fitToContent();
      this.fitted = true;
    }
    this.emitSummary();
    this.startAnimation();
  }

  private rebuildNodes(model: GraphModel): void {
    const wanted = this.view.byId;
    for (const id of this.graph.nodes()) {
      if (!wanted.has(id)) this.graph.dropNode(id);
    }
    for (const mounted of this.view.nodes) {
      const node = model.get(mounted.id);
      if (!node) continue;
      const point = this.layout.positionOf(mounted.id) ?? { x: 0, y: 0 };
      const attributes: NodeAttributes = {
        x: point.x,
        y: point.y,
        size: this.layout.radiusOf(mounted.id),
        color: colorForNode(node, this.colorMode, model.layers),
        label: this.labelFor(node, mounted.satellite, mounted.hiddenChildren),
        zIndex: mounted.satellite ? 0 : 1,
        satellite: mounted.satellite,
        expandable: model.childrenOf(mounted.id).length > 0,
        expanded: mounted.expanded,
      };
      if (this.graph.hasNode(mounted.id)) this.graph.mergeNodeAttributes(mounted.id, attributes);
      else this.graph.addNode(mounted.id, attributes);
    }
  }

  private labelFor(node: ModelNode, satellite: boolean, hidden: number): string | null {
    if (satellite) return null;
    const suffix = hidden > 0 ? ` +${hidden}` : '';
    return `${node.name}${suffix}`;
  }

  /**
   * Backbone lines (straight) plus every enabled relation whose two endpoints
   * are BOTH mounted (contract). Relations to a collapsed subtree are not drawn
   * here — hovering lifts them to the nearest visible ancestor instead.
   */
  private rebuildEdges(model: GraphModel): void {
    const wanted = new Map<string, EdgeAttributes & { source: string; target: string }>();

    for (const mounted of this.view.nodes) {
      if (!mounted.parentId || !this.view.byId.has(mounted.parentId)) continue;
      wanted.set(`${BACKBONE_PREFIX}${mounted.id}`, {
        source: mounted.parentId,
        target: mounted.id,
        size: mounted.satellite ? 0.7 : 1.1,
        color: mounted.satellite ? BACKBONE_SATELLITE_COLOR : BACKBONE_COLOR,
        type: 'line',
        kind: 'contains',
        backbone: true,
      });
    }

    const seen = new Set<string>();
    for (const mounted of this.view.nodes) {
      for (const edge of model.edgesOf(mounted.id)) {
        if (seen.has(edge.key)) continue;
        if (!this.enabledKinds.has(edge.kind)) continue;
        if (!this.view.byId.has(edge.source) || !this.view.byId.has(edge.target)) continue;
        if (edge.source === edge.target) continue;
        seen.add(edge.key);
        wanted.set(`${RELATION_PREFIX}${edge.key}`, this.relationAttributes(edge));
      }
    }

    for (const key of this.graph.edges()) {
      if (key.startsWith(LIFTED_PREFIX)) continue;
      if (!wanted.has(key)) this.graph.dropEdge(key);
    }
    for (const [key, attributes] of wanted) {
      if (this.graph.hasEdge(key)) {
        this.graph.mergeEdgeAttributes(key, attributes);
        continue;
      }
      const { source, target, ...rest } = attributes;
      if (!this.graph.hasNode(source) || !this.graph.hasNode(target)) continue;
      this.graph.addDirectedEdgeWithKey(key, source, target, rest);
    }
  }

  private relationAttributes(
    edge: ModelEdge
  ): EdgeAttributes & { source: string; target: string } {
    return {
      source: edge.source,
      target: edge.target,
      // Thin enough to stay quiet, thick enough to actually hover: sigma picks
      // edges from the rendered thickness, so a 1px line is unclickable.
      size: edge.heuristic ? 2.4 : 1.8,
      color: colorForEdgeKind(edge.kind),
      type: edge.heuristic ? DASHED_EDGE_TYPE : CURVED_EDGE_TYPE,
      // Opposite directions bend opposite ways so an A↔B pair stays readable.
      [CURVATURE_ATTRIBUTE]: edge.source < edge.target ? 0.2 : -0.2,
      kind: edge.kind,
      modelKey: edge.key,
      backbone: false,
    };
  }

  private repaintNodes(): void {
    const model = this.model;
    if (!model) return;
    this.graph.updateEachNodeAttributes((id, attributes) => {
      const node = model.get(id);
      if (!node) return attributes;
      return { ...attributes, color: colorForNode(node, this.colorMode, model.layers) };
    });
  }

  // ------------------------------------------------------------ animation ---

  private startAnimation(): void {
    if (this.frame !== null || this.disposed) return;
    const step = (): void => {
      this.frame = null;
      if (this.disposed) return;
      const running = this.layout.tick();
      this.writePositions();
      const settled = !running || performance.now() - this.pendingRevealAt > 2000;
      if (this.pendingReveal && settled) {
        const target = this.pendingReveal;
        this.pendingReveal = null;
        this.revealAfterExpand(target);
      }
      if (this.pendingFocus && settled) {
        const target = this.pendingFocus;
        this.pendingFocus = null;
        this.focusOn(target);
      }
      if (running || this.dragId) this.frame = requestAnimationFrame(step);
    };
    this.frame = requestAnimationFrame(step);
  }

  /** One batched attribute update per frame — sigma refreshes once, not 1,200x. */
  private writePositions(): void {
    this.graph.updateEachNodeAttributes(
      (id, attributes) => {
        const point = this.layout.positionOf(id);
        if (!point) return attributes;
        return { ...attributes, x: point.x, y: point.y };
      },
      { attributes: ['x', 'y'] }
    );
  }

  // ------------------------------------------------------------- viewport ---

  private fitToContent(): void {
    const bounds = this.layout.bounds();
    if (!bounds) return;
    const { width, height } = this.sigma.getDimensions();
    const padX = Math.max(80, (bounds.maxX - bounds.minX) * 0.08);
    const padY = Math.max(80, (bounds.maxY - bounds.minY) * 0.08);
    let minX = bounds.minX - padX;
    let maxX = bounds.maxX + padX;
    let minY = bounds.minY - padY;
    let maxY = bounds.maxY + padY;

    // Match the viewport aspect so sigma's square normalization doesn't crop.
    const boxWidth = maxX - minX;
    const boxHeight = maxY - minY;
    const aspect = width / Math.max(height, 1);
    if (boxWidth / Math.max(boxHeight, 1) < aspect) {
      const wanted = boxHeight * aspect;
      const centre = (minX + maxX) / 2;
      minX = centre - wanted / 2;
      maxX = centre + wanted / 2;
    } else {
      const wanted = boxWidth / aspect;
      const centre = (minY + maxY) / 2;
      minY = centre - wanted / 2;
      maxY = centre + wanted / 2;
    }

    // A pinned custom bbox is what keeps the coordinate frame stable across
    // expansions: without it sigma renormalizes on every mount and the whole
    // graph visibly jumps sideways every time a directory opens.
    this.sigma.setCustomBBox({ x: [minX, maxX], y: [minY, maxY] });
    this.sigma.getCamera().setState({ x: 0.5, y: 0.5, ratio: 1, angle: 0 });
    this.sigma.refresh();
  }

  /**
   * After an expansion, bring the newly revealed family into view.
   *
   * Expansion pushes the graph rightward by design, so a fan-out routinely
   * lands past the viewport edge. Without this the user shift+clicks and sees
   * nothing happen. It only ever zooms OUT and only when something genuinely
   * doesn't fit, so it never fights a user who has deliberately zoomed in.
   */
  private revealAfterExpand(id: string): void {
    const visible = (this.model?.childrenOf(id) ?? []).filter((child) =>
      this.view.byId.has(child)
    );
    if (visible.length === 0) return;
    {
      const points = [id, ...visible]
        .map((child) => this.layout.positionOf(child))
        .filter((point): point is { x: number; y: number } => Boolean(point));
      if (points.length === 0) return;

      const world = {
        minX: Math.min(...points.map((p) => p.x)),
        maxX: Math.max(...points.map((p) => p.x)),
        minY: Math.min(...points.map((p) => p.y)),
        maxY: Math.max(...points.map((p) => p.y)),
      };
      const topLeft = this.sigma.graphToViewport({ x: world.minX, y: world.minY });
      const bottomRight = this.sigma.graphToViewport({ x: world.maxX, y: world.maxY });
      const box = {
        minX: Math.min(topLeft.x, bottomRight.x),
        maxX: Math.max(topLeft.x, bottomRight.x),
        minY: Math.min(topLeft.y, bottomRight.y),
        maxY: Math.max(topLeft.y, bottomRight.y),
      };

      const { width, height } = this.sigma.getDimensions();
      const margin = 80;
      const scale = Math.max(
        (box.maxX - box.minX) / Math.max(width - margin * 2, 1),
        (box.maxY - box.minY) / Math.max(height - margin * 2, 1)
      );
      const fits =
        box.minX >= margin &&
        box.minY >= margin &&
        box.maxX <= width - margin &&
        box.maxY <= height - margin;
      if (fits) return;

      const camera = this.sigma.getCamera();
      const centre = this.sigma.viewportToFramedGraph({
        x: (box.minX + box.maxX) / 2,
        y: (box.minY + box.maxY) / 2,
      });
      // Cap the zoom-out per expansion: a huge fan-out should still leave the
      // rest of the graph legible rather than shrinking it to dust.
      const ratio = scale > 1 ? camera.ratio * Math.min(scale, 2.5) : camera.ratio;
      void camera.animate({ x: centre.x, y: centre.y, ratio }, { duration: 380 });
    }
  }

  /**
   * Centre the camera on one node, zooming IN if the view is far out.
   *
   * A node that isn't mounted (the render budget elided it) has no position to
   * fly to; the selection still stands, the camera simply doesn't move.
   */
  private focusOn(id: string): void {
    const point = this.layout.positionOf(id);
    if (!point || !this.graph.hasNode(id)) return;
    const camera = this.sigma.getCamera();
    const framed = this.sigma.viewportToFramedGraph(this.sigma.graphToViewport(point));
    // Ratio is inverse zoom in sigma: capping it zooms in on a far-out view
    // without ever pulling back from one the user deliberately zoomed into.
    void camera.animate(
      { x: framed.x, y: framed.y, ratio: Math.min(camera.ratio, 0.5) },
      { duration: 420 }
    );
  }

  /** Re-fit the whole mounted graph — the "fit" control in the toolbar. */
  fitView(): void {
    this.fitToContent();
  }

  // -------------------------------------------------------------- reducers --

  private reduceNode(id: string, data: NodeAttributes): Partial<NodeDisplayData> {
    const result: Partial<NodeDisplayData> = { ...data };
    if (id === this.selected) {
      result.highlighted = true;
      result.forceLabel = true;
      result.size = data.size * 1.25;
    }
    if (this.hovered) {
      if (id === this.hovered) {
        result.highlighted = true;
        result.forceLabel = true;
      } else if (!this.highlightNodes.has(id)) {
        result.color = withAlpha(data.color, 0.16);
        result.label = null;
      } else {
        result.forceLabel = !data.satellite;
      }
    }
    return result;
  }

  private reduceEdge(id: string, data: EdgeAttributes): Partial<EdgeDisplayData> {
    const result: Partial<EdgeDisplayData> = { ...data };
    if (!this.hovered) return result;
    if (this.highlightEdges.has(id)) {
      result.size = data.size * 1.9;
      result.color = data.backbone ? 'rgba(190, 210, 240, 0.8)' : withAlpha(data.color, 0.95);
      result.zIndex = 2;
      return result;
    }
    result.color = withAlpha(data.color, data.backbone ? 0.08 : 0.05);
    return result;
  }

  // ---------------------------------------------------------------- events --

  private bindEvents(): void {
    this.sigma.on('enterNode', ({ node }) => this.setHover(node));
    this.sigma.on('leaveNode', () => this.setHover(null));

    this.sigma.on('clickNode', ({ node, event }) => {
      if (this.suppressClick) {
        this.suppressClick = false;
        return;
      }
      const original = event.original as MouseEvent;
      if (original && original.shiftKey) {
        this.toggle(node);
        return;
      }
      this.selected = node;
      this.sigma.refresh({ skipIndexation: true });
      this.callbacks.onSelect(this.model?.get(node) ?? null);
    });

    this.sigma.on('clickStage', () => {
      if (this.suppressClick) {
        this.suppressClick = false;
        return;
      }
      this.selected = null;
      this.sigma.refresh({ skipIndexation: true });
      this.callbacks.onSelect(null);
    });

    this.sigma.on('downNode', ({ node, event }) => {
      this.dragId = node;
      this.dragMoved = false;
      this.dragSamples = [{ t: performance.now(), x: this.sigma.viewportToGraph(event).x }];
      this.startAnimation();
    });

    this.sigma.on('moveBody', ({ event }) => {
      if (!this.dragId) return;
      const point = this.sigma.viewportToGraph(event);
      this.layout.pin(this.dragId, point.x, point.y);
      this.dragMoved = true;
      if (this.detectWobble(point.x)) {
        this.layout.unpin(this.dragId);
        this.dragId = null;
        this.suppressClick = true;
        this.emitSummary();
        return;
      }
      event.preventSigmaDefault();
      event.original.preventDefault();
      event.original.stopPropagation();
    });

    const endDrag = (): void => {
      if (!this.dragId) return;
      if (this.dragMoved) this.suppressClick = true;
      this.dragId = null;
      this.dragSamples = [];
      this.emitSummary();
    };
    this.sigma.on('upNode', endDrag);
    this.sigma.on('upStage', endDrag);

    this.sigma.on('enterEdge', ({ edge, event }) => this.showEdgeTooltip(edge, event.x, event.y));
    this.sigma.on('leaveEdge', () => this.callbacks.onEdgeTooltip(null));
  }

  /**
   * "Quick back-and-forth wobble" = at least three direction reversals inside
   * `WOBBLE_WINDOW_MS`. Deliberately measured on X only: a wobble is a
   * horizontal shake, and ignoring Y keeps a normal arcing drag from tripping it.
   */
  private detectWobble(x: number): boolean {
    const now = performance.now();
    this.dragSamples.push({ t: now, x });
    this.dragSamples = this.dragSamples.filter((sample) => now - sample.t <= WOBBLE_WINDOW_MS);
    let reversals = 0;
    let previousDirection = 0;
    for (let i = 1; i < this.dragSamples.length; i++) {
      const delta = this.dragSamples[i]!.x - this.dragSamples[i - 1]!.x;
      if (Math.abs(delta) < WOBBLE_MIN_SWING) continue;
      const direction = Math.sign(delta);
      if (previousDirection !== 0 && direction !== previousDirection) reversals++;
      previousDirection = direction;
    }
    if (reversals < WOBBLE_REVERSALS) return false;
    this.dragSamples = [];
    return true;
  }

  private setHover(id: string | null): void {
    if (this.hovered === id) return;
    this.dropLiftedEdges();
    this.hovered = id;
    this.highlightNodes = new Set();
    this.highlightEdges = new Set();
    if (id && this.model) {
      this.highlightNodes.add(id);
      for (const key of this.graph.edges(id)) {
        this.highlightEdges.add(key);
        this.highlightNodes.add(this.graph.source(key));
        this.highlightNodes.add(this.graph.target(key));
      }
      this.addLiftedEdges(id);
    }
    this.sigma.refresh({ skipIndexation: true });
  }

  /**
   * Hover rule: a relation whose far end is inside a collapsed subtree is
   * invisible under the both-endpoints-visible rule, which makes a collapsed
   * directory look unconnected. On hover we therefore draw it against the
   * nearest MOUNTED ancestor of the hidden endpoint, so the user sees where the
   * node reaches even before expanding.
   */
  private addLiftedEdges(id: string): void {
    const model = this.model;
    if (!model) return;
    let budget = 160;
    for (const edge of model.edgesOf(id)) {
      if (budget <= 0) break;
      if (!this.enabledKinds.has(edge.kind)) continue;
      const source = this.nearestMounted(edge.source);
      const target = this.nearestMounted(edge.target);
      if (!source || !target || source === target) continue;
      if (this.view.byId.has(edge.source) && this.view.byId.has(edge.target)) continue;
      const key = `${LIFTED_PREFIX}${edge.key}|${source}|${target}`;
      if (this.graph.hasEdge(key)) continue;
      const { source: _source, target: _target, ...attributes } = this.relationAttributes(edge);
      this.graph.addDirectedEdgeWithKey(key, source, target, {
        ...attributes,
        size: attributes.size * 0.9,
      });
      this.highlightEdges.add(key);
      this.highlightNodes.add(source);
      this.highlightNodes.add(target);
      budget--;
    }
  }

  private dropLiftedEdges(): void {
    for (const key of this.graph.edges()) {
      if (key.startsWith(LIFTED_PREFIX)) this.graph.dropEdge(key);
    }
  }

  private nearestMounted(id: string): string | null {
    if (this.view.byId.has(id)) return id;
    const model = this.model;
    if (!model) return null;
    for (const ancestor of model.ancestors(id)) {
      if (this.view.byId.has(ancestor)) return ancestor;
    }
    return null;
  }

  private showEdgeTooltip(key: string, x: number, y: number): void {
    const model = this.model;
    if (!model) return;
    const attributes = this.graph.getEdgeAttributes(key);
    if (attributes.backbone) {
      this.callbacks.onEdgeTooltip(null);
      return;
    }
    const edge = attributes.modelKey ? model.edge(attributes.modelKey) : undefined;
    if (!edge) return;
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
  }

  // ---------------------------------------------------------------- summary --

  private emitSummary(): void {
    const model = this.model;
    if (!model) return;
    const present = new Set<string>();
    let satellites = 0;
    for (const mounted of this.view.nodes) {
      if (mounted.satellite) satellites++;
      const node = model.get(mounted.id);
      if (!node) continue;
      present.add(this.colorMode === 'layer' ? (node.layer ?? '') : node.kind);
    }
    let visibleEdges = 0;
    for (const key of this.graph.edges()) {
      if (!key.startsWith(BACKBONE_PREFIX)) visibleEdges++;
    }
    this.callbacks.onViewChange({
      mounted: this.view.nodes.length,
      primaries: this.view.nodes.length - satellites,
      satellites,
      visibleEdges,
      hiddenByBudget: this.view.truncated,
      presentColorKeys: [...present],
      expandedCount: this.expanded.size,
      pinnedCount: this.layout.pinnedIds().length,
      edgeKinds: [...model.edgeKinds],
      enabledKinds: [...this.enabledKinds],
    });
  }
}

/** `#rrggbb` → `rgba(...)`, used for the hover dim. */
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
