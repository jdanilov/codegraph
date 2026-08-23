/**
 * `POST /api/explore` — the structured half of `codegraph_explore`.
 *
 * The UI does **not** re-implement explore. It runs the very same handler the
 * MCP tool runs and reads the structured result the handler collects alongside
 * its markdown (see `src/mcp/explore-structured.ts`): same ranking, same flow
 * spine, same symbols — one implementation, two renderings. The agent-facing
 * text is untouched by this path; the collector is opt-in and read-only.
 *
 * The handler is cached per open CodeGraph instance. An index run closes and
 * reopens the graph, so the cache is keyed on the instance itself rather than
 * on the root — a stale handler would keep querying a closed database.
 */
import type CodeGraphType from '../index';
import type { ExploreStructuredResult } from '../mcp/explore-structured';
import {
  EXPLORE_STRUCTURED_ARG,
  EXPLORE_STRUCTURED_KEY,
} from '../mcp/explore-structured';

/** An explore answer with nothing in it — the shape a stub/error also carries. */
export const EMPTY_EXPLORE: ExploreStructuredResult = {
  nodeIds: [],
  edgeRefs: [],
  flow: [],
  summary: '',
  symbolCount: 0,
  fileCount: 0,
};

export type ExploreOutcome =
  | { ok: true; result: ExploreStructuredResult }
  | { ok: false; reason: 'not_indexed' | 'failed'; message: string };

interface HandlerLike {
  executeReadTool(
    toolName: string,
    args: Record<string, unknown>
  ): Promise<{
    content: Array<{ type: 'text'; text: string }>;
    isError?: boolean;
    [key: string]: unknown;
  }>;
}

let cache: { graph: CodeGraphType; handler: HandlerLike } | null = null;

/** The tool handler bound to this graph instance, created on first use. */
async function handlerFor(graph: CodeGraphType): Promise<HandlerLike> {
  if (cache && cache.graph === graph) return cache.handler;
  const { ToolHandler } = await import('../mcp/tools');
  const handler = new ToolHandler(graph) as unknown as HandlerLike;
  cache = { graph, handler };
  return handler;
}

/** Drop the cached handler (called when the server releases the database). */
export function resetExploreHandler(): void {
  cache = null;
}

/**
 * Run one explore over `graph` and return its structured result.
 *
 * `scopePath` is the optional subtree scope (`src/mcp`, `packages/api/**`) —
 * the same `path` argument the MCP tool takes. An unusable scope comes back as
 * the tool's SUCCESS-shaped guidance, i.e. an empty result whose `summary`
 * explains how to spell it.
 *
 * `executeReadTool` is the dispatch entry point that classifies expected
 * failures itself — an un-indexed project or a missing symbol comes back as a
 * SUCCESS-shaped answer, never a throw, which is exactly the shape this route
 * wants too.
 */
export async function runExplore(
  graph: CodeGraphType,
  query: string,
  scopePath?: string
): Promise<ExploreOutcome> {
  const trimmed = query.trim();
  if (!trimmed) return { ok: true, result: { ...EMPTY_EXPLORE } };

  const scope = typeof scopePath === 'string' ? scopePath.trim() : '';
  try {
    const handler = await handlerFor(graph);
    const result = await handler.executeReadTool('codegraph_explore', {
      query: trimmed,
      // Additive and optional: with no scope the args are exactly what they
      // were before, so the unscoped path is unchanged.
      ...(scope ? { path: scope } : {}),
      [EXPLORE_STRUCTURED_ARG]: true,
    });
    if (result.isError) {
      return { ok: false, reason: 'failed', message: textOf(result) };
    }
    const structured = result[EXPLORE_STRUCTURED_KEY] as ExploreStructuredResult | undefined;
    if (!structured) {
      // No structured payload means the handler answered with guidance rather
      // than a real exploration (e.g. "this project isn't indexed"). That is a
      // legitimate answer, so it is carried in `summary` rather than thrown.
      return { ok: true, result: { ...EMPTY_EXPLORE, summary: firstLine(textOf(result)) } };
    }
    return { ok: true, result: structured };
  } catch (err) {
    return {
      ok: false,
      reason: 'failed',
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

function textOf(result: { content: Array<{ text: string }> }): string {
  return result.content.map((block) => block.text).join('\n');
}

function firstLine(text: string): string {
  const line = text.split('\n').find((candidate) => candidate.trim().length > 0);
  return (line ?? '').trim().slice(0, 400);
}
