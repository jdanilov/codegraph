/**
 * The `codegraph ui` server: a local, dependency-free HTTP server that hands
 * the browser the project's knowledge graph.
 *
 * It binds **127.0.0.1 only** and has no authentication, which is exactly why
 * it also refuses non-loopback `Host` headers (DNS-rebinding defence) — the
 * only thing that should be able to reach it is a browser on this machine.
 *
 * Layout: `/api/*` is the JSON API (`routes.ts`); everything else is the built
 * frontend from `dist/ui-web/` with SPA fallback (`static-files.ts`).
 */
import * as http from 'http';
import type { AddressInfo } from 'net';
import { ApiRouter } from './routes';
import { isLoopbackHost, sendError } from './http';
import { UiServerState } from './state';
import { serveStatic } from './static-files';

export { UiServerState } from './state';
export type { UiStatus } from './state';
export type { GraphPayload, GraphNode, GraphEdge, GraphDir } from './graph-payload';
export type { UiSettings, UiSettingsView } from './settings';
export type { Card } from './cards';
export type { IndexEvent } from './indexer';

/** Default port for `codegraph ui`. */
export const DEFAULT_UI_PORT = 4747;

/** Loopback-only bind address. Not configurable on purpose (no auth). */
export const UI_HOST = '127.0.0.1';

export interface UiServerOptions {
  /** Project root to visualize (need not be indexed yet). */
  projectRoot: string;
  /** Port to listen on; 0 picks a free one. */
  port?: number;
}

export interface UiServer {
  /** The URL to open in a browser. */
  url: string;
  /** The port actually bound (differs from the request when 0 was passed). */
  port: number;
  /** Project root being served. */
  projectRoot: string;
  /** Underlying node server, for tests. */
  server: http.Server;
  /** Stop listening and release the database. */
  close(): Promise<void>;
}

/**
 * Start the visualizer server. Resolves once it is listening; rejects if the
 * port is in use (with a message that names the port).
 */
export function startUiServer(options: UiServerOptions): Promise<UiServer> {
  const state = new UiServerState(options.projectRoot);
  const router = new ApiRouter(state);

  const server = http.createServer((req, res) => {
    void handleRequest(router, req, res);
  });

  return new Promise<UiServer>((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException): void => {
      server.removeListener('error', onError);
      if (err.code === 'EADDRINUSE') {
        reject(new Error(`Port ${options.port ?? DEFAULT_UI_PORT} is already in use.`));
        return;
      }
      reject(err);
    };
    server.once('error', onError);

    server.listen(options.port ?? DEFAULT_UI_PORT, UI_HOST, () => {
      server.removeListener('error', onError);
      const address = server.address() as AddressInfo | null;
      const port = address?.port ?? options.port ?? DEFAULT_UI_PORT;
      resolve({
        url: `http://${UI_HOST}:${port}`,
        port,
        projectRoot: state.projectRoot,
        server,
        close: () =>
          new Promise<void>((done) => {
            state.close();
            server.close(() => done());
            server.closeAllConnections?.();
          }),
      });
    });
  });
}

async function handleRequest(
  router: ApiRouter,
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  try {
    if (!isLoopbackHost(req.headers.host)) {
      sendError(res, 403, {
        code: 'forbidden',
        message: 'The CodeGraph UI only accepts requests from this machine.',
      });
      return;
    }

    const url = new URL(req.url ?? '/', `http://${UI_HOST}`);
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      await router.handle(req, res, url);
      return;
    }
    serveStatic(res, url.pathname);
  } catch (err) {
    if (res.headersSent) {
      res.end();
      return;
    }
    sendError(res, 500, {
      code: 'internal',
      message: err instanceof Error ? err.message : String(err),
    });
  }
}
