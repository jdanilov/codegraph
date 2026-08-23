/**
 * "Open in editor" — runs the user's own command template from
 * `~/.codegraph/ui.json` (e.g. `code -g {file}:{line}`).
 *
 * The template is tokenized here and spawned WITHOUT a shell: substitution
 * happens after tokenizing, so a path containing spaces or shell metacharacters
 * stays a single argument and can never turn into a command.
 */
import { spawn } from 'child_process';

/**
 * Split a command template into argv, honoring single and double quotes.
 * Deliberately simple — no shell expansion, no operators, no escaping rules
 * beyond quotes, because nothing here reaches a shell.
 */
export function tokenizeCommand(template: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let started = false;

  for (const char of template) {
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      started = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (started || current) tokens.push(current);
      current = '';
      started = false;
      continue;
    }
    current += char;
    started = true;
  }
  if (started || current) tokens.push(current);
  return tokens;
}

/** Substitute `{file}` / `{line}` in each already-split argument. */
export function buildEditorArgv(template: string, file: string, line: number): string[] {
  return tokenizeCommand(template).map((token) =>
    token.replace(/\{file\}/g, file).replace(/\{line\}/g, String(line))
  );
}

export type EditorLaunch =
  | { ok: true; argv: string[] }
  | { ok: false; reason: 'empty_command' | 'spawn_failed'; message: string };

/**
 * How long to wait for the OS to tell us the process actually started.
 *
 * `spawn` resolves ENOENT (command not on PATH — a shell alias, a typo) on the
 * NEXT tick as an `error` event, so a synchronous "ok" is a guess. This used to
 * swallow that event and report success, which is what made a misconfigured
 * editor command look like it worked while nothing opened. A few milliseconds
 * buys the truth; a launch that hasn't failed by then has really started.
 */
const SPAWN_SETTLE_MS = 250;

/**
 * Launch the editor, detached, ignoring its output.
 *
 * Resolves once the child has either emitted `spawn` (it is running) or `error`
 * (it never started), so `/api/open` can answer honestly.
 */
export function launchEditor(
  template: string,
  file: string,
  line: number
): Promise<EditorLaunch> {
  const argv = buildEditorArgv(template, file, line);
  const command = argv[0];
  if (!command) {
    return Promise.resolve({
      ok: false,
      reason: 'empty_command',
      message: 'Editor command template is empty',
    });
  }

  return new Promise<EditorLaunch>((resolve) => {
    let settled = false;
    const finish = (outcome: EditorLaunch): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };
    // Belt and braces: if neither event ever arrives, the request still answers.
    const timer = setTimeout(() => finish({ ok: true, argv }), SPAWN_SETTLE_MS);
    if (typeof timer.unref === 'function') timer.unref();

    try {
      const child = spawn(command, argv.slice(1), {
        detached: true,
        stdio: 'ignore',
        shell: false,
      });
      child.on('error', (err: Error) => {
        finish({ ok: false, reason: 'spawn_failed', message: describeSpawnError(err, command) });
      });
      child.on('spawn', () => {
        child.unref();
        finish({ ok: true, argv });
      });
    } catch (err) {
      finish({
        ok: false,
        reason: 'spawn_failed',
        message: describeSpawnError(err, command),
      });
    }
  });
}

/** A launch failure the user can act on — "which command, and what went wrong". */
function describeSpawnError(err: unknown, command: string): string {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'ENOENT') {
    return `Editor command "${command}" was not found on PATH. Shell aliases and functions don't count — use the executable's name or its full path.`;
  }
  const message = err instanceof Error ? err.message : String(err);
  return `Editor command "${command}" failed to start: ${message}`;
}
