/**
 * The visualizer's HTTP API. One hand-rolled router, no framework, no runtime
 * dependencies — see `docs/design/visualizer.md` for the endpoint contract.
 *
 * Two rules run through everything here:
 *   - An un-indexed project is a NORMAL state, not an error: routes answer with
 *     an empty, correctly-shaped payload so the UI can render its "index now"
 *     screen instead of an error toast.
 *   - Endpoints the contract defines but a later phase implements answer 501
 *     with the contract's own shape, so a client written against the final API
 *     can read the stub without special-casing it.
 */
import type { IncomingMessage, ServerResponse } from 'http';
import { unsafeIndexRootReason } from '../directory';
import { validatePathWithinRoot } from '../utils';
import type { Node } from '../types';
import { askForSymbolBag } from './ask';
import { readCards, writeCards, isCard, type Card } from './cards';
import { collectChanges, EMPTY_CHANGES } from './changes';
import { EMPTY_EXPLORE, runExplore } from './explore';
import { launchEditor } from './editor';
import {
  buildGraphPayload,
  emptyGraphPayload,
  layerOf,
  layerVocabulary,
  type GraphEdge,
} from './graph-payload';
import {
  BodyTooLargeError,
  intParam,
  queryParam,
  readJsonBody,
  sendError,
  sendJson,
  sendJsonRaw,
  sendNotImplemented,
} from './http';
import { initProject, runIndexSubprocess, type IndexEvent } from './indexer';
import { readSourceDiff } from './diff';
import { readSourceSpan } from './source';
import { mergeSettings, readSettings, settingsView, writeSettings } from './settings';
import type { UiServerState } from './state';

/** Most search hits returned by `/api/search` (contract: ≤50). */
const SEARCH_LIMIT = 50;

/** Most edges returned per direction in the node info panel. */
const NODE_EDGE_LIMIT = 200;

export class ApiRouter {
  private readonly state: UiServerState;
  /** Serialized `/api/graph` body, valid for one `dataVersion`. */
  private graphCache: { version: number; body: string } | null = null;

  constructor(state: UiServerState) {
    this.state = state;
  }

  /** Dispatch one `/api/...` request. Always answers (never leaves it hanging). */
  async handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const method = req.method ?? 'GET';
    const route = url.pathname;

    try {
      if (route === '/api/status') return await this.get(method, res, () => this.status(res));
      if (route === '/api/graph') return await this.get(method, res, () => this.graph(req, res));
      if (route.startsWith('/api/node/')) {
        const id = decodeURIComponent(route.slice('/api/node/'.length));
        return await this.get(method, res, () => this.node(res, id));
      }
      if (route === '/api/source') return await this.get(method, res, () => this.source(res, url));
      if (route === '/api/search') return await this.get(method, res, () => this.search(res, url));

      if (route === '/api/cards') {
        if (method === 'GET') return this.getCards(res);
        if (method === 'PUT') return await this.putCards(req, res);
        return methodNotAllowed(res, 'GET, PUT');
      }

      if (route === '/api/settings') {
        if (method === 'GET') return this.getSettings(res);
        if (method === 'PUT') return await this.putSettings(req, res);
        return methodNotAllowed(res, 'GET, PUT');
      }

      if (route === '/api/index') {
        if (method !== 'POST') return methodNotAllowed(res, 'POST');
        return await this.index(res);
      }

      if (route === '/api/open') {
        if (method !== 'POST') return methodNotAllowed(res, 'POST');
        return await this.open(req, res);
      }

      if (route === '/api/explore') {
        if (method !== 'POST') return methodNotAllowed(res, 'POST');
        return await this.explore(req, res);
      }
      if (route === '/api/ask') {
        if (method !== 'POST') return methodNotAllowed(res, 'POST');
        return await this.ask(req, res);
      }
      if (route === '/api/changes') {
        if (method !== 'GET') return methodNotAllowed(res, 'GET');
        return await this.changes(res);
      }

      return sendError(res, 404, { code: 'not_found', message: `No such endpoint: ${route}` });
    } catch (err) {
      if (err instanceof BodyTooLargeError) {
        return sendError(res, 413, { code: 'payload_too_large', message: err.message });
      }
      return sendError(res, 500, {
        code: 'internal',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Run a GET-only handler, rejecting other methods uniformly. */
  private async get(
    method: string,
    res: ServerResponse,
    handler: () => void | Promise<void>
  ): Promise<void> {
    if (method !== 'GET' && method !== 'HEAD') return methodNotAllowed(res, 'GET');
    await handler();
  }

  // ---------------------------------------------------------------- status --

  private async status(res: ServerResponse): Promise<void> {
    sendJson(res, 200, await this.state.status());
  }

  // ----------------------------------------------------------------- graph --

  private async graph(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const version = this.state.dataVersion();
    const etag = `W/"v${version}"`;

    // The graph only changes when dataVersion does, so a matching ETag is a
    // guaranteed-correct 304 — that is what makes polling cheap.
    const ifNoneMatch = req.headers['if-none-match'];
    if (ifNoneMatch && ifNoneMatch.split(',').some((tag) => tag.trim() === etag)) {
      res.writeHead(304, { ETag: etag, 'Cache-Control': 'no-cache' });
      res.end();
      return;
    }

    if (!this.graphCache || this.graphCache.version !== version) {
      const graph = await this.state.graphOrNull();
      const payload = graph
        ? buildGraphPayload(
            graph.getDatabase().getDb(),
            this.state.projectRoot,
            this.state.projectName,
            version
          )
        : emptyGraphPayload(this.state.projectRoot, this.state.projectName, version);
      this.graphCache = { version, body: JSON.stringify(payload) };
    }

    sendJsonRaw(res, 200, this.graphCache.body, { ETag: etag, 'Cache-Control': 'no-cache' });
  }

  // ------------------------------------------------------------------ node --

  private async node(res: ServerResponse, id: string): Promise<void> {
    const graph = await this.state.graphOrNull();
    if (!graph) return notIndexed(res);

    const node = graph.getNode(id);
    if (!node) {
      return sendError(res, 404, { code: 'not_found', message: `No node with id ${id}` });
    }

    const vocabulary = layerVocabulary(this.state.projectRoot);
    const describe = (target: Node) => ({
      id: target.id,
      kind: target.kind,
      name: target.name,
      qualifiedName: target.qualifiedName,
      file: target.filePath,
      startLine: target.startLine,
      endLine: target.endLine,
    });

    const relate = (edge: {
      source: string;
      target: string;
      kind: string;
      line?: number;
      provenance?: string;
      metadata?: Record<string, unknown>;
    }, direction: 'in' | 'out') => {
      const otherId = direction === 'in' ? edge.source : edge.target;
      const other = graph.getNode(otherId);
      const shaped: GraphEdge & { node: ReturnType<typeof describe> | null } = {
        source: edge.source,
        target: edge.target,
        kind: edge.kind,
        node: other ? describe(other) : null,
      };
      if (edge.provenance) shaped.provenance = edge.provenance;
      if (edge.line !== undefined) shaped.line = edge.line;
      const meta = edge.metadata;
      if (meta) {
        if (typeof meta['synthesizedBy'] === 'string') shaped.synthesizedBy = meta['synthesizedBy'];
        if (typeof meta['registeredAt'] === 'string') shaped.registeredAt = meta['registeredAt'];
      }
      return shaped;
    };

    const outgoing = graph
      .getOutgoingEdges(id)
      .filter((edge) => edge.kind !== 'contains')
      .slice(0, NODE_EDGE_LIMIT)
      .map((edge) => relate(edge, 'out'));
    const incoming = graph
      .getIncomingEdges(id)
      .filter((edge) => edge.kind !== 'contains')
      .slice(0, NODE_EDGE_LIMIT)
      .map((edge) => relate(edge, 'in'));

    const parent = graph
      .getIncomingEdges(id)
      .find((edge) => edge.kind === 'contains');

    const source = readSourceSpan(
      this.state.projectRoot,
      node.filePath,
      node.startLine,
      node.endLine
    );

    const layer = layerOf(node.filePath, vocabulary);

    sendJson(res, 200, {
      node: {
        ...describe(node),
        language: node.language,
        signature: node.signature ?? null,
        docstring: node.docstring ?? null,
        visibility: node.visibility ?? null,
        isExported: Boolean(node.isExported),
        parent: parent?.source ?? null,
        ...(layer ? { layer } : {}),
      },
      contains: graph.getChildren(id).map(describe),
      outgoing,
      incoming,
      source: source.ok ? source.span : null,
    });
  }

  // ---------------------------------------------------------------- source --

  private source(res: ServerResponse, url: URL): void {
    const file = queryParam(url, 'file');
    if (!file) {
      return sendError(res, 400, { code: 'bad_request', message: 'Missing "file" parameter' });
    }
    const mode = queryParam(url, 'mode') ?? 'full';
    if (mode !== 'full' && mode !== 'diff') {
      return sendError(res, 400, { code: 'bad_request', message: `Unknown mode: ${mode}` });
    }

    const start = queryParam(url, 'start') === undefined ? undefined : intParam(url, 'start', 1);
    const end = queryParam(url, 'end') === undefined ? undefined : intParam(url, 'end', 0);
    if (mode === 'diff') return this.sourceDiff(res, file, start, end);

    const result = readSourceSpan(this.state.projectRoot, file, start, end);
    if (result.ok) return sendJson(res, 200, result.span);

    switch (result.reason) {
      case 'outside_root':
        return sendError(res, 403, {
          code: 'forbidden',
          message: 'Path resolves outside the project root',
        });
      case 'not_found':
        return sendError(res, 404, { code: 'not_found', message: `No such file: ${file}` });
      case 'too_large':
        return sendError(res, 413, { code: 'payload_too_large', message: 'File is too large to read' });
      default:
        return sendError(res, 500, { code: 'internal', message: result.message });
    }
  }

  /**
   * `mode=diff`: hunks versus `HEAD`, filtered to the requested span.
   *
   * A project that isn't in git answers `409` — but the body still carries the
   * contract's diff shape (with `git: false`), so the client can render "no
   * version control" from the same parse path it uses for a real answer.
   */
  private sourceDiff(
    res: ServerResponse,
    file: string,
    start: number | undefined,
    end: number | undefined
  ): void {
    const result = readSourceDiff(this.state.projectRoot, file, start, end);
    if (result.ok) return sendJson(res, 200, { ...result.diff, git: true });

    switch (result.reason) {
      case 'outside_root':
        return sendError(res, 403, {
          code: 'forbidden',
          message: 'Path resolves outside the project root',
        });
      case 'not_found':
        return sendError(res, 404, { code: 'not_found', message: `No such file: ${file}` });
      case 'not_git':
        return sendError(
          res,
          409,
          { code: 'conflict', message: result.message },
          { file, mode: 'diff', hunks: [], git: false, status: 'unchanged', hunksOutsideSpan: 0 }
        );
      default:
        return sendError(res, 500, { code: 'internal', message: result.message });
    }
  }

  // ---------------------------------------------------------------- search --

  private async search(res: ServerResponse, url: URL): Promise<void> {
    const query = (queryParam(url, 'q') ?? '').trim();
    if (!query) return sendJson(res, 200, []);

    const graph = await this.state.graphOrNull();
    if (!graph) return sendJson(res, 200, []);

    const shape = (node: Node) => ({
      id: node.id,
      name: node.name,
      qualifiedName: node.qualifiedName,
      kind: node.kind,
      file: node.filePath,
    });

    const seen = new Set<string>();
    const results: Array<ReturnType<typeof shape>> = [];
    const push = (node: Node): void => {
      if (seen.has(node.id) || results.length >= SEARCH_LIMIT) return;
      seen.add(node.id);
      results.push(shape(node));
    };

    // Ranked FTS first, then a camel-infix substring sweep for the queries FTS
    // tokenization can't reach (`profileInfo` inside `getProfileInfoV2`).
    for (const hit of graph.searchNodes(query, { limit: SEARCH_LIMIT })) push(hit.node);
    if (results.length < SEARCH_LIMIT) {
      for (const node of graph.getNodesByNameSubstring(query, { limit: SEARCH_LIMIT })) push(node);
    }

    sendJson(res, 200, results);
  }

  // --------------------------------------------------------------- explore --

  /**
   * `POST /api/explore` — the structured twin of the `codegraph_explore` tool
   * (same implementation, different rendering; see `explore.ts`).
   */
  private async explore(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJsonBody<{ query?: unknown; path?: unknown }>(req);
    const query = typeof body?.query === 'string' ? body.query : '';
    // Optional subtree scope, same spelling as the tool's `path` argument.
    const scopePath = typeof body?.path === 'string' ? body.path : undefined;
    if (!query.trim()) {
      return sendError(res, 400, { code: 'bad_request', message: 'Missing "query"' });
    }

    const graph = await this.state.graphOrNull();
    if (!graph) {
      // An un-indexed project is a normal state: answer with the contract's
      // shape and say so in the summary, so the client renders "index first"
      // instead of an error toast.
      return sendJson(res, 200, {
        ...EMPTY_EXPLORE,
        summary: 'This project has not been indexed yet.',
      });
    }

    const outcome = await runExplore(graph, query, scopePath);
    if (!outcome.ok) {
      return sendError(res, 500, { code: 'internal', message: outcome.message }, EMPTY_EXPLORE);
    }
    sendJson(res, 200, outcome.result);
  }

  /**
   * `POST /api/ask` — LLM refinement in front of explore.
   *
   * No key configured is the contract's 501 (with the result shape attached);
   * a model that errors or times out is a 502 with the same shape, because in
   * both cases the client's move is the same: fall back to plain explore.
   */
  private async ask(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJsonBody<{ question?: unknown; path?: unknown }>(req);
    const question = typeof body?.question === 'string' ? body.question : '';
    // Optional subtree scope — the Ask box scopes exactly like the tool does.
    const scopePath = typeof body?.path === 'string' ? body.path : undefined;
    if (!question.trim()) {
      return sendError(res, 400, { code: 'bad_request', message: 'Missing "question"' });
    }

    const graph = await this.state.graphOrNull();
    const outcome = await askForSymbolBag(question, graph);
    if (!outcome.ok) {
      const shape = { ...EMPTY_EXPLORE, symbolBag: '' };
      if (outcome.reason === 'no_key') {
        return sendNotImplemented(res, outcome.message, shape, 'settings');
      }
      return sendError(res, 502, { code: 'internal', message: outcome.message }, shape);
    }

    if (!graph) {
      return sendJson(res, 200, {
        ...EMPTY_EXPLORE,
        summary: 'This project has not been indexed yet.',
        symbolBag: outcome.symbolBag,
      });
    }

    const explored = await runExplore(graph, outcome.symbolBag, scopePath);
    if (!explored.ok) {
      return sendError(
        res,
        500,
        { code: 'internal', message: explored.message },
        { ...EMPTY_EXPLORE, symbolBag: outcome.symbolBag }
      );
    }
    sendJson(res, 200, { ...explored.result, symbolBag: outcome.symbolBag });
  }

  // --------------------------------------------------------------- changes --

  /**
   * `GET /api/changes` — git's uncommitted work mapped onto node spans, plus
   * the impact radius of what changed. A project outside git answers 409 with
   * the full shape (`git: false`), the same pattern `mode=diff` uses.
   */
  private async changes(res: ServerResponse): Promise<void> {
    const graph = await this.state.graphOrNull();
    const outcome = collectChanges(this.state.projectRoot, graph);
    if (outcome.ok) return sendJson(res, 200, outcome.payload);
    return sendError(res, 409, { code: 'conflict', message: outcome.message }, EMPTY_CHANGES);
  }

  // ----------------------------------------------------------------- cards --

  private getCards(res: ServerResponse): void {
    sendJson(res, 200, readCards(this.state.projectRoot));
  }

  private async putCards(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJsonBody<unknown>(req);
    const list = Array.isArray(body) ? body : (body as { cards?: unknown } | null)?.cards;
    if (!Array.isArray(list) || !list.every(isCard)) {
      return sendError(res, 400, {
        code: 'bad_request',
        message: 'Body must be an array of cards, each with a string "id"',
      });
    }
    writeCards(this.state.projectRoot, list as Card[]);
    sendJson(res, 200, list);
  }

  // -------------------------------------------------------------- settings --

  private getSettings(res: ServerResponse): void {
    sendJson(res, 200, settingsView(readSettings()));
  }

  private async putSettings(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJsonBody<Record<string, unknown>>(req);
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return sendError(res, 400, { code: 'bad_request', message: 'Body must be a JSON object' });
    }
    const next = mergeSettings(readSettings(), body);
    writeSettings(next);
    sendJson(res, 200, settingsView(next));
  }

  // ----------------------------------------------------------------- index --

  private async index(res: ServerResponse): Promise<void> {
    if (this.state.isIndexing()) {
      return sendError(res, 409, { code: 'conflict', message: 'An index run is already in progress' });
    }

    const root = this.state.projectRoot;
    const alreadyInitialized = this.state.isIndexed();
    if (!alreadyInitialized) {
      // Same guard the CLI applies: never index a home directory or a
      // filesystem root just because a browser button was clicked.
      const unsafe = unsafeIndexRootReason(root);
      if (unsafe) {
        return sendError(res, 409, {
          code: 'conflict',
          message: `Refusing to index ${root} — it looks like ${unsafe}.`,
        });
      }
    }

    res.writeHead(200, {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-store',
      // Defeat proxy buffering so progress arrives while it happens.
      'X-Accel-Buffering': 'no',
    });
    // A browser that navigates away mid-index kills the socket; the index run
    // itself must finish regardless, so writes to a dead response are dropped.
    const emit = (event: IndexEvent): void => {
      if (res.writableEnded || res.destroyed) return;
      try {
        res.write(JSON.stringify(event) + '\n');
      } catch {
        /* client went away */
      }
    };

    this.state.beginIndexing();
    try {
      if (!alreadyInitialized) {
        emit({ type: 'start', root, step: 'init' });
        await initProject(root);
      }
      emit({ type: 'start', root, step: 'index' });
      await runIndexSubprocess(root, emit);
    } catch (err) {
      emit({ type: 'error', message: err instanceof Error ? err.message : String(err) });
      emit({ type: 'done', code: 1, ok: false });
    } finally {
      this.state.endIndexing();
      this.graphCache = null;
      if (!res.writableEnded) res.end();
    }
  }

  // ------------------------------------------------------------------ open --

  private async open(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await readJsonBody<{ file?: unknown; line?: unknown }>(req);
    const file = typeof body?.file === 'string' ? body.file : '';
    if (!file) {
      return sendError(res, 400, { code: 'bad_request', message: 'Missing "file"' });
    }
    const line = Number(body?.line);
    const safeLine = Number.isFinite(line) && line > 0 ? Math.floor(line) : 1;

    const absolute = validatePathWithinRoot(this.state.projectRoot, file);
    if (!absolute) {
      return sendError(res, 403, {
        code: 'forbidden',
        message: 'Path resolves outside the project root',
      });
    }

    const { editorCommand } = readSettings();
    if (!editorCommand) {
      // 409 is the contract's signal for "no editor configured" — the client
      // falls back to a `vscode://` URL instead of showing an error.
      return sendError(res, 409, {
        code: 'conflict',
        message: 'No editor command configured. Set editorCommand in settings.',
      });
    }

    // The CONFIGURED command wins — `vscode://` is only ever the client's
    // fallback for the 409 above. A command that fails to start is reported as
    // such (502) rather than silently reported as opened: it used to resolve
    // "ok" before the OS had a chance to say ENOENT, so a template naming a
    // shell alias looked like it worked while nothing opened.
    const launched = await launchEditor(editorCommand, absolute, safeLine);
    if (!launched.ok) {
      return sendError(res, 502, { code: 'editor_failed', message: launched.message });
    }
    // Echo the caller's own path, not the resolved one: `validatePathWithinRoot`
    // returns a realpath, which on macOS turns `/tmp/...` into `/private/tmp/...`.
    sendJson(res, 200, { ok: true, file, line: safeLine });
  }
}

function methodNotAllowed(res: ServerResponse, allow: string): void {
  sendError(
    res,
    405,
    { code: 'method_not_allowed', message: `Allowed: ${allow}` },
    { allow }
  );
}

function notIndexed(res: ServerResponse): void {
  sendError(res, 404, {
    code: 'not_indexed',
    message: 'This project has not been indexed yet.',
  });
}
