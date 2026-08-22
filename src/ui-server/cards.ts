/**
 * Cards — saved questions and their results — persisted per project in
 * `.codegraph/ui/cards.json`.
 *
 * `.codegraph/` carries its own `.gitignore` (written by `codegraph init`)
 * that ignores everything inside it, so nothing here ever lands in a user's
 * repository and the visualizer never writes a file into the project tree.
 */
import * as fs from 'fs';
import * as path from 'path';

export interface Card {
  id: string;
  question: string;
  createdAt: number;
  result?: unknown;
  [key: string]: unknown;
}

/** Directory holding the visualizer's per-project state. */
export function uiStateDir(projectRoot: string): string {
  return path.join(projectRoot, '.codegraph', 'ui');
}

/** Path of the cards file for a project. */
export function cardsPath(projectRoot: string): string {
  return path.join(uiStateDir(projectRoot), 'cards.json');
}

/** Read the saved cards; a missing or malformed file reads as an empty list. */
export function readCards(projectRoot: string): Card[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(cardsPath(projectRoot), 'utf-8')) as unknown;
    return Array.isArray(parsed) ? (parsed.filter(isCard) as Card[]) : [];
  } catch {
    return [];
  }
}

/** Replace the saved cards (write-then-rename so a crash can't truncate). */
export function writeCards(projectRoot: string, cards: Card[]): void {
  const file = cardsPath(projectRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(cards, null, 2) + '\n', 'utf-8');
  fs.renameSync(tmp, file);
}

/** Validate one entry of a `PUT /api/cards` body. */
export function isCard(value: unknown): value is Card {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const card = value as Record<string, unknown>;
  return typeof card['id'] === 'string' && card['id'].length > 0;
}
