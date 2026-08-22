/**
 * User-level visualizer preferences: `~/.codegraph/ui.json`.
 *
 * These are per-USER, not per-project (an editor command and an API key follow
 * you between repositories), which is why they do not live in the project's
 * `.codegraph/`. The file is written `0600` because it can hold an API key,
 * and the key is never echoed back to the browser in full.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface UiSettings {
  /** Editor command template, e.g. `code -g {file}:{line}`. */
  editorCommand?: string;
  /** Anthropic API key used by the (later-phase) question box. */
  anthropicApiKey?: string;
  /** Model id for the question box. */
  model?: string;
}

/** What `GET /api/settings` returns — the key masked, never in full. */
export interface UiSettingsView {
  editorCommand: string | null;
  model: string | null;
  /** Masked key (`••••••abcd`), or null when unset. */
  anthropicApiKey: string | null;
  anthropicApiKeySet: boolean;
}

/** Path of the user settings file (`~/.codegraph/ui.json`). */
export function settingsPath(): string {
  return path.join(os.homedir(), '.codegraph', 'ui.json');
}

/** Read settings; a missing or malformed file reads as "nothing configured". */
export function readSettings(): UiSettings {
  try {
    const raw = fs.readFileSync(settingsPath(), 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const value = parsed as Record<string, unknown>;
    const settings: UiSettings = {};
    if (typeof value['editorCommand'] === 'string') settings.editorCommand = value['editorCommand'];
    if (typeof value['anthropicApiKey'] === 'string') settings.anthropicApiKey = value['anthropicApiKey'];
    if (typeof value['model'] === 'string') settings.model = value['model'];
    return settings;
  } catch {
    return {};
  }
}

/** Persist settings, creating `~/.codegraph/` and keeping the file private. */
export function writeSettings(settings: UiSettings): void {
  const file = settingsPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const body = JSON.stringify(settings, null, 2) + '\n';
  fs.writeFileSync(file, body, { encoding: 'utf-8', mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600); // an existing file keeps its old mode otherwise
  } catch {
    /* best-effort on filesystems without POSIX modes */
  }
}

/** `sk-ant-…` → `••••••••wxyz`; short keys are fully masked. */
export function maskKey(key: string | undefined): string | null {
  if (!key) return null;
  const tail = key.length > 4 ? key.slice(-4) : '';
  return `${'•'.repeat(8)}${tail}`;
}

/** The read-back view of settings, with the key masked. */
export function settingsView(settings: UiSettings): UiSettingsView {
  return {
    editorCommand: settings.editorCommand ?? null,
    model: settings.model ?? null,
    anthropicApiKey: maskKey(settings.anthropicApiKey),
    anthropicApiKeySet: Boolean(settings.anthropicApiKey),
  };
}

/**
 * Merge a `PUT /api/settings` body into the stored settings.
 *
 * Absent keys are left alone, `null`/`''` clears a value, and a key that comes
 * back still masked (the client re-submitting what it read) is treated as
 * "unchanged" — otherwise round-tripping the settings form would overwrite the
 * real key with bullets.
 */
export function mergeSettings(current: UiSettings, patch: Record<string, unknown>): UiSettings {
  const next: UiSettings = { ...current };

  const applyString = (field: keyof UiSettings): void => {
    if (!(field in patch)) return;
    const value = patch[field];
    if (value === null || value === '') {
      delete next[field];
      return;
    }
    if (typeof value === 'string') next[field] = value;
  };

  applyString('editorCommand');
  applyString('model');

  if ('anthropicApiKey' in patch) {
    const value = patch['anthropicApiKey'];
    if (value === null || value === '') {
      delete next.anthropicApiKey;
    } else if (typeof value === 'string' && !value.includes('•')) {
      next.anthropicApiKey = value;
    }
  }

  return next;
}
