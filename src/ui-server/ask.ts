/**
 * `POST /api/ask` — the optional LLM refinement in front of explore.
 *
 * The question box has a floor and a ceiling. The floor is `POST /api/explore`:
 * raw text straight into the graph, deterministic, always available. The
 * ceiling is this route — the model turns a sentence into the bag of symbol
 * names explore is precise with ("how does saving an item reach the database"
 * → `saveItem ItemStore persist upsert`), and the SAME explore then answers it.
 * The model never sees the code and never invents an answer: it only rewrites
 * the query, so a bad rewrite degrades to a worse search, never to a wrong
 * claim about the codebase.
 *
 * No SDK and no new dependency — one `fetch` to the Messages API. The key comes
 * from `~/.codegraph/ui.json`; with none configured the route answers the
 * contract's 501 stub instead of failing.
 */
import type CodeGraphType from '../index';
import type { ExploreStructuredResult } from '../mcp/explore-structured';
import { readSettings } from './settings';

/** Model used when the user hasn't chosen one. */
export const DEFAULT_ASK_MODEL = 'claude-sonnet-5';

/** The Messages API endpoint and the version header it requires. */
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';

/** Hard timeout on the model call — the UI must never hang on it. */
export const ASK_TIMEOUT_MS = 25_000;

/** Room for the answer; adaptive-thinking models spend part of it thinking. */
const ASK_MAX_TOKENS = 2048;

/** Index symbols offered to the model as spelling hints. */
const MAX_HINTS = 40;

/** Symbol names kept from the model's answer (explore's own token cap is 16). */
const MAX_BAG_TOKENS = 16;

const SYSTEM_PROMPT = [
  'You convert a developer question about a codebase into a search query for a code knowledge graph.',
  'Answer with ONLY a space-separated bag of likely symbol identifiers — function, method, class, type,',
  'component or file names — spanning the whole flow the question asks about (its start, its middle and',
  'its end). Prefer names from the candidate list when they fit; add plausible identifiers in the',
  "codebase's own naming style when they do not. Qualified names like ClassName.methodName are welcome.",
  'No prose, no punctuation, no explanation, no code fences. At most 12 names.',
].join(' ');

export type AskOutcome =
  | { ok: true; symbolBag: string }
  | { ok: false; reason: 'no_key'; message: string }
  | { ok: false; reason: 'failed'; message: string };

/** The `/api/ask` response body: an explore result plus the bag that produced it. */
export interface AskPayload extends ExploreStructuredResult {
  symbolBag: string;
}

/** True when a key is configured — the client offers "refine with AI" only then. */
export function askConfigured(): boolean {
  return Boolean(readSettings().anthropicApiKey);
}

/**
 * Turn a question into a symbol bag with the configured model.
 *
 * Every failure mode (no key, timeout, HTTP error, unparseable answer) returns
 * a typed outcome rather than throwing, because the caller's job is to fall
 * back to the deterministic path, not to show a stack trace.
 */
export async function askForSymbolBag(
  question: string,
  graph: CodeGraphType | null
): Promise<AskOutcome> {
  const trimmed = question.trim();
  if (!trimmed) return { ok: false, reason: 'failed', message: 'Empty question' };

  const settings = readSettings();
  const apiKey = settings.anthropicApiKey;
  if (!apiKey) {
    return {
      ok: false,
      reason: 'no_key',
      message: 'No Anthropic API key configured. Add one in settings, or use explore directly.',
    };
  }

  const hints = collectHints(trimmed, graph);
  const userMessage = [
    `Question: ${trimmed}`,
    hints.length > 0 ? `Candidate symbols found in the index: ${hints.join(' ')}` : '',
    'Symbol bag:',
  ]
    .filter(Boolean)
    .join('\n\n');

  let response: Response;
  try {
    response = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
      },
      body: JSON.stringify({
        model: settings.model || DEFAULT_ASK_MODEL,
        max_tokens: ASK_MAX_TOKENS,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userMessage }],
      }),
      signal: AbortSignal.timeout(ASK_TIMEOUT_MS),
    });
  } catch (err) {
    const aborted = err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
    return {
      ok: false,
      reason: 'failed',
      message: aborted
        ? `The model did not answer within ${Math.round(ASK_TIMEOUT_MS / 1000)}s.`
        : `Could not reach the Anthropic API: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (!response.ok) {
    return { ok: false, reason: 'failed', message: await describeHttpError(response) };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { ok: false, reason: 'failed', message: 'The Anthropic API returned a malformed response.' };
  }

  const bag = symbolBagFrom(body);
  if (!bag) {
    return { ok: false, reason: 'failed', message: 'The model returned no usable symbol names.' };
  }
  return { ok: true, symbolBag: bag };
}

/**
 * Spelling hints: an FTS pass over the question's content words, so the model
 * proposes names that actually exist rather than guessing at conventions. Pure
 * suggestion — the model is free to ignore them.
 */
function collectHints(question: string, graph: CodeGraphType | null): string[] {
  if (!graph) return [];
  const words = [
    ...new Set(
      question
        .toLowerCase()
        .split(/[^A-Za-z0-9_$]+/)
        .filter((word) => word.length >= 3 && !STOP_WORDS.has(word))
    ),
  ].slice(0, 8);
  if (words.length === 0) return [];

  const names = new Set<string>();
  for (const word of words) {
    if (names.size >= MAX_HINTS) break;
    try {
      for (const hit of graph.searchNodes(word, { limit: 8 })) {
        const name = hit.node.qualifiedName || hit.node.name;
        if (name) names.add(name);
        if (names.size >= MAX_HINTS) break;
      }
    } catch {
      /* a word FTS can't tokenize simply contributes no hints */
    }
  }
  return [...names];
}

/** Pull the text blocks out of a Messages response and normalize them to a bag. */
function symbolBagFrom(body: unknown): string {
  const content = (body as { content?: Array<{ type?: string; text?: string }> } | null)?.content;
  if (!Array.isArray(content)) return '';
  const text = content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string)
    .join(' ');
  return normalizeSymbolBag(text);
}

/**
 * Keep only identifier-shaped tokens. The model is asked for exactly that, but
 * a stray "Symbol bag:" prefix or a trailing period must never reach explore's
 * tokenizer — and this is also what makes an unexpected prose answer harmless.
 */
export function normalizeSymbolBag(text: string): string {
  const tokens: string[] = [];
  const seen = new Set<string>();
  for (const raw of text.split(/[\s,;`'"()[\]{}]+/)) {
    const token = raw.replace(/[.:]+$/, '').trim();
    if (!token || token.length < 2 || token.length > 80) continue;
    if (!/^[A-Za-z_$][\w$]*(?:(?:::|\.|\/)[\w$.-]+)*$/.test(token)) continue;
    const key = token.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    tokens.push(token);
    if (tokens.length >= MAX_BAG_TOKENS) break;
  }
  return tokens.join(' ');
}

async function describeHttpError(response: Response): Promise<string> {
  let detail = '';
  try {
    const body = (await response.json()) as { error?: { message?: string } };
    detail = body?.error?.message ?? '';
  } catch {
    /* a non-JSON error body is fine — the status alone is the message */
  }
  if (response.status === 401 || response.status === 403) {
    return `The Anthropic API rejected the configured key (${response.status}). ${detail}`.trim();
  }
  if (response.status === 429) {
    return `The Anthropic API is rate-limiting this key (429). ${detail}`.trim();
  }
  return `The Anthropic API returned ${response.status}. ${detail}`.trim();
}

/** Question words that would only pull noise out of the index. */
const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'what', 'when', 'where', 'which', 'how',
  'does', 'did', 'are', 'was', 'were', 'has', 'have', 'had', 'can', 'get', 'got', 'into', 'out',
  'its', 'his', 'her', 'their', 'our', 'your', 'you', 'code', 'file', 'files', 'happens', 'happen',
  'why', 'who', 'all', 'any', 'not', 'but', 'use', 'used', 'uses', 'via', 'end', 'run', 'runs',
]);
