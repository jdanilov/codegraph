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

/** Launch the editor, detached, ignoring its output. */
export function launchEditor(template: string, file: string, line: number): EditorLaunch {
  const argv = buildEditorArgv(template, file, line);
  const command = argv[0];
  if (!command) {
    return { ok: false, reason: 'empty_command', message: 'Editor command template is empty' };
  }
  try {
    const child = spawn(command, argv.slice(1), {
      detached: true,
      stdio: 'ignore',
      shell: false,
    });
    // A bad command fails asynchronously; swallow it so an unhandled 'error'
    // event can't take the server down.
    child.on('error', () => undefined);
    child.unref();
    return { ok: true, argv };
  } catch (err) {
    return {
      ok: false,
      reason: 'spawn_failed',
      message: err instanceof Error ? err.message : String(err),
    };
  }
}
