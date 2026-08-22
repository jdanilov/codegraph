/**
 * `POST /api/index` — build (or rebuild) the project's index from the UI.
 *
 * Indexing runs as a SUBPROCESS of the real CLI rather than in the server: a
 * full index recreates `codegraph.db` from scratch, so the server has to let go
 * of its own connection anyway, and a crash in a heavy parse can then never
 * take the UI down with it. Progress is streamed back as newline-delimited
 * JSON while it runs.
 */
import { spawn, type ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

/** One line of the NDJSON progress stream. */
export type IndexEvent =
  | { type: 'start'; root: string; step: 'init' | 'index' }
  | { type: 'log'; stream: 'stdout' | 'stderr'; line: string }
  | { type: 'done'; code: number; ok: boolean }
  | { type: 'error'; message: string };

/**
 * Path of the CodeGraph CLI to spawn. In an installed package this module sits
 * at `dist/ui-server/`, so the CLI is one directory over.
 */
export function cliEntrypoint(): string {
  const sibling = path.join(__dirname, '..', 'bin', 'codegraph.js');
  if (fs.existsSync(sibling)) return sibling;
  // Running from a ts-node/tsx context (tests, `npm run dev`): fall back to the
  // script that launched this process.
  return process.argv[1] ?? sibling;
}

/**
 * Run `codegraph index` for `projectRoot`, forwarding each output line to
 * `onEvent`. Resolves with the exit code (never rejects — failures arrive as
 * an `error` event followed by `done`).
 */
export function runIndexSubprocess(
  projectRoot: string,
  onEvent: (event: IndexEvent) => void
): Promise<number> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(
        process.execPath,
        [cliEntrypoint(), 'index', projectRoot, '--verbose'],
        {
          cwd: projectRoot,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: {
            ...process.env,
            // Plain, line-oriented output: no ANSI, no shimmer animation.
            NO_COLOR: '1',
            FORCE_COLOR: '0',
          },
        }
      );
    } catch (err) {
      onEvent({ type: 'error', message: err instanceof Error ? err.message : String(err) });
      onEvent({ type: 'done', code: 1, ok: false });
      resolve(1);
      return;
    }

    const forward = (stream: 'stdout' | 'stderr') => {
      let buffer = '';
      return (chunk: Buffer): void => {
        buffer += chunk.toString('utf-8');
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          const text = line.replace(/\r/g, '').trim();
          if (text) onEvent({ type: 'log', stream, line: text });
        }
      };
    };

    child.stdout?.on('data', forward('stdout'));
    child.stderr?.on('data', forward('stderr'));

    child.on('error', (err) => {
      onEvent({ type: 'error', message: err.message });
    });

    child.on('close', (code) => {
      const exitCode = code ?? 1;
      onEvent({ type: 'done', code: exitCode, ok: exitCode === 0 });
      resolve(exitCode);
    });
  });
}

/**
 * Create `.codegraph/` for a root that has none, so the subsequent `index`
 * run has something to write into. Done in-process (the library API) because
 * `codegraph init` is an interactive command.
 */
export async function initProject(projectRoot: string): Promise<void> {
  const { default: CodeGraph } = await import('../index');
  const graph = await CodeGraph.init(projectRoot, { index: false });
  graph.destroy();
}
