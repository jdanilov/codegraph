/**
 * The sunburst layout — where every arc sits.
 *
 * The visual language is a DaisyDisk-style radial disk: the **current root** is
 * the centre circle, every ring outward is one level of the `contains`
 * backbone, and an entry's **angular extent is its share of the LoC** among its
 * siblings.
 *
 * Sibling ORDER is a mode ({@link SortMode}) and is independent of the angle:
 * `structural` (the default) reads the disk like the source tree — directories
 * alphabetical, a file's symbols in declaration order — while `size` orders
 * largest-first (the DaisyDisk convention) so the project reads as "where is
 * the mass". Either way the wedge itself is the LoC share.
 *
 * Radial DEPTH encodes what an arc is: a directory owns its whole ring band, a
 * file three quarters of it, a symbol half ({@link depthFactor}). Bands still
 * pack from the inside out — a band ends at its tallest wedge and the next band
 * starts there — so the rings never drift apart; a shorter wedge simply leaves
 * a little space toward the outside of its own band.
 *
 * Three properties are load-bearing and worth stating outright:
 *
 *  1. **Fully deterministic.** No simulation, no pinning, no relaxation. The
 *     same (model, root) always produces byte-identical geometry, so nothing on
 *     screen ever moves unless the user navigates. This is the whole point of
 *     replacing the force layout.
 *  2. **Minimum angular sliver.** An arc is never thinner than
 *     {@link MIN_ARC_ANGLE}; the leftover angle is distributed proportionally.
 *     That keeps a 3-line file clickable next to a 50k-LoC directory — and it
 *     also *bounds every ring*: a full circle can hold at most `2π / MIN` arcs,
 *     so the render budget can never be blown by breadth, only by depth.
 *  3. **Tail aggregation.** Children whose natural share falls below the sliver
 *     are folded into one `+N smaller` arc per parent, so a directory of 900
 *     tiny files is one honest arc rather than 900 unreadable hairlines.
 *
 * Symbols are drawn only where their file's wedge is wide enough to read
 * ({@link SYMBOL_RING_MIN_ANGLE}) — and always when the user has re-rooted into
 * the file, because then the file *is* the centre and its children own the full
 * 360°.
 */
import { DIRECTORY_KIND, ROOT_ID, type GraphModel, type ModelNode } from './model';

export const TAU = Math.PI * 2;

/** 12 o'clock, growing clockwise (canvas y points DOWN, so angles do too). */
export const START_ANGLE = -Math.PI / 2;

/** No arc is ever thinner than this — the "still clickable" floor. */
export const MIN_ARC_ANGLE = (1.1 * Math.PI) / 180;

/** A file/symbol wedge must be at least this wide to show its own children. */
export const SYMBOL_RING_MIN_ANGLE = (6 * Math.PI) / 180;

/** Rings drawn outward from the current root before the rest is aggregated. */
export const MAX_RINGS = 6;

/** Hard ceiling on rendered arcs (contract: ≤2k drawn primitives). */
export const MAX_ARCS = 2000;

/**
 * Children one parent renders individually before the rest is folded.
 *
 * The sliver floor alone would let a full circle hold ~327 arcs, which reads as
 * a comb rather than as structure. With this cap, ring 1 is ≤ 96 arcs and every
 * deeper ring ≤ 327, so six rings stay comfortably inside {@link MAX_ARCS}.
 */
export const MAX_SLOTS_PER_PARENT = 96;

/** Radius of the centre disk (the current root). */
export const CENTRE_RADIUS = 62;

const RING_GAP = 2;

/** Rings get slightly thinner outward, so the disk stays a disk. */
function ringThickness(ring: number): number {
  return Math.max(30, 56 - 4 * (ring - 1));
}

/** Share of its ring band a file wedge occupies. */
export const FILE_DEPTH_FACTOR = 0.75;
/** Share of its ring band a symbol wedge occupies. */
export const SYMBOL_DEPTH_FACTOR = 0.5;

/**
 * How deep (radially) a wedge of this kind is drawn, as a share of its band.
 *
 * Directory 1 · file ¾ · symbol ½. The kind is legible from the wedge's own
 * shape before any colour is read, and the outer rings — which are the busiest
 * — become the shallowest, which is what stops a symbol ring from reading as a
 * second directory ring.
 */
export function depthFactor(kind: string): number {
  if (kind === DIRECTORY_KIND) return 1;
  if (kind === 'file') return FILE_DEPTH_FACTOR;
  return SYMBOL_DEPTH_FACTOR;
}

/** Outer radius of the deepest possible disk (every ring full depth). */
export const MAX_RADIUS = (() => {
  let radius = CENTRE_RADIUS;
  for (let ring = 1; ring <= MAX_RINGS; ring++) radius += ringThickness(ring) + RING_GAP;
  return radius - RING_GAP;
})();

/** Sibling ORDER. The angle is always the LoC share — only order changes. */
export type SortMode = 'structural' | 'size';

/** Structural reads like the source tree; that is the default (phase F). */
export const DEFAULT_SORT_MODE: SortMode = 'structural';

/** Whatever comes off the wire / out of settings, narrowed to a real mode. */
export function toSortMode(value: unknown): SortMode {
  return value === 'size' ? 'size' : 'structural';
}

export interface Point {
  x: number;
  y: number;
}

export interface SunburstArc {
  /** Stable key: the node id, or `agg|<parent id>` for a `+N smaller` arc. */
  key: string;
  /** Model node this arc renders. `null` for an aggregate arc. */
  nodeId: string | null;
  /** Direct children folded into this arc (aggregate arcs only). */
  aggregated: string[];
  /** 1-based; ring 0 is the centre disk. */
  ring: number;
  a0: number;
  a1: number;
  r0: number;
  r1: number;
  /** Key of the arc one ring in, or `null` when the parent is the centre. */
  parentKey: string | null;
  /** Node id one ring in — the centre root when `parentKey` is null. */
  parentNodeId: string;
  /** LoC share this arc represents. */
  weight: number;
  /** Children that exist in the model but are not rendered individually. */
  hiddenChildren: number;
  label: string;
  /** Model NodeKind, or `aggregate`. */
  kind: string;
  layer?: string;
}

export interface SunburstLayout {
  rootId: string;
  root: ModelNode;
  /** Root → … → current root, for the breadcrumb. */
  trail: ModelNode[];
  arcs: SunburstArc[];
  byKey: Map<string, SunburstArc>;
  /** Node id → the arc that renders it (rendered arcs only). */
  byNode: Map<string, SunburstArc>;
  /** Direct child id → the aggregate arc that swallowed it. */
  aggregatedInto: Map<string, SunburstArc>;
  /** Arcs indexed by ring, so a hit test scans one ring, not the disk. */
  byRing: SunburstArc[][];
  /**
   * Radial band per ring (index = ring, `[0]` is the centre disk). A wedge
   * starts at its band's `r0` and ends within it, shorter for a file or a
   * symbol — the BAND is what packs, not the individual wedge.
   */
  bands: Array<{ r0: number; r1: number }>;
  rings: number;
  /** True when depth, budget or the sliver floor hid something. */
  truncated: boolean;
  /** LoC the current root weighs — the centre disk prints it. */
  rootLoc: number;
  /** Sibling order this layout was built with. */
  sort: SortMode;
  centreRadius: number;
  maxRadius: number;
}

export const AGGREGATE_KIND = 'aggregate';

/** `agg|<parent id>` — one aggregate arc per parent, so the key is stable. */
export function aggregateKey(parentNodeId: string): string {
  return `agg|${parentNodeId}`;
}

// ------------------------------------------------------------------ sizes ---

/**
 * LoC weight per node, memoised per model.
 *
 * A directory weighs the sum of its children (the API's own `loc` is not
 * guaranteed to agree with the files the index actually holds); a file weighs
 * its line count; a symbol weighs its span. Nested symbols deliberately do NOT
 * roll up into their file — a class's methods share the class's wedge, they
 * don't inflate it.
 */
const SIZE_CACHE = new WeakMap<GraphModel, Map<string, number>>();

export function sizesOf(model: GraphModel): Map<string, number> {
  const cached = SIZE_CACHE.get(model);
  if (cached) return cached;

  const byDepth: string[][] = [];
  let maxDepth = 0;
  for (const node of model.nodes.values()) {
    const depth = node.depth;
    (byDepth[depth] ??= []).push(node.id);
    if (depth > maxDepth) maxDepth = depth;
  }

  const sizes = new Map<string, number>();
  for (let depth = maxDepth; depth >= 0; depth--) {
    for (const id of byDepth[depth] ?? []) {
      const node = model.get(id)!;
      if (node.kind === DIRECTORY_KIND) {
        let total = 0;
        for (const child of node.children) total += sizes.get(child) ?? 1;
        sizes.set(id, Math.max(1, total));
      } else {
        sizes.set(id, Math.max(1, node.weight));
      }
    }
  }
  SIZE_CACHE.set(model, sizes);
  return sizes;
}

// ----------------------------------------------------------- allocation ----

interface Slot {
  /** Child id, or `null` for the aggregated tail. */
  id: string | null;
  ids: string[];
  size: number;
  angle: number;
}

/**
 * Split `span` among `children`, **in the display order they arrive in**.
 *
 * **A child is folded only when it does not fit.** The parent can hold
 * `span / minAngle` slots (never more than {@link MAX_SLOTS_PER_PARENT}, which
 * is what stops a 300-child directory from rendering as a fine-toothed comb);
 * if the children fit, every one of them is drawn, with the tiny ones resting
 * on the sliver floor. If they don't, the SMALLEST are folded into the
 * `+N smaller` arc — which is a size decision, while the order the survivors
 * are drawn in stays whatever the caller asked for (phase F: the structural
 * sort must not be re-shuffled by the fold). The aggregate arc is always last.
 *
 * A *share* threshold was tried first and is wrong: 40 equally-sized files in a
 * 6° wedge are each below any fixed share, so the whole directory folded into a
 * single `+40` arc even though four of them fit comfortably. Fit is the only
 * honest threshold.
 *
 * Every slot then gets `minAngle` plus a proportional share of what is left,
 * which sums back to exactly `span`.
 */
export function allocateSlots(
  children: Array<{ id: string; size: number }>,
  span: number,
  minAngle: number
): Slot[] {
  if (children.length === 0 || span < minAngle) return [];

  const capacity = Math.max(
    1,
    Math.min(MAX_SLOTS_PER_PARENT, Math.floor(span / minAngle + 1e-9))
  );
  const fits = children.length <= capacity;
  let kept = children;
  let tail: Array<{ id: string; size: number }> = [];
  if (!fits) {
    const keptCount = Math.max(0, capacity - 1);
    // Rank by size to decide WHO survives; index order decides where they sit.
    const survivors = new Set(
      children
        .map((child, index) => ({ index, size: child.size }))
        .sort((a, b) => b.size - a.size || a.index - b.index)
        .slice(0, keptCount)
        .map((entry) => entry.index)
    );
    kept = children.filter((_, index) => survivors.has(index));
    tail = children.filter((_, index) => !survivors.has(index));
  }

  const slots: Slot[] = kept.map((child) => ({
    id: child.id,
    ids: [child.id],
    size: child.size,
    angle: 0,
  }));
  if (tail.length > 0) {
    let tailSize = 0;
    for (const child of tail) tailSize += child.size;
    slots.push({ id: null, ids: tail.map((child) => child.id), size: Math.max(1, tailSize), angle: 0 });
  }
  if (slots.length === 0) return [];

  const free = Math.max(0, span - slots.length * minAngle);
  let slotTotal = 0;
  for (const slot of slots) slotTotal += slot.size;
  if (slotTotal <= 0) slotTotal = slots.length;
  for (const slot of slots) slot.angle = minAngle + (free * slot.size) / slotTotal;
  return slots;
}

// --------------------------------------------------------------- layout ----

export interface SunburstOptions {
  maxRings?: number;
  maxArcs?: number;
  /** Sibling order. Defaults to {@link DEFAULT_SORT_MODE}. */
  sort?: SortMode;
}

/**
 * Siblings in display order for the active mode.
 *
 * `structural` reads like the source tree: a directory's children
 * alphabetically (which is the order the model already holds them in), a file's
 * or a class's members in **declaration order**, so the disk and the file agree
 * about what comes first. `size` is the DaisyDisk order, largest first.
 *
 * Both are total orders with an id tiebreak, so the layout stays deterministic.
 */
function orderChildren(
  model: GraphModel,
  parentId: string,
  children: Array<{ id: string; size: number }>,
  sort: SortMode
): Array<{ id: string; size: number }> {
  const ordered = [...children];
  if (sort === 'size') {
    ordered.sort((a, b) => b.size - a.size || compareNames(model, a.id, b.id));
    return ordered;
  }
  if (model.get(parentId)?.kind === DIRECTORY_KIND) {
    ordered.sort((a, b) => compareNames(model, a.id, b.id));
    return ordered;
  }
  ordered.sort((a, b) => {
    const left = model.get(a.id);
    const right = model.get(b.id);
    const byLine = (left?.startLine ?? 0) - (right?.startLine ?? 0);
    return byLine || compareNames(model, a.id, b.id);
  });
  return ordered;
}

/**
 * Whether an arc is wide enough (and the right kind) to grow another ring.
 *
 * Directories always drill; files and symbols only do so once their wedge is
 * legible, which is what keeps the outermost ring from turning into a hairline
 * comb. A wedge that cannot hold two children plus a tail is left alone rather
 * than stacking `+N` arcs radially outward, which reads as noise.
 */
function canDescend(arc: SunburstArc, childCount: number): boolean {
  if (childCount === 0) return false;
  const span = arc.a1 - arc.a0;
  const needed = childCount === 1 ? MIN_ARC_ANGLE : MIN_ARC_ANGLE * 3;
  if (span < needed) return false;
  if (arc.kind === DIRECTORY_KIND) return true;
  return span >= SYMBOL_RING_MIN_ANGLE;
}

export function computeSunburst(
  model: GraphModel,
  requestedRootId: string,
  options: SunburstOptions = {}
): SunburstLayout {
  const maxRings = Math.min(options.maxRings ?? MAX_RINGS, MAX_RINGS);
  const maxArcs = options.maxArcs ?? MAX_ARCS;
  const sort = options.sort ?? DEFAULT_SORT_MODE;
  const sizes = sizesOf(model);

  const root = model.get(requestedRootId) ?? model.get(ROOT_ID)!;
  const rootId = root.id;

  const arcs: SunburstArc[] = [];
  const byKey = new Map<string, SunburstArc>();
  const byNode = new Map<string, SunburstArc>();
  const aggregatedInto = new Map<string, SunburstArc>();
  const byRing: SunburstArc[][] = [[]];
  const bands: Array<{ r0: number; r1: number }> = [{ r0: 0, r1: CENTRE_RADIUS }];
  let truncated = false;

  interface Frontier {
    arc: SunburstArc | null;
    nodeId: string;
    a0: number;
    a1: number;
  }

  let frontier: Frontier[] = [
    { arc: null, nodeId: rootId, a0: START_ANGLE, a1: START_ANGLE + TAU },
  ];
  let rings = 0;
  let bandStart = CENTRE_RADIUS;

  for (let ring = 1; ring <= maxRings && frontier.length > 0; ring++) {
    const r0 = bandStart;
    const thickness = ringThickness(ring);
    const produced: SunburstArc[] = [];

    for (const item of frontier) {
      const childIds = model.childrenOf(item.nodeId);
      if (childIds.length === 0) continue;
      const children = orderChildren(
        model,
        item.nodeId,
        childIds.map((id) => ({ id, size: sizes.get(id) ?? 1 })),
        sort
      );

      const span = item.a1 - item.a0;
      const slots = allocateSlots(children, span, MIN_ARC_ANGLE);
      if (slots.length === 0) {
        if (item.arc) item.arc.hiddenChildren = childIds.length;
        truncated = true;
        continue;
      }

      let cursor = item.a0;
      slots.forEach((slot, index) => {
        const a0 = cursor;
        // Snap the last slot so float drift can never leave a seam.
        const a1 = index === slots.length - 1 ? item.a1 : cursor + slot.angle;
        cursor = a1;
        const node = slot.id ? model.get(slot.id) : undefined;
        // Radial depth is the KIND's (phase F). An aggregate takes the deepest
        // of what it folded, so a `+N` arc never looks shallower than the
        // siblings it stands in for.
        const factor = node
          ? depthFactor(node.kind)
          : slot.ids.reduce(
              (deepest, id) => Math.max(deepest, depthFactor(model.get(id)?.kind ?? '')),
              SYMBOL_DEPTH_FACTOR
            );
        const arc: SunburstArc = {
          key: slot.id ?? aggregateKey(item.nodeId),
          nodeId: slot.id,
          aggregated: slot.id ? [] : slot.ids,
          ring,
          a0,
          a1,
          r0,
          r1: r0 + thickness * factor,
          parentKey: item.arc?.key ?? null,
          parentNodeId: item.nodeId,
          weight: slot.size,
          hiddenChildren: node ? model.childrenOf(node.id).length : slot.ids.length,
          label: node ? node.name : `+${slot.ids.length} smaller`,
          kind: node ? node.kind : AGGREGATE_KIND,
        };
        if (node?.layer) arc.layer = node.layer;
        produced.push(arc);
        if (!slot.id) truncated = true;
      });

      if (item.arc) {
        const rendered = slots.filter((slot) => slot.id !== null).length;
        item.arc.hiddenChildren = childIds.length - rendered;
      }
    }

    if (produced.length === 0) break;
    if (arcs.length + produced.length > maxArcs) {
      // Never render a partial ring: a half-drawn ring reads as missing data.
      truncated = true;
      break;
    }

    const ringArcs: SunburstArc[] = [];
    let bandEnd = r0;
    for (const arc of produced) {
      arcs.push(arc);
      ringArcs.push(arc);
      byKey.set(arc.key, arc);
      if (arc.r1 > bandEnd) bandEnd = arc.r1;
      if (arc.nodeId) byNode.set(arc.nodeId, arc);
      else for (const id of arc.aggregated) aggregatedInto.set(id, arc);
    }
    byRing[ring] = ringArcs;
    // The band ends at its TALLEST wedge, and the next ring starts there: a
    // ring of nothing but symbols is genuinely thinner, and a mixed ring keeps
    // its directories touching the ring outside them.
    bands[ring] = { r0, r1: bandEnd };
    bandStart = bandEnd + RING_GAP;
    rings = ring;

    const next: Frontier[] = [];
    for (const arc of ringArcs) {
      if (!arc.nodeId) continue;
      const childCount = model.childrenOf(arc.nodeId).length;
      if (ring >= maxRings || !canDescend(arc, childCount)) {
        if (childCount > 0) truncated = true;
        continue;
      }
      next.push({ arc, nodeId: arc.nodeId, a0: arc.a0, a1: arc.a1 });
    }
    frontier = next;
  }

  const trail: ModelNode[] = [];
  for (const id of [...model.ancestors(rootId)].reverse()) {
    const node = model.get(id);
    if (node) trail.push(node);
  }
  trail.push(root);

  return {
    rootId,
    root,
    trail,
    arcs,
    byKey,
    byNode,
    aggregatedInto,
    byRing,
    bands,
    rings,
    truncated,
    rootLoc: sizes.get(rootId) ?? root.weight,
    sort,
    centreRadius: CENTRE_RADIUS,
    maxRadius: rings > 0 ? bands[rings]!.r1 : CENTRE_RADIUS,
  };
}

function compareNames(model: GraphModel, a: string, b: string): number {
  const left = model.get(a)?.name ?? a;
  const right = model.get(b)?.name ?? b;
  return left.localeCompare(right, undefined, { sensitivity: 'base' }) || a.localeCompare(b);
}

// ------------------------------------------------------------- geometry ----

/** Mid-point of an arc, in layout units. Edge bundling anchors here. */
export function arcCentroid(arc: SunburstArc): Point {
  const angle = (arc.a0 + arc.a1) / 2;
  const radius = (arc.r0 + arc.r1) / 2;
  return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
}

/**
 * Which arc covers a layout-space point, or `null` for the centre / outside.
 *
 * The ring is found from the radius, so a hit test scans one ring (≤ 2π/MIN
 * arcs) rather than the whole disk. The test is against the ring's **band**,
 * not the wedge's own (possibly shallower) outer radius: a file wedge draws ¾
 * of its band, and the quarter of empty band behind it still belongs to that
 * file as far as the pointer is concerned — shrinking the click target with the
 * paint would make symbols noticeably harder to hit.
 */
export function arcAt(layout: SunburstLayout, x: number, y: number): SunburstArc | null {
  const radius = Math.hypot(x, y);
  if (radius <= layout.centreRadius || radius > layout.maxRadius) return null;
  const angle = normalizeAngle(Math.atan2(y, x));
  for (let ring = 1; ring <= layout.rings; ring++) {
    const arcsInRing = layout.byRing[ring];
    if (!arcsInRing || arcsInRing.length === 0) continue;
    const band = layout.bands[ring];
    if (!band || radius < band.r0 || radius > band.r1) continue;
    for (const arc of arcsInRing) {
      if (angle >= arc.a0 && angle < arc.a1) return arc;
    }
    return null;
  }
  return null;
}

/** Fold an angle into `[START_ANGLE, START_ANGLE + 2π)`, the layout's span. */
export function normalizeAngle(angle: number): number {
  let value = angle;
  while (value < START_ANGLE) value += TAU;
  while (value >= START_ANGLE + TAU) value -= TAU;
  return value;
}

// ------------------------------------------------------------ navigation ---

/** The default root: the whole project. */
export function initialRoot(model: GraphModel): string {
  return model.nodes.has(ROOT_ID) ? ROOT_ID : (model.nodes.keys().next().value ?? ROOT_ID);
}

/** Root → … → node, inclusive. */
export function chainFromRoot(model: GraphModel, id: string): string[] {
  if (!model.nodes.has(id)) return [];
  return [...[...model.ancestors(id)].reverse(), id];
}

/**
 * Deepest node that contains every one of `ids` — where a card re-roots to.
 *
 * A card whose results are spread across the project lands on the project root;
 * a card that answers inside one file lands on that file. A leaf answer (one
 * symbol) re-roots to its parent instead of to itself, so there is context
 * around it rather than an empty disk.
 */
export function deepestCommonAncestor(model: GraphModel, ids: Iterable<string>): string {
  const chains: string[][] = [];
  for (const id of ids) {
    const chain = chainFromRoot(model, id);
    if (chain.length > 0) chains.push(chain);
  }
  if (chains.length === 0) return initialRoot(model);

  let common = chains[0]!;
  for (let i = 1; i < chains.length; i++) {
    const other = chains[i]!;
    let length = 0;
    while (length < common.length && length < other.length && common[length] === other[length]) {
      length++;
    }
    common = common.slice(0, length);
    if (common.length <= 1) break;
  }
  let candidate = common[common.length - 1] ?? initialRoot(model);
  if (model.childrenOf(candidate).length === 0) {
    candidate = model.get(candidate)?.parent ?? candidate;
  }
  return candidate;
}
