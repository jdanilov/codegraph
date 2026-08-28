/**
 * What a diff says about ONE displayed span — the pure half of the bubble's
 * change decoration (B4.6) and of the "expand all changes" ranking (B4.7).
 *
 * Everything here is arithmetic over the `/api/source?mode=diff` and
 * `/api/changes` payloads: no DOM, no canvas, no fetch. That is what lets the
 * bubble gutter be decorated by a single pass over already-fetched data, off
 * the camera path, and what makes both answers probeable without a browser.
 *
 * The one modelling decision worth stating: a REMOVAL has no line of its own on
 * the new side of a diff, so it cannot be a row. It is a **seam** — the gap
 * between two rows — and it is reported as "N lines were deleted immediately
 * before line L". A bubble draws that as a hairline across the top of row L,
 * which is exactly where the deleted text used to be. Rendering the deleted
 * text inline would mean inventing rows the file does not have, and every line
 * number under them would then disagree with the file.
 */
import type { DiffHunk } from '@/lib/api';

/** `count` lines deleted immediately before new-side line `line`. */
export interface ChangeSeam {
  line: number;
  count: number;
}

/** A displayed span's changes, in REAL file lines (the new side of the diff). */
export interface SpanChangeMarks {
  /** Lines whose content is new since HEAD, ascending. */
  added: number[];
  /** Deletion seams inside the span, by the line they sit above, ascending. */
  removedBefore: ChangeSeam[];
  /** Lines deleted off the END of the span — drawn under its last row. */
  removedAtEnd: number;
}

export const NO_SPAN_CHANGES: SpanChangeMarks = {
  added: [],
  removedBefore: [],
  removedAtEnd: 0,
};

/** True when there is nothing at all to draw. */
export function spanChangesEmpty(marks: SpanChangeMarks): boolean {
  return marks.added.length === 0 && marks.removedBefore.length === 0 && marks.removedAtEnd === 0;
}

/**
 * Hunks → what to draw on the rows `[startLine, endLine]`.
 *
 * Hunks may cover the whole file (the client fetches a file's diff once and
 * shares it between every bubble showing that file), so everything outside the
 * span is dropped here rather than at the fetch. A seam sitting exactly one
 * line past the end belongs to the span — it is the deletion off its tail —
 * and anything further out does not.
 *
 * Deterministic and total: unparseable line numbers, an inverted span or an
 * empty hunk list all produce {@link NO_SPAN_CHANGES} rather than an error.
 */
export function spanChangeMarks(
  hunks: readonly DiffHunk[],
  startLine: number,
  endLine: number
): SpanChangeMarks {
  const from = Math.floor(startLine);
  const to = Math.floor(endLine);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return NO_SPAN_CHANGES;

  const added: number[] = [];
  const seams = new Map<number, number>();
  let atEnd = 0;

  const seam = (line: number, count: number): void => {
    if (count <= 0) return;
    if (line >= from && line <= to) seams.set(line, (seams.get(line) ?? 0) + count);
    else if (line === to + 1) atEnd += count;
  };

  for (const hunk of hunks) {
    let line = Math.floor(hunk.newStart);
    if (!Number.isFinite(line)) continue;
    // Deleted lines accumulate against the row they sit ABOVE, so they are
    // flushed when the next new-side line arrives (or when the hunk ends).
    let pending = 0;
    for (const entry of hunk.lines) {
      if (entry.type === 'del') {
        pending++;
        continue;
      }
      seam(line, pending);
      pending = 0;
      if (entry.type === 'add' && line >= from && line <= to) added.push(line);
      line++;
    }
    seam(line, pending);
  }

  added.sort((a, b) => a - b);
  const removedBefore = [...seams.entries()]
    .map(([line, count]) => ({ line, count }))
    .sort((a, b) => a.line - b.line);
  return { added: dedupe(added), removedBefore, removedAtEnd: atEnd };
}

function dedupe(sorted: number[]): number[] {
  const out: number[] = [];
  for (const value of sorted) if (out[out.length - 1] !== value) out.push(value);
  return out;
}
