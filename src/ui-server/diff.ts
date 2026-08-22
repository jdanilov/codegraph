/**
 * Uncommitted changes for a span — the `mode=diff` half of `GET /api/source`.
 *
 * The visualizer's source view has two modes: the full span, and "changes",
 * which is what the file looks like *relative to `HEAD`*. That second mode is
 * what makes the graph useful for reviewing agent-generated code: the user
 * clicks a symbol and immediately sees which of its lines are new.
 *
 * Implementation notes that matter:
 *
 *  - `git` is invoked with `execFileSync` and **never a shell**, with the path
 *    already proven inside the project root by `validatePathWithinRoot` and
 *    passed after a `--` separator, so a file called `--output=x` is a path.
 *  - Hunks are filtered by OVERLAP with the requested span and returned WHOLE.
 *    Trimming lines out of a hunk would invalidate its own `oldStart`/`newStart`
 *    accounting, and the few context lines that spill past the span are exactly
 *    what makes a hunk readable.
 *  - An **untracked** file (or a repo with no commits yet) has no `HEAD` side,
 *    so the whole requested span is reported as one `add` hunk. That is the
 *    truth — every line of it is new relative to `HEAD`.
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { validatePathWithinRoot } from '../utils';
import { MAX_FILE_BYTES, MAX_SOURCE_BYTES } from './source';

/** Context lines git includes around each change. */
const DIFF_CONTEXT = 3;

/** Every `git` call is bounded — a wedged git must not wedge the server. */
const GIT_TIMEOUT_MS = 5000;

/** Enough for a very large diff; anything past it is reported `truncated`. */
const GIT_MAX_BUFFER = 16 * 1024 * 1024;

export type DiffLineType = 'ctx' | 'add' | 'del';

export interface DiffLine {
  type: DiffLineType;
  /** Line text without the leading +/-/space marker and without the newline. */
  text: string;
}

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** The text after the closing `@@` (git's enclosing-symbol hint), if any. */
  heading?: string;
  lines: DiffLine[];
}

/** How the file relates to `HEAD`. */
export type DiffStatus = 'modified' | 'added' | 'deleted' | 'untracked' | 'unchanged';

export interface SourceDiff {
  file: string;
  mode: 'diff';
  /** The span the hunks were filtered to (absent when the caller gave none). */
  startLine?: number;
  endLine?: number;
  status: DiffStatus;
  hunks: DiffHunk[];
  /** Hunks that exist in the file but fall outside the requested span. */
  hunksOutsideSpan: number;
  /** True when git reported a binary file (never any hunks then). */
  binary: boolean;
  /** True when the diff was cut short by the size cap. */
  truncated: boolean;
}

export type DiffFailure =
  | { ok: false; reason: 'outside_root' }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'not_git'; message: string }
  | { ok: false; reason: 'git_failed'; message: string };

export type DiffResult = { ok: true; diff: SourceDiff } | DiffFailure;

/** Run a git command inside `cwd`; `null` when git fails or isn't installed. */
function git(cwd: string, args: string[]): string | null {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf-8',
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
  } catch {
    return null;
  }
}

/**
 * Run a git command inside `cwd` — the same bounded, shell-less invocation the
 * diff path uses, exposed so the changes view can share it (`changes.ts`).
 */
export function runGit(cwd: string, args: string[]): string | null {
  return git(cwd, args);
}

/** True when `root` sits inside a git work tree. */
export function isGitWorkTree(root: string): boolean {
  return git(root, ['rev-parse', '--is-inside-work-tree'])?.trim() === 'true';
}

/**
 * Parse a unified diff body into hunks. Everything before the first `@@` (the
 * `diff --git` / `index` / `---` / `+++` preamble) is skipped, and git's
 * "\ No newline at end of file" marker is dropped — it is not a source line.
 */
export function parseUnifiedDiff(patch: string): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  let current: DiffHunk | null = null;

  for (const raw of patch.split('\n')) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/.exec(raw);
    if (header) {
      current = {
        oldStart: Number(header[1]),
        oldLines: header[2] === undefined ? 1 : Number(header[2]),
        newStart: Number(header[3]),
        newLines: header[4] === undefined ? 1 : Number(header[4]),
        lines: [],
      };
      const heading = (header[5] ?? '').trim();
      if (heading) current.heading = heading;
      hunks.push(current);
      continue;
    }
    if (!current) continue;
    if (raw.startsWith('\\')) continue; // "\ No newline at end of file"
    if (raw.startsWith('+')) current.lines.push({ type: 'add', text: raw.slice(1) });
    else if (raw.startsWith('-')) current.lines.push({ type: 'del', text: raw.slice(1) });
    else if (raw.startsWith(' ')) current.lines.push({ type: 'ctx', text: raw.slice(1) });
    else if (raw === '') continue; // trailing newline of the patch
    else current = null; // back into a preamble (a second file in the patch)
  }

  return hunks;
}

/** Does a hunk touch `[from, to]` in NEW-file line numbering? */
function overlaps(hunk: DiffHunk, from: number, to: number): boolean {
  const start = hunk.newStart;
  const end = hunk.newStart + Math.max(hunk.newLines, 1) - 1;
  return start <= to && end >= from;
}

/**
 * Hunks of `file` versus `HEAD`, filtered to `[startLine, endLine]`.
 *
 * Omitting the bounds returns every hunk in the file.
 */
export function readSourceDiff(
  projectRoot: string,
  file: string,
  startLine?: number,
  endLine?: number
): DiffResult {
  const absolute = validatePathWithinRoot(projectRoot, file);
  if (!absolute) return { ok: false, reason: 'outside_root' };

  if (!isGitWorkTree(projectRoot)) {
    return {
      ok: false,
      reason: 'not_git',
      message: 'The project root is not inside a git work tree, so there is nothing to diff.',
    };
  }

  // git resolves a relative path against its own cwd, so relativize against the
  // REAL root: `validatePathWithinRoot` returns a realpath, and on macOS that
  // turns `/tmp/x` into `/private/tmp/x`.
  let realRoot = projectRoot;
  try {
    realRoot = fs.realpathSync(projectRoot);
  } catch {
    /* a root that can't be resolved simply keeps its literal form */
  }
  const relative = path.relative(realRoot, absolute).split(path.sep).join('/');
  if (!relative || relative.startsWith('..')) return { ok: false, reason: 'outside_root' };

  const exists = fs.existsSync(absolute);
  const hasHead = git(projectRoot, ['rev-parse', '--verify', '--quiet', 'HEAD']) !== null;
  const tracked =
    hasHead && git(projectRoot, ['ls-files', '--error-unmatch', '--', relative]) !== null;

  const from = Math.max(1, Math.floor(startLine ?? 1));
  const bounded = startLine !== undefined || endLine !== undefined;

  // No HEAD side at all: the whole span is new. Same answer for a brand-new
  // repo with no commits and for a file the user just created.
  if (!tracked) {
    if (!exists) return { ok: false, reason: 'not_found' };
    return {
      ok: true,
      diff: wholeSpanAsAdded(absolute, file, from, endLine, bounded, hasHead),
    };
  }

  const patch = git(projectRoot, [
    'diff',
    'HEAD',
    '--no-color',
    '--no-ext-diff',
    '--no-textconv',
    `-U${DIFF_CONTEXT}`,
    '--',
    relative,
  ]);
  if (patch === null) {
    return { ok: false, reason: 'git_failed', message: `git diff failed for ${file}` };
  }

  const binary = /^(?:Binary files|GIT binary patch)/m.test(patch);
  let truncated = false;
  let body = patch;
  if (Buffer.byteLength(body) > MAX_SOURCE_BYTES) {
    body = body.slice(0, MAX_SOURCE_BYTES);
    truncated = true;
  }

  const all = binary ? [] : parseUnifiedDiff(body);
  const deleted = /^\+\+\+ \/dev\/null$/m.test(patch);
  const added = /^--- \/dev\/null$/m.test(patch);

  // A deleted file has no new-side line numbers to filter against, so its
  // hunks are always returned whole.
  const to = Math.floor(endLine ?? Number.MAX_SAFE_INTEGER);
  const kept = bounded && !deleted ? all.filter((hunk) => overlaps(hunk, from, to)) : all;

  const status: DiffStatus = deleted
    ? 'deleted'
    : added
      ? 'added'
      : all.length === 0 && !binary
        ? 'unchanged'
        : 'modified';

  return {
    ok: true,
    diff: {
      file,
      mode: 'diff',
      ...(bounded ? { startLine: from, endLine: to === Number.MAX_SAFE_INTEGER ? from : to } : {}),
      status,
      hunks: kept,
      hunksOutsideSpan: all.length - kept.length,
      binary,
      truncated,
    },
  };
}

/** One synthetic `add` hunk covering the requested span of an untracked file. */
function wholeSpanAsAdded(
  absolute: string,
  file: string,
  from: number,
  endLine: number | undefined,
  bounded: boolean,
  hasHead: boolean
): SourceDiff {
  let lines: string[] = [];
  let truncated = false;
  try {
    const stat = fs.statSync(absolute);
    if (stat.size > MAX_FILE_BYTES) {
      truncated = true;
    } else {
      let text = fs.readFileSync(absolute, 'utf-8');
      if (Buffer.byteLength(text) > MAX_SOURCE_BYTES) {
        text = text.slice(0, MAX_SOURCE_BYTES);
        truncated = true;
      }
      lines = text.split('\n');
      // A trailing newline yields a phantom empty last line.
      if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
    }
  } catch {
    truncated = true;
  }

  const to = Math.min(lines.length, Math.floor(endLine ?? lines.length));
  const selected = to >= from ? lines.slice(from - 1, to) : [];

  const hunks: DiffHunk[] =
    selected.length === 0
      ? []
      : [
          {
            oldStart: 0,
            oldLines: 0,
            newStart: from,
            newLines: selected.length,
            lines: selected.map((text) => ({ type: 'add' as const, text })),
          },
        ];

  return {
    file,
    mode: 'diff',
    ...(bounded ? { startLine: from, endLine: to >= from ? to : from } : {}),
    // No commits yet reads as "added" rather than "untracked": nothing in the
    // repository is tracked, so "untracked" would say nothing useful.
    status: hasHead ? 'untracked' : 'added',
    hunks,
    hunksOutsideSpan: 0,
    binary: false,
    truncated,
  };
}
