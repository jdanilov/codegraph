/**
 * The WORKSPACE layer — N sunburst disks on one canvas.
 *
 * Phase G turns the canvas from "a disk" into "a workspace holding disks". The
 * motivating question is task-anchored: a chain of calls between different
 * levels of a system is not one subtree, so it cannot be one disk. Dragging a
 * wedge out of its disk spawns a second disk rooted at that node, and the
 * relations between the two are drawn straight across the gap.
 *
 * Everything here is **pure geometry**: workspace coordinates, the camera that
 * maps them to the screen, which disk owns a point, where a newly spawned disk
 * may sit, and the gentle curve drawn between two disks. No canvas, no DOM, no
 * graph model — so all of it can be probed numerically without a browser, which
 * is exactly how the hit-test round trip and the no-overlap guarantee were
 * validated.
 *
 * Coordinate systems, from the inside out:
 *
 *  1. **Layout space** — what `sunburst.ts` produces, one disk centred on its
 *     own origin. Untouched by this module; `computeSunburst` never learns that
 *     more than one disk exists.
 *  2. **Workspace space** — the same units, translated: every disk carries an
 *     `(x, y)` and the primary disk sits at `(0, 0)`. A single-disk workspace is
 *     therefore numerically identical to the pre-phase-G canvas.
 *  3. **Screen space** — one shared camera (`zoom`, `panX`, `panY`) over the
 *     whole workspace. Disks have positions, never individual scales: two disks
 *     on screen are always the same size, so a wedge in one can be compared with
 *     a wedge in the other.
 */

export interface Point {
  x: number;
  y: number;
}

/**
 * One disk's placement — everything the workspace geometry needs to know about
 * it. `radius` is the disk's own `SunburstLayout.maxRadius`, i.e. its real
 * painted outer extent, not the theoretical ceiling: a two-ring disk packs
 * tighter than a six-ring one, and the spawn gesture's "left the disk" test
 * fires where the user sees the edge.
 */
export interface DiskPlacement {
  id: string;
  x: number;
  y: number;
  radius: number;
}

export interface WorkspaceBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  /** Centre of the bounding box — what `fitCamera` centres on. */
  cx: number;
  cy: number;
  width: number;
  height: number;
}

/**
 * Clear space kept between two disks, in layout units.
 *
 * Overlap is avoided at SPAWN time rather than resolved at hit-test time: two
 * disks that never overlap make "which disk did I click" a question with one
 * obvious answer, and the user can still drag them into each other afterwards
 * (at which point the nearest-centre rule below decides).
 */
export const DISK_GAP = 40;

/** Relaxation steps before {@link placeSpawnedDisk} falls back to the scan. */
const RELAX_STEPS = 24;

/** Rings, and candidates per ring, of the deterministic fallback scan. */
const SCAN_RINGS = 40;
const SCAN_ANGLES = 16;

/** How far a cross-disk curve bows out of the straight chord. */
export const CROSS_EDGE_BOW = 0.14;

/** Samples along a cross-disk curve — enough for a smooth long span. */
export const CROSS_EDGE_SAMPLES = 24;

/**
 * First angle of {@link placeSpawnedDisk}'s fallback scan (up and right), and
 * therefore the direction a crowded workspace prefers to grow in.
 */
const SCAN_START_ANGLE = -Math.PI / 4;

/**
 * Length of a tether's control arms, as a share of the gap it spans.
 *
 * Both arms are the same length, so the curve leaves the source rim radially
 * and arrives at the target rim radially, and it is symmetric between the two.
 * Capped at half the gap so a pair of disks that almost touch cannot produce a
 * curve that loops back over itself.
 */
export const TETHER_ARM_SHARE = 0.42;
/** Floor for that arm, so a very short tether still reads as a curve. */
export const TETHER_MIN_ARM = 8;
/** Samples along a tether — its polyline is also the `×`'s hit test. */
export const TETHER_SAMPLES = 24;

// ------------------------------------------------------------------ bounds ---

/** Bounding box of every disk, including its radius. Empty input → a point. */
export function workspaceBounds(disks: readonly DiskPlacement[]): WorkspaceBounds {
  if (disks.length === 0) {
    return { minX: 0, minY: 0, maxX: 0, maxY: 0, cx: 0, cy: 0, width: 0, height: 0 };
  }
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const disk of disks) {
    if (disk.x - disk.radius < minX) minX = disk.x - disk.radius;
    if (disk.y - disk.radius < minY) minY = disk.y - disk.radius;
    if (disk.x + disk.radius > maxX) maxX = disk.x + disk.radius;
    if (disk.y + disk.radius > maxY) maxY = disk.y + disk.radius;
  }
  return {
    minX,
    minY,
    maxX,
    maxY,
    cx: (minX + maxX) / 2,
    cy: (minY + maxY) / 2,
    width: maxX - minX,
    height: maxY - minY,
  };
}

// ------------------------------------------------------------------ camera ---

export interface FitViewport {
  /** Free width the disks may use — the viewport minus the panel gutter. */
  width: number;
  height: number;
  padding: number;
  /** Screen px per layout unit at zoom 1 (the primary disk's fit scale). */
  baseScale: number;
  zoomMin: number;
  zoomMax: number;
}

export interface Camera {
  zoom: number;
  panX: number;
  panY: number;
}

/**
 * Camera that puts EVERY disk on screen — what the legend's `fit` does.
 *
 * The camera is anchored to workspace `(0, 0)` (the primary disk) rather than to
 * the bounding box, so spawning a disk does not shove the picture sideways: only
 * an explicit fit re-frames. For a single disk at the origin this returns
 * exactly `{ zoom: 1, panX: 0, panY: 0 }` — the pre-phase-G reset, unchanged.
 */
export function fitCamera(bounds: WorkspaceBounds, view: FitViewport): Camera {
  const usableWidth = Math.max(1, view.width - view.padding * 2);
  const usableHeight = Math.max(1, view.height - view.padding * 2);
  const spanX = Math.max(1e-6, bounds.width * view.baseScale);
  const spanY = Math.max(1e-6, bounds.height * view.baseScale);
  const wanted = Math.min(usableWidth / spanX, usableHeight / spanY);
  const zoom = Math.min(view.zoomMax, Math.max(view.zoomMin, wanted));
  const scale = view.baseScale * zoom;
  return { zoom, panX: -bounds.cx * scale, panY: -bounds.cy * scale };
}

// -------------------------------------------------------------- hit testing ---

/**
 * Which disk owns a workspace point — **nearest centre wins on overlap**.
 *
 * Containment alone is ambiguous the moment the user drags two disks together,
 * and "nearest centre" is the only tiebreak that agrees with what the eye does:
 * the disk whose middle you are closer to is the one you are pointing at.
 * `null` means empty canvas, which is what makes a drag there a pan.
 */
export function diskAt(
  disks: readonly DiskPlacement[],
  point: Point
): DiskPlacement | null {
  let best: DiskPlacement | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const disk of disks) {
    const distance = Math.hypot(point.x - disk.x, point.y - disk.y);
    if (distance <= disk.radius && distance < bestDistance) {
      bestDistance = distance;
      best = disk;
    }
  }
  return best;
}

/** Workspace point → the disk's own layout space (what `arcAt` speaks). */
export function toDiskLocal(point: Point, disk: DiskPlacement): Point {
  return { x: point.x - disk.x, y: point.y - disk.y };
}

/** Layout-space point in a disk → workspace space. */
export function fromDiskLocal(local: Point, disk: DiskPlacement): Point {
  return { x: local.x + disk.x, y: local.y + disk.y };
}

// -------------------------------------------------------------- tethers ---

/**
 * The expansion TETHER: the cubic that ties an expanded disk back to the wedge
 * it was pulled out of (phase G3).
 *
 * Geometry, and why it is this and not a straight line:
 *
 *  - it **starts on the source disk's rim**, at the collapsed wedge's mid
 *    angle — which is exactly where that wedge's stretched spoke meets the rim,
 *    so the line looks like a continuation of the wedge rather than an
 *    attachment to the disk;
 *  - it **leaves radially** (the first control arm lies along the same radius),
 *    so at the rim it reads as "out of here", not "past here";
 *  - it **arrives radially** at the nearest point of the expanded disk's rim
 *    (the second arm lies along that disk's radius through the arrival point),
 *    so it points at the target's centre instead of grazing it.
 *
 * `null` when the source rim point falls INSIDE the target disk: the two
 * overlap far enough that any line would point the wrong way, and saying
 * nothing is better than saying something false.
 */
export interface TetherCurve {
  /** On the source disk's rim, at the collapsed wedge's mid angle. */
  start: Point;
  control1: Point;
  control2: Point;
  /** Nearest point of the target disk's rim. */
  end: Point;
}

export function tetherCurve(
  source: DiskPlacement,
  midAngle: number,
  target: DiskPlacement
): TetherCurve | null {
  const start = {
    x: source.x + Math.cos(midAngle) * source.radius,
    y: source.y + Math.sin(midAngle) * source.radius,
  };
  const dx = start.x - target.x;
  const dy = start.y - target.y;
  const distance = Math.hypot(dx, dy);
  if (distance <= target.radius || distance < 1e-6) return null;
  const vx = dx / distance;
  const vy = dy / distance;
  const end = { x: target.x + vx * target.radius, y: target.y + vy * target.radius };

  const gap = Math.hypot(end.x - start.x, end.y - start.y);
  const arm = Math.min(Math.max(TETHER_MIN_ARM, gap * TETHER_ARM_SHARE), gap / 2);
  return {
    start,
    control1: { x: start.x + Math.cos(midAngle) * arm, y: start.y + Math.sin(midAngle) * arm },
    control2: { x: end.x + vx * arm, y: end.y + vy * arm },
    end,
  };
}

/** A tether's point at parameter `t` — the plain cubic Bézier evaluation. */
export function tetherPointAt(curve: TetherCurve, t: number): Point {
  const inverse = 1 - t;
  const a = inverse * inverse * inverse;
  const b = 3 * inverse * inverse * t;
  const c = 3 * inverse * t * t;
  const d = t * t * t;
  return {
    x: a * curve.start.x + b * curve.control1.x + c * curve.control2.x + d * curve.end.x,
    y: a * curve.start.y + b * curve.control1.y + c * curve.control2.y + d * curve.end.y,
  };
}

/** Sampled tether, in workspace units — the polyline the `×` is hit-tested on. */
export function tetherPolyline(curve: TetherCurve, samples = TETHER_SAMPLES): Point[] {
  const out: Point[] = [];
  for (let index = 0; index <= samples; index++) out.push(tetherPointAt(curve, index / samples));
  return out;
}

/**
 * Where a secondary disk's `×` sits, in workspace coordinates: **on its own
 * tether, at the middle of it** (phase G3).
 *
 * The button belongs to the relationship, not to either disk: the tether is the
 * one piece of the picture that means "this disk is an expansion of that
 * wedge", and closing the disk is exactly the undoing of that. On the rim (G1)
 * it competed with the wedges; in the centre circle (G2) it sat on top of the
 * disk's own caption and had to be hunted for by hovering the disk.
 */
export function closeAnchor(curve: TetherCurve): Point {
  return tetherPointAt(curve, 0.5);
}

// ------------------------------------------------------------- spawn placing ---

/** Does a disk of `radius` at `point` clear every existing disk? */
export function isClear(
  disks: readonly DiskPlacement[],
  point: Point,
  radius: number,
  gap = DISK_GAP
): boolean {
  for (const disk of disks) {
    const distance = Math.hypot(point.x - disk.x, point.y - disk.y);
    if (distance < disk.radius + radius + gap - 1e-9) return false;
  }
  return true;
}

/**
 * Where a newly spawned disk goes: the drop point when it is free, otherwise
 * the nearest place that clears every existing disk.
 *
 * Two stages, both deterministic. First a relaxation that pushes the candidate
 * straight away from whichever disk it penetrates deepest — that keeps the disk
 * near where the user actually dropped it, which is the whole point of a
 * drag-away gesture. If the relaxation is still overlapping after
 * {@link RELAX_STEPS} (a crowded workspace can bounce it between two disks), a
 * fixed outward scan around the drop point takes over and is guaranteed to
 * terminate: past the radius of every existing disk combined, every candidate is
 * clear.
 *
 * The result never overlaps — that is the property the probe asserts, and the
 * reason the "nearest centre wins" rule above is a tiebreak rather than a
 * load-bearing rule.
 */
export function placeSpawnedDisk(
  disks: readonly DiskPlacement[],
  preferred: Point,
  radius: number,
  gap = DISK_GAP
): Point {
  let point = { x: preferred.x, y: preferred.y };
  for (let step = 0; step < RELAX_STEPS; step++) {
    let worst: DiskPlacement | null = null;
    let worstIndex = 0;
    let worstPenetration = 0;
    let worstDistance = 0;
    for (let index = 0; index < disks.length; index++) {
      const disk = disks[index]!;
      const distance = Math.hypot(point.x - disk.x, point.y - disk.y);
      const penetration = disk.radius + radius + gap - distance;
      if (penetration > worstPenetration + 1e-9) {
        worst = disk;
        worstIndex = index;
        worstPenetration = penetration;
        worstDistance = distance;
      }
    }
    if (!worst) return point;
    let ux: number;
    let uy: number;
    if (worstDistance > 1e-6) {
      ux = (point.x - worst.x) / worstDistance;
      uy = (point.y - worst.y) / worstDistance;
    } else {
      // Dropped exactly on a centre: the direction has to come from somewhere
      // that is not floating-point noise, so it comes from the disk's index.
      const angle = worstIndex * (Math.PI * 2 * 0.381966);
      ux = Math.cos(angle);
      uy = Math.sin(angle);
    }
    point = { x: point.x + ux * (worstPenetration + 0.5), y: point.y + uy * (worstPenetration + 0.5) };
  }
  if (isClear(disks, point, radius, gap)) return point;

  const step = radius + gap;
  for (let ring = 1; ring <= SCAN_RINGS; ring++) {
    for (let slot = 0; slot < SCAN_ANGLES; slot++) {
      const angle = SCAN_START_ANGLE + (slot * Math.PI * 2) / SCAN_ANGLES;
      const candidate = {
        x: preferred.x + Math.cos(angle) * step * ring,
        y: preferred.y + Math.sin(angle) * step * ring,
      };
      if (isClear(disks, candidate, radius, gap)) return candidate;
    }
  }
  return point;
}

// --------------------------------------------------------- cross-disk edges ---

/**
 * The curve drawn between two disks: one gentle quadratic, no bundling.
 *
 * Bundling routes a relation along the HIERARCHY, and two disks share no
 * hierarchy — there is nothing to bundle along, and a Holten rope between two
 * unrelated roots reads as a detour rather than as a relation. A single bowed
 * curve says "these two wedges are connected" and nothing else, which is exactly
 * the claim being made. Intra-disk edges keep their bundling untouched.
 *
 * The bow is perpendicular to the chord and always to the same side, so two
 * relations in opposite directions between the same pair of wedges do not
 * overdraw each other into one line.
 */
export function crossDiskCurve(
  from: Point,
  to: Point,
  bow = CROSS_EDGE_BOW,
  samples = CROSS_EDGE_SAMPLES
): Point[] {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const control = {
    x: (from.x + to.x) / 2 - dy * bow,
    y: (from.y + to.y) / 2 + dx * bow,
  };
  const out: Point[] = [];
  for (let index = 0; index <= samples; index++) {
    const t = index / samples;
    const inverse = 1 - t;
    out.push({
      x: inverse * inverse * from.x + 2 * inverse * t * control.x + t * t * to.x,
      y: inverse * inverse * from.y + 2 * inverse * t * control.y + t * t * to.y,
    });
  }
  return out;
}
