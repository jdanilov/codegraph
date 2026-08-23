/**
 * Qualified names for every list that shows a symbol.
 *
 * A bare `send` in a list of references is not an answer — there are eleven of
 * them in a real project and the developer has to click each one to find out
 * which is which. Phase F therefore qualifies every referenced symbol with the
 * thing that OWNS it, and stops at a useful depth rather than printing the
 * whole dotted path:
 *
 *  - a reference inside the SAME file as the selected node stays short —
 *    `parent.symbol` (two segments) — because the file is already established
 *    by the panel around it;
 *  - a reference OUTSIDE that file is extended up to the file name, three
 *    segments at most (`analytics.Analytics.send`, `analytics.send`). The file
 *    segment drops its extension: it is there to name the module, and
 *    `analytics.ts.send` reads as a path, not a name.
 *
 * Lists with no file context at all (a question card's SYMBOLS list) always get
 * the file-qualified form, which is what makes an answer spanning seven files
 * readable at a glance.
 */
import { DIRECTORY_KIND, type GraphModel, type ModelNode } from '@/graph/model';

/** Segments in a file-qualified label (file + up to two owners). */
const MAX_SEGMENTS = 3;

/** Segments in a same-file label — just `parent.symbol`. */
const SAME_FILE_SEGMENTS = 2;

/** `analytics.ts` → `analytics`; a dotfile keeps its name. */
function stripExtension(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

/** `src/lib/api.ts` → `src/lib`; a top-level file → `''`. */
export function dirnameOf(filePath: string): string {
  const index = filePath.lastIndexOf('/');
  return index === -1 ? '' : filePath.slice(0, index);
}

export interface QualifyFallback {
  name?: string;
  qualifiedName?: string;
  file?: string;
}

/**
 * Label for a node in a list: its own name preceded by as many owners as the
 * rules above allow. Falls back to the payload's `qualifiedName` when the id
 * isn't in the model (a relation can point outside the mounted graph).
 */
export function qualifiedLabel(
  model: GraphModel | null,
  id: string,
  contextFile?: string | null,
  fallback?: QualifyFallback
): string {
  const node = model?.get(id);
  if (!node) return fallbackLabel(id, contextFile, fallback);

  const sameFile = Boolean(contextFile) && node.file === contextFile;
  const limit = sameFile ? SAME_FILE_SEGMENTS : MAX_SEGMENTS;
  const chain = [node.name];

  let current = node.parent;
  let guard = 0;
  while (current && chain.length < limit && guard++ < 32) {
    const parent: ModelNode | undefined = model?.get(current);
    if (!parent || parent.kind === DIRECTORY_KIND) break;
    if (parent.kind === 'file') {
      // The file is the outermost useful owner, and only when the reader isn't
      // already standing in it.
      if (!sameFile) chain.unshift(stripExtension(parent.name));
      break;
    }
    chain.unshift(parent.name);
    current = parent.parent;
  }
  return chain.join('.');
}

/** Same rules, applied to whatever the payload carried instead of a model row. */
function fallbackLabel(
  id: string,
  contextFile: string | null | undefined,
  fallback?: QualifyFallback
): string {
  const sameFile = Boolean(contextFile) && fallback?.file === contextFile;
  const limit = sameFile ? SAME_FILE_SEGMENTS : MAX_SEGMENTS;
  const qualified = fallback?.qualifiedName?.trim();
  if (qualified) {
    const parts = qualified.split(/[.#:]|::/).filter(Boolean);
    if (parts.length > 0) return parts.slice(-limit).join('.');
  }
  return fallback?.name || id;
}

/**
 * The one "where does this live" line the node panel shows (phase F replaced
 * the separate qualified / file / lines rows with it).
 *
 * A symbol names the FILE that contains it, with its own line range appended
 * (`src/lib/api.ts:67-135`) — the range belongs to the containing file, so the
 * two facts read as one. A file or a directory names the DIRECTORY it sits in.
 */
export function containerLabel(node: ModelNode): string {
  if (node.kind === DIRECTORY_KIND || node.kind === 'file') {
    return dirnameOf(node.file) || '(project root)';
  }
  const file = node.file || '(unknown file)';
  const start = node.startLine || 0;
  const end = node.endLine || start;
  return start > 0 ? `${file}:${start}-${end}` : file;
}

/** Distinct files a set of node ids touches — the "across M files" count. */
export function distinctFiles(model: GraphModel | null, ids: readonly string[]): number {
  if (!model) return 0;
  const files = new Set<string>();
  for (const id of ids) {
    const node = model.get(id);
    if (node?.file) files.add(node.file);
  }
  return files.size;
}
