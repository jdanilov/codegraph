/**
 * Source text for a span — the read side of `GET /api/source` and of the node
 * info panel.
 *
 * Every path goes through `validatePathWithinRoot`, the same chokepoint the
 * MCP content tools use: the visualizer serves file contents over HTTP with no
 * auth, so a `..` or a symlink that leaves the project must never resolve.
 */
import * as fs from 'fs';
import { validatePathWithinRoot } from '../utils';

/** Hard cap on returned text, so one request can't stream a 40 MB blob. */
export const MAX_SOURCE_BYTES = 512 * 1024;

/** Files larger than this are never read whole. */
export const MAX_FILE_BYTES = 32 * 1024 * 1024;

export interface SourceSpan {
  file: string;
  startLine: number;
  endLine: number;
  mode: 'full';
  content: string;
  /** True when the span was cut short by {@link MAX_SOURCE_BYTES}. */
  truncated: boolean;
  /** Total line count of the file. */
  totalLines: number;
}

export type SourceFailure =
  | { ok: false; reason: 'outside_root' }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'too_large' }
  | { ok: false; reason: 'unreadable'; message: string };

export type SourceResult = { ok: true; span: SourceSpan } | SourceFailure;

/**
 * Read lines `[startLine, endLine]` (1-indexed, inclusive) of a project file.
 * Omitting the bounds returns the whole file.
 */
export function readSourceSpan(
  projectRoot: string,
  file: string,
  startLine?: number,
  endLine?: number
): SourceResult {
  const absolute = validatePathWithinRoot(projectRoot, file);
  if (!absolute) return { ok: false, reason: 'outside_root' };

  let stat: fs.Stats;
  try {
    stat = fs.statSync(absolute);
  } catch {
    return { ok: false, reason: 'not_found' };
  }
  if (!stat.isFile()) return { ok: false, reason: 'not_found' };
  if (stat.size > MAX_FILE_BYTES) return { ok: false, reason: 'too_large' };

  let text: string;
  try {
    text = fs.readFileSync(absolute, 'utf-8');
  } catch (err) {
    return { ok: false, reason: 'unreadable', message: err instanceof Error ? err.message : String(err) };
  }

  const lines = text.split('\n');
  const totalLines = lines.length;
  const from = Math.max(1, Math.floor(startLine ?? 1));
  const to = Math.min(totalLines, Math.floor(endLine ?? totalLines));
  const selected = to >= from ? lines.slice(from - 1, to) : [];

  let content = selected.join('\n');
  let truncated = false;
  if (Buffer.byteLength(content) > MAX_SOURCE_BYTES) {
    content = content.slice(0, MAX_SOURCE_BYTES);
    truncated = true;
  }

  return {
    ok: true,
    span: {
      file,
      startLine: from,
      endLine: to >= from ? to : from,
      mode: 'full',
      content,
      truncated,
      totalLines,
    },
  };
}
