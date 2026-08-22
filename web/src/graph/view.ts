/**
 * Which slice of the model is mounted in sigma.
 *
 * The renderer budget is ≤2k nodes (contract) while the model can hold 15k+, so
 * this module is the gate. It turns the user's *expansion set* into two lists:
 *
 *   - **primaries** — nodes drawn at full size, force-laid to the RIGHT of
 *     their parent. Produced by walking the backbone from the root and
 *     descending only into expanded nodes.
 *   - **satellites** — the immediate children of a mounted-but-collapsed node,
 *     drawn small and hugging it (the atom/nucleus of the visual language).
 *     Satellites never recurse: a satellite's own children stay unmounted.
 *
 * Everything is bounded twice over — a global budget and a per-parent satellite
 * cap — so a directory with 900 files cannot blow the frame budget. What was
 * dropped is reported back so the node label can say `+37`.
 */
import { GraphModel, ROOT_ID } from './model';

/** Hard ceiling on mounted sigma nodes (contract: ≤2k). */
export const MOUNT_BUDGET = 2000;

/** Of that budget, at most this many are full-size, force-laid nodes. */
const PRIMARY_BUDGET = 1200;

/** Satellites drawn around a single collapsed parent before eliding. */
const SATELLITE_CAP = 28;

export interface MountedNode {
  id: string;
  /** Small circle hugging `parentId`, rather than a force-laid node. */
  satellite: boolean;
  /** Mounted parent — always a primary. Null only for the root. */
  parentId: string | null;
  /** Index among the mounted siblings (drives A-top → Z-bottom order). */
  order: number;
  /** How many mounted siblings there are, including this one. */
  siblingCount: number;
  /** Children that exist in the model but were not mounted. */
  hiddenChildren: number;
  expanded: boolean;
}

export interface MountedView {
  nodes: MountedNode[];
  byId: Map<string, MountedNode>;
  /** True when the budget (not the expansion set) capped what is on screen. */
  truncated: boolean;
}

/**
 * Resolve `expanded` against the model. `expanded` may name ids that no longer
 * exist (after a re-index) — they are simply ignored.
 */
export function computeMountedView(model: GraphModel, expanded: ReadonlySet<string>): MountedView {
  const nodes: MountedNode[] = [];
  const byId = new Map<string, MountedNode>();
  let truncated = false;

  const root = model.get(ROOT_ID);
  if (!root) return { nodes, byId, truncated };

  const push = (node: MountedNode): void => {
    nodes.push(node);
    byId.set(node.id, node);
  };

  push({
    id: ROOT_ID,
    satellite: false,
    parentId: null,
    order: 0,
    siblingCount: 1,
    hiddenChildren: 0,
    expanded: expanded.has(ROOT_ID),
  });

  // Breadth-first so a shallow, wide expansion is never starved by a deep one.
  const queue: string[] = [ROOT_ID];
  const collapsedPrimaries: string[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    const children = model.childrenOf(id);
    if (children.length === 0) continue;
    if (!expanded.has(id)) {
      collapsedPrimaries.push(id);
      continue;
    }
    const room = PRIMARY_BUDGET - nodes.length;
    if (room <= 0) {
      truncated = true;
      collapsedPrimaries.push(id);
      continue;
    }
    const mounted = children.slice(0, room);
    if (mounted.length < children.length) truncated = true;
    const parentEntry = byId.get(id)!;
    parentEntry.hiddenChildren = children.length - mounted.length;
    mounted.forEach((child, index) => {
      push({
        id: child,
        satellite: false,
        parentId: id,
        order: index,
        siblingCount: mounted.length,
        hiddenChildren: 0,
        expanded: expanded.has(child),
      });
      queue.push(child);
    });
  }

  // Satellites fill whatever is left, spread evenly rather than first-come, so
  // one enormous directory can't consume the whole remaining budget.
  let remaining = MOUNT_BUDGET - nodes.length;
  const plans = collapsedPrimaries
    .map((id) => ({ id, children: model.childrenOf(id) }))
    .filter((plan) => plan.children.length > 0);
  const fairShare =
    plans.length > 0 ? Math.max(1, Math.floor(remaining / plans.length)) : SATELLITE_CAP;

  for (const plan of plans) {
    if (remaining <= 0) {
      byId.get(plan.id)!.hiddenChildren = plan.children.length;
      truncated = true;
      continue;
    }
    const take = Math.min(plan.children.length, SATELLITE_CAP, fairShare, remaining);
    const mounted = plan.children.slice(0, take);
    byId.get(plan.id)!.hiddenChildren = plan.children.length - mounted.length;
    if (mounted.length < plan.children.length) truncated = true;
    mounted.forEach((child, index) => {
      push({
        id: child,
        satellite: true,
        parentId: plan.id,
        order: index,
        siblingCount: mounted.length,
        hiddenChildren: 0,
        expanded: false,
      });
    });
    remaining -= mounted.length;
  }

  return { nodes, byId, truncated };
}

/**
 * Shift+click semantics.
 *
 * Expanding a node that is currently a *satellite* also expands its parent —
 * without that the node would have nowhere to put its own children, and the
 * click would look like it did nothing. Collapsing drops the whole subtree from
 * the expansion set so re-expanding later starts from a clean, shallow state.
 */
export function toggleExpansion(
  model: GraphModel,
  expanded: ReadonlySet<string>,
  id: string
): Set<string> {
  const next = new Set(expanded);
  if (model.childrenOf(id).length === 0) return next;
  if (next.has(id)) {
    next.delete(id);
    for (const descendant of model.descendants(id)) next.delete(descendant);
    return next;
  }
  next.add(id);
  for (const ancestor of model.ancestors(id)) next.add(ancestor);
  return next;
}

/** The initial view: root expanded, every top-level directory collapsed. */
export function initialExpansion(model: GraphModel): Set<string> {
  return model.childrenOf(ROOT_ID).length > 0 ? new Set([ROOT_ID]) : new Set<string>();
}
