/**
 * URL = state.
 *
 * The contract asks for the view + the active card to live in the URL, so a
 * view can be copied into a message and reopened exactly as it was.
 *
 * **Format** — `#<version><payload>`:
 *
 *   - `#1<base64url>` — DEFLATE-compressed (raw) JSON, the normal case.
 *   - `#0<base64url>` — the same JSON, uncompressed, for a browser without
 *     `CompressionStream` (or when compression somehow grew the payload).
 *
 * The JSON is `{ r: string|null, c: string|null, m: 'kind'|'layer', k: string[] }`
 * — the sunburst's **root** node id, the active card id, the colour mode and
 * the enabled edge kinds. Keys are one letter because they are repeated in
 * every URL.
 *
 * **Backward tolerance (phase E).** Before the sunburst the view was an
 * *expansion set* stored under `e`, which could run to hundreds of ids. An old
 * link must never break, so `e` is still read: the shell re-roots to the
 * deepest node those ids have in common, which is the closest honest
 * translation of "this is what I had open". `e` is never written any more, and
 * the payload is now small enough that {@link MAX_HASH_CHARS} is academic — the
 * cap stays as a guard rather than a degradation path.
 */
import type { ColorMode } from '@/graph/palette';

/** Longest hash we will write. Comfortably under every browser's URL limit. */
export const MAX_HASH_CHARS = 6000;

export interface UrlState {
  /** Sunburst root; `null` when the URL predates phase E. */
  root: string | null;
  /** Phase D's expansion set, read-only — a legacy link's best-effort root. */
  legacyExpanded: string[];
  cardId: string | null;
  colorMode: ColorMode;
  edgeKinds: string[] | null;
}

interface Encoded {
  r?: string | null;
  e?: string[];
  c?: string | null;
  m?: string;
  k?: string[];
}

/** Encode state into a hash string (including the leading `#`). */
export async function encodeUrlState(state: Omit<UrlState, 'legacyExpanded'>): Promise<string> {
  const full: Encoded = {
    r: state.root,
    c: state.cardId,
    m: state.colorMode,
    ...(state.edgeKinds ? { k: state.edgeKinds } : {}),
  };
  const hash = await pack(full);
  if (hash.length <= MAX_HASH_CHARS) return hash;
  // Nothing here is unbounded any more; the edge-kind list is the only list.
  return pack({ ...full, k: undefined });
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
      root: typeof parsed.r === 'string' ? parsed.r : null,
      legacyExpanded: Array.isArray(parsed.e)
        ? parsed.e.filter((id) => typeof id === 'string')
        : [],
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
