/**
 * Structured side-channel for `codegraph_explore`.
 *
 * The visualizer needs the SAME answer the MCP tool computes — the flow spine,
 * the symbols it surfaced, the edges among them — but as data rather than
 * markdown. Re-implementing the ranking would be a second, silently diverging
 * explore, so the tool handler instead COLLECTS this alongside the text it was
 * already assembling and hands it back on the result object.
 *
 * Two rules keep the agent-facing path byte-identical (it is the product's
 * primary tool and many tests pin its output):
 *
 *  - collection is **opt-in**, via {@link EXPLORE_STRUCTURED_ARG} on the call
 *    args — the MCP server never sets it, so nothing is computed for an agent;
 *  - it only ever READS what the render already decided (which files survived,
 *    which nodes are in them, the flow spine). It must never feed back into
 *    rendering.
 *
 * The result rides the {@link ToolResult} under {@link EXPLORE_STRUCTURED_KEY},
 * exactly like the session-emission record does, so it survives a
 * structured-clone hop through the query worker.
 */

/** Opt-in flag on the call args: collect the structured result for this call. */
export const EXPLORE_STRUCTURED_ARG = '_cgExploreStructuredRequest';

/** Property the structured result is attached to on the ToolResult. */
export const EXPLORE_STRUCTURED_KEY = '_cgExploreStructured';

/** One graph edge, referenced the way `GET /api/graph` spells them. */
export interface ExploreEdgeRef {
  source: string;
  target: string;
  kind: string;
  provenance?: string;
  synthesizedBy?: string;
}

/** One hop of the Flow section: `from` calls `to` via `via`. */
export interface ExploreFlowHop {
  from: string;
  to: string;
  /** `metadata.synthesizedBy` for a synthesized hop, else the edge kind. */
  via: string;
}

/** The structured twin of an explore response. */
export interface ExploreStructuredResult {
  /** Node ids the response surfaced, flow spine first. */
  nodeIds: string[];
  /** Edges among those nodes, for highlighting. */
  edgeRefs: ExploreEdgeRef[];
  /** The Flow section's path, hop by hop (empty when it found no chain). */
  flow: ExploreFlowHop[];
  /** Short plain-text digest — the counts below, plus the flow. */
  summary: string;
  /**
   * The two numbers `summary` quotes, and they are derived from `nodeIds`:
   * `symbolCount` IS `nodeIds.length`, `fileCount` the distinct files those
   * ids live in.
   *
   * The markdown response counts something subtly different — the symbols of
   * the files whose SOURCE survived its byte budget — which is right for a
   * reader of that text and wrong for a client rendering the id list, since
   * the list also carries the flow spine (a hop can land in a file whose
   * source didn't survive) and is capped at {@link STRUCTURED_MAX_NODES}.
   * Reusing the markdown's sentence made a client show 99 rows under "Found 98
   * symbols across 7 files". These counts describe the payload the client
   * actually got.
   */
  symbolCount: number;
  fileCount: number;
}

/** Most node ids a structured result carries (a whole-repo query is bounded). */
export const STRUCTURED_MAX_NODES = 600;

/** Most edges a structured result carries. */
export const STRUCTURED_MAX_EDGES = 1200;
