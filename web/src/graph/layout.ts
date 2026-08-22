/**
 * The wedge layout: where every mounted node sits.
 *
 * Contract: the project root anchors the left-centre, expansion grows the graph
 * left-to-right inside a ~120° wedge, children are pre-ordered vertically by
 * name (A top → Z bottom) and connected to their parent by a STRAIGHT line, and
 * a collapsed parent wears its children as satellites.
 *
 * Two stages:
 *
 *  1. **Seed** — a tidy-tree pass over the mounted primaries assigns each node
 *     a slot (in-order for leaves, the mean of its children for a parent). The
 *     slot becomes an ANGLE inside the wedge and the depth becomes a RADIUS, so
 *     ordering is exact and subtrees never interleave. Radius per depth is
 *     widened until adjacent nodes at that depth are at least `MIN_SEPARATION`
 *     apart along the arc, which is what makes a wide fan-out push right rather
 *     than overlap.
 *  2. **Relax** — a small spring/repulsion simulation pulls nodes to their seed
 *     while pushing overlapping neighbours apart, so the result reads as
 *     force-laid rather than mechanical. Pinned nodes are immovable, and every
 *     node is constrained to stay right of its parent.
 *
 * Satellites are not simulated: they are placed on rings around their parent
 * every frame, which is both cheaper and exactly the "hugging" look.
 */
import { radiusForNode } from './palette';
import type { GraphModel } from './model';
import { ROOT_ID } from './model';
import type { MountedNode, MountedView } from './view';

export interface Point {
  x: number;
  y: number;
}

/** Total opening of the wedge the graph grows into. */
const WEDGE_RADIANS = (120 * Math.PI) / 180;
/** Minimum arc distance between two nodes sitting at the same depth. */
const MIN_SEPARATION = 96;
/** Smallest / largest radial step between consecutive depths. */
const MIN_COLUMN = 200;
const MAX_COLUMN = 1500;

/** Satellites never grow past this, whatever their LoC says. */
const SATELLITE_MAX_RADIUS = 8;

const TARGET_PULL = 0.055;
const REPULSION = 0.34;
const DAMPING = 0.82;
/** Below this total motion the simulation is considered settled. */
const SETTLED_ENERGY = 0.35;
const MAX_SPEED = 60;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export class WedgeLayout {
  private readonly positions = new Map<string, Point>();
  private readonly velocities = new Map<string, Point>();
  private readonly targets = new Map<string, Point>();
  private readonly radii = new Map<string, number>();
  private readonly pinned = new Set<string>();
  private primaries: MountedNode[] = [];
  private satellites: MountedNode[] = [];
  private parentOf = new Map<string, string | null>();
  private energy = Number.POSITIVE_INFINITY;

  /** Rebuild seeds for a new mounted slice, preserving existing positions. */
  setView(model: GraphModel, view: MountedView): void {
    this.primaries = view.nodes.filter((node) => !node.satellite);
    this.satellites = view.nodes.filter((node) => node.satellite);
    this.parentOf = new Map(view.nodes.map((node) => [node.id, node.parentId]));

    this.radii.clear();
    for (const node of view.nodes) {
      const modelNode = model.get(node.id);
      const radius = modelNode ? radiusForNode(modelNode) : 8;
      // Satellites are deliberately small and range-bound: they are a hint at
      // what is inside, not a reading of it. A 40px directory circle orbiting
      // its parent would read as a sibling, which is exactly wrong.
      this.radii.set(
        node.id,
        node.satellite ? Math.max(2.5, Math.min(radius * 0.42, SATELLITE_MAX_RADIUS)) : radius
      );
    }

    this.seed();

    // Forget nodes that left the view so a re-expansion re-seeds cleanly, but
    // keep pins: the user asked for those positions.
    for (const id of [...this.positions.keys()]) {
      if (!view.byId.has(id) && !this.pinned.has(id)) {
        this.positions.delete(id);
        this.velocities.delete(id);
      }
    }
    this.energy = Number.POSITIVE_INFINITY;
  }

  /** Seed angles/radii from a tidy-tree pass over the mounted primaries. */
  private seed(): void {
    this.targets.clear();
    if (this.primaries.length === 0) return;

    const childrenOf = new Map<string, MountedNode[]>();
    for (const node of this.primaries) {
      if (node.parentId === null) continue;
      const list = childrenOf.get(node.parentId);
      if (list) list.push(node);
      else childrenOf.set(node.parentId, [node]);
    }
    for (const list of childrenOf.values()) list.sort((a, b) => a.order - b.order);

    const slot = new Map<string, number>();
    const depth = new Map<string, number>();
    let nextLeafSlot = 0;

    // Iterative post-order: the tree can be thousands deep in pathological
    // repos and recursion would blow the stack.
    const stack: Array<{ id: string; depth: number; visited: boolean }> = [
      { id: ROOT_ID, depth: 0, visited: false },
    ];
    while (stack.length > 0) {
      const frame = stack.pop()!;
      const children = childrenOf.get(frame.id) ?? [];
      if (!frame.visited && children.length > 0) {
        stack.push({ ...frame, visited: true });
        for (let i = children.length - 1; i >= 0; i--) {
          stack.push({ id: children[i]!.id, depth: frame.depth + 1, visited: false });
        }
        continue;
      }
      depth.set(frame.id, frame.depth);
      if (children.length === 0) {
        slot.set(frame.id, nextLeafSlot++);
      } else {
        const first = slot.get(children[0]!.id) ?? 0;
        const last = slot.get(children[children.length - 1]!.id) ?? first;
        slot.set(frame.id, (first + last) / 2);
      }
    }

    const maxSlot = Math.max(1, nextLeafSlot - 1);
    // Sigma's y axis points UP on screen, so the FIRST slot (A) has to take the
    // most POSITIVE angle to land at the top. Getting this backwards silently
    // renders the whole graph Z→A, which is why it is spelled out here.
    const angleOf = (id: string): number =>
      nextLeafSlot <= 1 ? 0 : WEDGE_RADIANS / 2 - ((slot.get(id) ?? 0) / maxSlot) * WEDGE_RADIANS;

    // Column width per depth, from the typical angular gap between SIBLINGS at
    // that depth: the tighter a fan-out, the further right it has to sit before
    // its members clear each other.
    let maxDepth = 0;
    const gapsByDepth = new Map<number, number[]>();
    for (const [parentId, children] of childrenOf) {
      if (children.length < 2) continue;
      const d = (depth.get(parentId) ?? 0) + 1;
      const gaps = gapsByDepth.get(d) ?? [];
      for (let i = 1; i < children.length; i++) {
        // Absolute: angles DECREASE with slot (A is the most positive), so a
        // signed gap here would silently be negative and filter out.
        const gap = Math.abs(angleOf(children[i]!.id) - angleOf(children[i - 1]!.id));
        if (gap > 1e-6) gaps.push(gap);
      }
      gapsByDepth.set(d, gaps);
    }
    for (const node of this.primaries) maxDepth = Math.max(maxDepth, depth.get(node.id) ?? 0);

    const columnAt: number[] = [0];
    for (let d = 1; d <= maxDepth; d++) {
      const gaps = (gapsByDepth.get(d) ?? []).slice().sort((a, b) => a - b);
      // Median, not minimum: one pathological fan-out must not shove an entire
      // depth into the far distance. Residual overlap is the simulation's job.
      const typical = gaps.length > 0 ? gaps[Math.floor(gaps.length / 2)]! : WEDGE_RADIANS;
      columnAt[d] = clamp(MIN_SEPARATION / typical, MIN_COLUMN, MAX_COLUMN);
    }

    // Seeds are PARENT-RELATIVE: a child sits one column away from its parent
    // along its own wedge angle. Because every angle is within ±60° of +x, the
    // step is at least half a column to the RIGHT — which is what makes
    // expansion grow left-to-right instead of fanning around the parent — and
    // a chain of such steps stays inside the wedge by construction.
    this.targets.set(ROOT_ID, { x: 0, y: 0 });
    for (const node of this.primaries) {
      if (node.id === ROOT_ID || node.parentId === null) continue;
      const parentTarget = this.targets.get(node.parentId);
      if (!parentTarget) continue;
      const angle = angleOf(node.id);
      const column = columnAt[depth.get(node.id) ?? 1] ?? MIN_COLUMN;
      this.targets.set(node.id, {
        x: parentTarget.x + Math.cos(angle) * column,
        y: parentTarget.y + Math.sin(angle) * column,
      });
    }

    // Newly mounted nodes start at their parent and travel outward, which is
    // what makes an expansion read as "children move away to the right". A node
    // promoted from satellite to primary keeps the position it was hugging at,
    // so it visibly detaches from the parent rather than teleporting.
    //
    // Every primary MUST end up with a velocity entry: satellites are placed,
    // not simulated, so a promoted one arrives without one — and `tick` skips
    // any node whose velocity is missing, which would freeze it in the ring.
    for (const node of this.primaries) {
      if (!this.positions.has(node.id)) {
        const parent = node.parentId ? this.positions.get(node.parentId) : undefined;
        const target = this.targets.get(node.id) ?? { x: 0, y: 0 };
        this.positions.set(
          node.id,
          parent
            ? {
                x: parent.x + (target.x - parent.x) * 0.08,
                y: parent.y + (target.y - parent.y) * 0.08,
              }
            : { ...target }
        );
      }
      if (!this.velocities.has(node.id)) this.velocities.set(node.id, { x: 0, y: 0 });
    }
  }

  /**
   * Advance the simulation one frame. Returns false once it has settled, which
   * is the renderer's cue to stop asking for animation frames.
   */
  tick(): boolean {
    if (this.primaries.length === 0) return false;

    const cells = new Map<string, string[]>();
    const cellSize = MIN_SEPARATION;
    const keyOf = (p: Point): string =>
      `${Math.floor(p.x / cellSize)}:${Math.floor(p.y / cellSize)}`;
    for (const node of this.primaries) {
      const position = this.positions.get(node.id);
      if (!position) continue;
      const key = keyOf(position);
      const list = cells.get(key);
      if (list) list.push(node.id);
      else cells.set(key, [node.id]);
    }

    let energy = 0;
    for (const node of this.primaries) {
      if (this.pinned.has(node.id) || node.id === ROOT_ID) continue;
      const position = this.positions.get(node.id);
      const target = this.targets.get(node.id);
      const velocity = this.velocities.get(node.id);
      if (!position || !target || !velocity) continue;

      velocity.x += (target.x - position.x) * TARGET_PULL;
      velocity.y += (target.y - position.y) * TARGET_PULL;

      // Repulsion, restricted to the 9 neighbouring buckets.
      const radius = this.radii.get(node.id) ?? 8;
      const cellX = Math.floor(position.x / cellSize);
      const cellY = Math.floor(position.y / cellSize);
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          for (const otherId of cells.get(`${cellX + dx}:${cellY + dy}`) ?? []) {
            if (otherId === node.id) continue;
            const other = this.positions.get(otherId);
            if (!other) continue;
            const deltaX = position.x - other.x;
            const deltaY = position.y - other.y;
            const distance = Math.hypot(deltaX, deltaY) || 0.01;
            const minimum = radius + (this.radii.get(otherId) ?? 8) + 22;
            if (distance >= minimum) continue;
            const push = ((minimum - distance) / minimum) * REPULSION * minimum;
            velocity.x += (deltaX / distance) * push;
            velocity.y += (deltaY / distance) * push;
          }
        }
      }

      velocity.x *= DAMPING;
      velocity.y *= DAMPING;
      const speed = Math.hypot(velocity.x, velocity.y);
      if (speed > MAX_SPEED) {
        velocity.x = (velocity.x / speed) * MAX_SPEED;
        velocity.y = (velocity.y / speed) * MAX_SPEED;
      }
      position.x += velocity.x;
      position.y += velocity.y;

      // The graph only ever grows rightward: never let a child drift left of
      // (or on top of) its parent.
      const parentId = this.parentOf.get(node.id);
      const parent = parentId ? this.positions.get(parentId) : undefined;
      if (parent) {
        const minimumX = parent.x + (this.radii.get(parentId!) ?? 8) + radius + 24;
        if (position.x < minimumX) {
          position.x = minimumX;
          if (velocity.x < 0) velocity.x = 0;
        }
      }
      energy += Math.abs(velocity.x) + Math.abs(velocity.y);
    }

    this.placeSatellites();
    this.energy = energy;
    return energy > SETTLED_ENERGY;
  }

  /** Satellites ride their parent: concentric rings, A at the top, clockwise. */
  private placeSatellites(): void {
    const groups = new Map<string, MountedNode[]>();
    for (const node of this.satellites) {
      if (!node.parentId) continue;
      const list = groups.get(node.parentId);
      if (list) list.push(node);
      else groups.set(node.parentId, [node]);
    }
    for (const [parentId, members] of groups) {
      const centre = this.positions.get(parentId);
      if (!centre) continue;
      members.sort((a, b) => a.order - b.order);
      const parentRadius = this.radii.get(parentId) ?? 10;
      const memberRadius = members.reduce(
        (biggest, member) => Math.max(biggest, this.radii.get(member.id) ?? 4),
        4
      );
      const step = memberRadius * 2 + 7;
      let index = 0;
      let ring = 0;
      while (index < members.length) {
        const ringRadius = parentRadius + memberRadius + 7 + ring * step;
        const capacity = Math.max(
          4,
          Math.min(members.length - index, Math.floor((2 * Math.PI * ringRadius) / step))
        );
        const count = Math.min(capacity, members.length - index);
        for (let i = 0; i < count; i++) {
          const member = members[index + i]!;
          if (this.pinned.has(member.id)) continue;
          // Same y-up convention: start at the top, then go clockwise.
          const angle = Math.PI / 2 - (i / count) * Math.PI * 2;
          this.positions.set(member.id, {
            x: centre.x + Math.cos(angle) * ringRadius,
            y: centre.y + Math.sin(angle) * ringRadius,
          });
        }
        index += count;
        ring++;
      }
    }
  }

  positionOf(id: string): Point | undefined {
    return this.positions.get(id);
  }

  radiusOf(id: string): number {
    return this.radii.get(id) ?? 8;
  }

  /** Drag: move a node and hold it there. */
  pin(id: string, x: number, y: number): void {
    this.positions.set(id, { x, y });
    this.velocities.set(id, { x: 0, y: 0 });
    this.pinned.add(id);
    this.energy = Number.POSITIVE_INFINITY;
  }

  /** Wobble: hand the node back to the simulation. */
  unpin(id: string): void {
    this.pinned.delete(id);
    this.velocities.set(id, { x: 0, y: 0 });
    this.energy = Number.POSITIVE_INFINITY;
  }

  isPinned(id: string): boolean {
    return this.pinned.has(id);
  }

  pinnedIds(): string[] {
    return [...this.pinned];
  }

  /** Drop pins for nodes that a re-index removed. */
  retainPins(exists: (id: string) => boolean): void {
    for (const id of [...this.pinned]) if (!exists(id)) this.pinned.delete(id);
  }

  isSettled(): boolean {
    return this.energy <= SETTLED_ENERGY;
  }

  /** Bounding box of everything placed, for the initial camera fit. */
  bounds(): { minX: number; minY: number; maxX: number; maxY: number } | null {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const [id, point] of this.positions) {
      const radius = this.radii.get(id) ?? 8;
      minX = Math.min(minX, point.x - radius);
      minY = Math.min(minY, point.y - radius);
      maxX = Math.max(maxX, point.x + radius);
      maxY = Math.max(maxY, point.y + radius);
    }
    return Number.isFinite(minX) ? { minX, minY, maxX, maxY } : null;
  }
}
