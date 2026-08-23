/**
 * Tiny HTTP helpers for the visualizer server.
 *
 * The visualizer is served by `node:http` with a hand-rolled router — the
 * design contract forbids new RUNTIME dependencies (`docs/design/visualizer.md`),
 * so everything an express-shaped app would give us (body parsing, JSON
 * responses, typed errors) lives here in a few dozen lines.
 */
import type { IncomingMessage, ServerResponse } from 'http';

/** Largest request body we will buffer (settings/cards payloads are tiny). */
export const MAX_BODY_BYTES = 4 * 1024 * 1024;

/** Machine-readable error codes returned in `{ error: { code } }` bodies. */
export type ApiErrorCode =
  | 'not_found'
  | 'bad_request'
  | 'not_implemented'
  | 'not_indexed'
  | 'conflict'
  | 'forbidden'
  | 'internal'
  | 'method_not_allowed'
  | 'payload_too_large'
  /** `/api/open`: an editor command IS configured, but it failed to start. */
  | 'editor_failed';

export interface ApiError {
  code: ApiErrorCode;
  message: string;
  /** Which implementation phase will fill this in (501 stubs only). */
  phase?: string;
}

/** Send a JSON body with no caching (the default for every `/api/` route). */
export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {}
): void {
  const payload = JSON.stringify(body ?? null);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

/** Send a pre-serialized JSON string (lets the graph route cache its payload). */
export function sendJsonRaw(
  res: ServerResponse,
  status: number,
  payload: string,
  headers: Record<string, string> = {}
): void {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

/** `{ error: { code, message } }` — the shape every failing route returns. */
export function sendError(
  res: ServerResponse,
  status: number,
  error: ApiError,
  /** Merged into the body — typically the endpoint's own (empty) result shape. */
  extra: object = {}
): void {
  sendJson(res, status, { error, ...extra });
}

/**
 * A route the contract defines but this phase does not implement yet. The body
 * carries the error AND the contract's own (empty) result shape, so a client
 * written against the final API can read it without special-casing the stub.
 */
export function sendNotImplemented(
  res: ServerResponse,
  message: string,
  shape: object,
  phase: string
): void {
  sendError(res, 501, { code: 'not_implemented', message, phase }, shape);
}

/** Read a request body as UTF-8, rejecting anything oversized. */
export function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new BodyTooLargeError());
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

/** Thrown by {@link readBody} when the client sends more than the cap. */
export class BodyTooLargeError extends Error {
  constructor() {
    super('Request body too large');
    this.name = 'BodyTooLargeError';
  }
}

/** Parse a JSON request body; returns null when absent or malformed. */
export async function readJsonBody<T>(req: IncomingMessage): Promise<T | null> {
  const raw = (await readBody(req)).trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/** First value of a query-string parameter, or undefined. */
export function queryParam(url: URL, name: string): string | undefined {
  const value = url.searchParams.get(name);
  return value === null ? undefined : value;
}

/** Parse a positive integer query parameter, falling back to `fallback`. */
export function intParam(url: URL, name: string, fallback: number): number {
  const raw = queryParam(url, name);
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Guard against DNS-rebinding: the server binds 127.0.0.1 and has no auth, so
 * a page on another origin must not be able to reach it by pointing a hostname
 * at 127.0.0.1. Only loopback Host headers are accepted.
 */
export function isLoopbackHost(hostHeader: string | undefined): boolean {
  if (!hostHeader) return true; // HTTP/1.0 clients (curl --http1.0) send none
  // Strip the port; IPv6 literals arrive as `[::1]:4747`.
  const host = hostHeader.startsWith('[')
    ? hostHeader.slice(0, hostHeader.indexOf(']') + 1)
    : (hostHeader.split(':')[0] ?? '');
  const normalized = host.toLowerCase();
  return (
    normalized === 'localhost' ||
    normalized === '127.0.0.1' ||
    normalized === '[::1]' ||
    normalized === '::1' ||
    normalized === '0.0.0.0'
  );
}
