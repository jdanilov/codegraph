/**
 * Small client-side preferences, in `localStorage`.
 *
 * There are two kinds of state in this UI already: things that describe a VIEW
 * (root, selection, card, colour mode — the URL hash) and things that are a
 * user's setting for every project (`~/.codegraph/ui.json`, over
 * `GET/PUT /api/settings`). Panel geometry is neither: it is how one person
 * likes this browser laid out, so it does not belong in a shareable link, and
 * it is not worth a server round trip on every drag frame.
 *
 * `localStorage` is therefore the store, and it is deliberately fail-soft — a
 * private window with storage denied, or a value someone hand-edited into
 * nonsense, falls back to the default rather than taking the UI down.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

const PREFIX = 'codegraph.ui.';

/** Read one preference, or `fallback` when it is missing or unreadable. */
export function readPref<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(PREFIX + key);
    if (raw === null) return fallback;
    const parsed: unknown = JSON.parse(raw);
    return parsed === null || typeof parsed !== typeof fallback ? fallback : (parsed as T);
  } catch {
    return fallback;
  }
}

/** Write one preference. Storage being unavailable is not an error here. */
export function writePref<T>(key: string, value: T): void {
  try {
    window.localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch {
    /* private mode, quota, disabled storage — the session simply forgets. */
  }
}

/**
 * `useState` that remembers across sessions.
 *
 * The initial value is read once (lazily, so the first paint is not blocked by
 * storage) and every later write is persisted. `normalize` is applied on the
 * way in AND on the way out, so a stored width that no longer fits the viewport
 * is clamped rather than restored broken.
 */
export function useStoredState<T>(
  key: string,
  fallback: T,
  normalize?: (value: T) => T
): [T, (value: T | ((current: T) => T)) => void] {
  const normalizeRef = useRef(normalize);
  normalizeRef.current = normalize;

  const [value, setValue] = useState<T>(() => {
    const stored = readPref(key, fallback);
    return normalizeRef.current ? normalizeRef.current(stored) : stored;
  });

  useEffect(() => {
    writePref(key, value);
  }, [key, value]);

  const update = useCallback((next: T | ((current: T) => T)) => {
    setValue((current) => {
      const resolved = typeof next === 'function' ? (next as (c: T) => T)(current) : next;
      return normalizeRef.current ? normalizeRef.current(resolved) : resolved;
    });
  }, []);

  return [value, update];
}
