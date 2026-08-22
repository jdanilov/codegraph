/**
 * Hierarchical edge bundling (Holten).
 *
 * A relation is not drawn as a straight chord across the disk — it is routed
 * along the **hierarchy**: from the source arc inward through its ancestors to
 * the deepest ancestor the two endpoints share, then back out to the target
 * arc. Those ancestor centroids are the control points of a cubic B-spline, and
 * a straightening factor β pulls the curve back toward the straight line:
 * β = 1 hugs the hierarchy exactly, β = 0 is a straight chord. Bundled edges
 * share their inner segments, so a hundred relations between two directories
 * read as one rope instead of a hundred crossing lines.
 *
 * The spline is evaluated here rather than handed to a drawing library because
 * we need the SAMPLED POINTS anyway: the edge tooltip hit-tests against them,
 * and drawing a polyline through the same points guarantees the two agree.
 */
import { arcCentroid, type Point, type SunburstArc, type SunburstLayout } from './sunburst';

/** Straightening factor. 0.85 keeps the hierarchy legible without spaghetti. */
export const BUNDLE_BETA = 0.85;

/** Samples per B-spline segment — enough for a smooth 300px curve. */
const SAMPLES_PER_SEGMENT = 8;

const CENTRE: Point = { x: 0, y: 0 };

/**
 * Arc → centre chain, nearest first: `[arc, parent, …, outermost ancestor]`.
 * The centre itself is implicit and appended by {@link bundleControlPoints}.
 */
function chainOf(arc: SunburstArc | null, layout: SunburstLayout): SunburstArc[] {
  const out: SunburstArc[] = [];
  let current = arc;
  let guard = 0;
  while (current && guard++ < 64) {
    out.push(current);
    current = current.parentKey ? (layout.byKey.get(current.parentKey) ?? null) : null;
  }
  return out;
}

/**
 * Control points for one edge: up the hierarchy from `from`, through the
 * deepest common ancestor, back down to `to`.
 *
 * `null` means "the centre disk" — the current root, which is where an edge
 * that leaves the rendered subtree ends up.
 */
export function bundleControlPoints(
  from: SunburstArc | null,
  to: SunburstArc | null,
  layout: SunburstLayout
): Point[] {
  if (from && to && from.key === to.key) return [];

  const fromChain = chainOf(from, layout);
  const toChain = chainOf(to, layout);
  const toIndex = new Map<string, number>();
  toChain.forEach((arc, index) => toIndex.set(arc.key, index));

  let meetFrom = -1;
  let meetTo = -1;
  for (let i = 0; i < fromChain.length; i++) {
    const index = toIndex.get(fromChain[i]!.key);
    if (index !== undefined) {
      meetFrom = i;
      meetTo = index;
      break;
    }
  }

  const points: Point[] = [];
  if (meetFrom === -1) {
    // No shared arc: the two branches only meet at the centre.
    for (const arc of fromChain) points.push(arcCentroid(arc));
    points.push(CENTRE);
    for (let i = toChain.length - 1; i >= 0; i--) points.push(arcCentroid(toChain[i]!));
  } else {
    for (let i = 0; i <= meetFrom; i++) points.push(arcCentroid(fromChain[i]!));
    for (let i = meetTo - 1; i >= 0; i--) points.push(arcCentroid(toChain[i]!));
  }
  return points;
}

/**
 * β-straightened cubic B-spline through `points`, sampled.
 *
 * Endpoints are tripled so the curve starts and ends exactly on the two arcs
 * (a plain uniform B-spline would only approach them).
 */
export function bundleCurve(points: Point[], beta = BUNDLE_BETA): Point[] {
  if (points.length < 2) return [];
  if (points.length === 2) return [points[0]!, points[1]!];

  const first = points[0]!;
  const last = points[points.length - 1]!;
  const span = points.length - 1;
  const adjusted: Point[] = points.map((point, index) => {
    const t = index / span;
    return {
      x: beta * point.x + (1 - beta) * (first.x + t * (last.x - first.x)),
      y: beta * point.y + (1 - beta) * (first.y + t * (last.y - first.y)),
    };
  });

  const control: Point[] = [
    adjusted[0]!,
    adjusted[0]!,
    ...adjusted,
    adjusted[adjusted.length - 1]!,
    adjusted[adjusted.length - 1]!,
  ];

  const out: Point[] = [];
  for (let i = 0; i + 3 < control.length; i++) {
    const p0 = control[i]!;
    const p1 = control[i + 1]!;
    const p2 = control[i + 2]!;
    const p3 = control[i + 3]!;
    // Every segment but the first skips t=0: it is the previous segment's t=1.
    for (let step = i === 0 ? 0 : 1; step <= SAMPLES_PER_SEGMENT; step++) {
      const t = step / SAMPLES_PER_SEGMENT;
      out.push(basisPoint(p0, p1, p2, p3, t));
    }
  }
  return out;
}

/** Uniform cubic B-spline basis at `t` over four control points. */
function basisPoint(p0: Point, p1: Point, p2: Point, p3: Point, t: number): Point {
  const t2 = t * t;
  const t3 = t2 * t;
  const b0 = (1 - 3 * t + 3 * t2 - t3) / 6;
  const b1 = (4 - 6 * t2 + 3 * t3) / 6;
  const b2 = (1 + 3 * t + 3 * t2 - 3 * t3) / 6;
  const b3 = t3 / 6;
  return {
    x: b0 * p0.x + b1 * p1.x + b2 * p2.x + b3 * p3.x,
    y: b0 * p0.y + b1 * p1.y + b2 * p2.y + b3 * p3.y,
  };
}

/** Squared distance from `(x, y)` to the polyline — the edge hit test. */
export function distanceToPolyline(points: Point[], x: number, y: number): number {
  let best = Number.POSITIVE_INFINITY;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const lengthSquared = dx * dx + dy * dy;
    let t = 0;
    if (lengthSquared > 0) {
      t = ((x - a.x) * dx + (y - a.y) * dy) / lengthSquared;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
    }
    const px = a.x + t * dx - x;
    const py = a.y + t * dy - y;
    const distance = px * px + py * py;
    if (distance < best) best = distance;
  }
  return Math.sqrt(best);
}
