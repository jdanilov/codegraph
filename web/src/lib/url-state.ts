/**
 * URL = state.
 *
 * The contract asks for the expanded set + the active card to live in the URL,
 * so a view can be copied into a message and reopened exactly as it was. The
 * expansion set is the awkward part: it is a list of node ids (long, repetitive
 * strings) and can run to hundreds of entries.
 *
 * **Format** — `#<version><payload>`:
 *
 *   - `#1<base64url>` — DEFLATE-compressed (raw) JSON, the normal case.
 *   - `#0<base64url>` — the same JSON, uncompressed, for a browser without
 *     `CompressionStream` (or when compression somehow grew the payload).
 *
 * The JSON is `{ e: string[], c: string|null, m: 'kind'|'layer', k: string[] }`
 * — expanded ids, active card id, colour mode, enabled edge kinds. Keys are
 * one letter because they are repeated in every URL and the payload is what we
 * are trying to keep small.
 *
 * **Degradation** — a URL is capped at {@link MAX_HASH_CHARS}. Over the cap,
 * the expansion set is dropped (it is the only unbounded field) and the rest —
 * the active card, colour mode, edge toggles — still travels; the card then
 * re-derives its own expansion when it is applied, which is the same result for
 * every card-driven view. Nothing ever silently produces a broken URL.
 */
import type { ColorMode } from '@/graph/palette';

/** Longest hash we will write. Comfortably under every browser's URL limit. */
export const MAX_HASH_CHARS = 6000;

export interface UrlState {
  expanded: string[];
  cardId: string | null;
  colorMode: ColorMode;
  edgeKinds: string[] | null;
}

interface Encoded {
  e?: string[];
  c?: string | null;
  m?: string;
  k?: string[];
}

/** Encode state into a hash string (including the leading `#`). */
export async function encodeUrlState(state: UrlState): Promise<string> {
  const full: Encoded = {
    e: state.expanded,
    c: state.cardId,
    m: state.colorMode,
    ...(state.edgeKinds ? { k: state.edgeKinds } : {}),
  };
  const hash = await pack(full);
  if (hash.length <= MAX_HASH_CHARS) return hash;
  // Too long: drop the expansion set, keep everything else meaningful.
  return pack({ ...full, e: [] });
}

/** Decode a hash string; anything unreadable is treated as "no state". */
export async function decodeUrlState(hash: string): Promise<UrlState | null> {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  if (raw.length < 2) return null;
  const version = raw[0];
  const payload = raw.slice(1);
  try {
    const bytes = fromBase64Url(payload);
    const json =
      version === '1'
        ? new TextDecoder().decode(await inflate(bytes))
        : new TextDecoder().decode(bytes);
    const parsed = JSON.parse(json) as Encoded;
    return {
      expanded: Array.isArray(parsed.e) ? parsed.e.filter((id) => typeof id === 'string') : [],
      cardId: typeof parsed.c === 'string' ? parsed.c : null,
      colorMode: parsed.m === 'layer' ? 'layer' : 'kind',
      edgeKinds: Array.isArray(parsed.k) ? parsed.k.filter((k) => typeof k === 'string') : null,
    };
  } catch {
    return null;
  }
}

async function pack(value: Encoded): Promise<string> {
  const json = new TextEncoder().encode(JSON.stringify(value));
  const deflated = await deflate(json);
  if (deflated && deflated.byteLength < json.byteLength) {
    return `#1${toBase64Url(deflated)}`;
  }
  return `#0${toBase64Url(json)}`;
}

/** `deflate-raw` via CompressionStream; null when the browser lacks it. */
async function deflate(bytes: Uint8Array): Promise<Uint8Array | null> {
  const Compression = (globalThis as { CompressionStream?: typeof CompressionStream })
    .CompressionStream;
  if (!Compression) return null;
  try {
    const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new Compression('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    return null;
  }
}

async function inflate(bytes: Uint8Array): Promise<Uint8Array> {
  const Decompression = (globalThis as { DecompressionStream?: typeof DecompressionStream })
    .DecompressionStream;
  if (!Decompression) throw new Error('DecompressionStream unavailable');
  const stream = new Blob([bytes as BlobPart])
    .stream()
    .pipeThrough(new Decompression('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
