/**
 * Namespace-proxy resolution — ROADMAP item 1a.
 *
 * ## The problem
 *
 * Some codebases hand modules to consumers through a single *namespace object*
 * rather than through imports: an auto-vivifying proxy, a code-generated
 * registry, a service locator. Consumers write
 *
 *   const { $utils, $store } = app;   // or a global, or an injected param
 *   $utils.sleep(50);
 *   $store.transaction(() => { … });
 *
 * and the definition side writes back onto the same object:
 *
 *   $utils.sleep = async (ms) => { … };   // the assignment IS the export
 *
 * AST extraction sees `$utils.sleep(…)` as a member access on a receiver that
 * is never declared, so it lands in `unresolved_refs` as the dotted name
 * `"$utils.sleep"` and dies at the resolver's "no node has this name"
 * pre-filter. Every call site through the namespace is a dead reference, and
 * the graph has a hole exactly where the codebase's own module system lives.
 *
 * ## What this plugin does
 *
 * Two independent, independently-configurable strategies. A project may use
 * either or both.
 *
 * 1. **Registry-backed (exact, preferred).** Many such frameworks ship a
 *    generated barrel/registry file whose import statements *are* the
 *    namespace map, one import per member. Parsing that file's imports yields
 *    an authoritative `name → defining file` mapping with zero guessing, so
 *    these resolutions score high.
 *
 * 2. **Assignment-scan (mechanical).** Scan a configured slice of the project
 *    for `$ns.member = …` / `??=` / `||=` / `&&=` assignments. Each is a
 *    definition site for `member`. References to `$ns.member` resolve to it.
 *    Mechanical rather than exact, so these score lower, and a member with
 *    definition sites in more than one file is left unresolved (silent beats
 *    wrong).
 *
 * ## Configuration (`codegraph.json`)
 *
 * ```jsonc
 * {
 *   "plugins": {
 *     "namespace-proxy": {
 *       // REQUIRED. The namespace objects this plugin owns, written exactly as
 *       // they appear in source (sigil included). NOTHING outside this list is
 *       // ever claimed — the plugin never guesses from a `$` prefix. That is
 *       // what lets a project route, say, its message-bus object to the
 *       // event-bus plugin instead of having every call point at one
 *       // dispatcher method.
 *       "objects": ["$", "$utils", "$store", "$ui"],
 *
 *       // Strategy 1 — registry-backed. Omit to switch it off.
 *       // Either one entry (an object) or several (an array of objects).
 *       "registry": {
 *         // Project-relative paths or globs (`*`, `**`, `?`) naming the
 *         // registry/barrel file(s) whose imports form the namespace map.
 *         "files": ["src/gen/registry.ts"],
 *
 *         // Which namespace objects this registry maps. Must be a subset of
 *         // the top-level `objects`. Omit for "all of them".
 *         "objects": ["$"],
 *
 *         // How an import in the registry file maps onto a reference:
 *         //   "member"    (default) — the imported local name IS the member
 *         //                name, so `import { Widget } from './ui/widget'`
 *         //                resolves `$.Widget` into `ui/widget.ts`.
 *         //   "namespace" — `prefix` + the imported local name IS the
 *         //                namespace OBJECT name, so `import { utils } from
 *         //                './utils/index'` with prefix `"$"` resolves
 *         //                `$utils.sleep` to `sleep` inside `utils/index.ts`.
 *         "level": "member",
 *
 *         // Only meaningful for `"level": "namespace"`. Default "$".
 *         "prefix": "$"
 *       },
 *
 *       // Strategy 2 — assignment scan. Omit to switch it off.
 *       "assignments": {
 *         // Which namespace objects to scan for. Subset of the top-level
 *         // `objects`; omit for "all of them".
 *         "objects": ["$utils", "$store"],
 *
 *         // Project-relative globs bounding the scan. Omit to scan every
 *         // indexed file — correct, but on a large repo you want a directory
 *         // convention here. A pattern with no wildcard matches that path and
 *         // everything under it.
 *         "include": ["src/features/**", "src/services"],
 *
 *         // Assignment operators that count as a definition.
 *         // Default: ["=", "??=", "||=", "&&="].
 *         "operators": ["=", "??="],
 *
 *         // Count only assignments that start at column 0. Default true, and
 *         // it is the single biggest precision lever: a dynamic *export* is a
 *         // top-level statement, whereas `$state.user.busy = true` inside a
 *         // method is ordinary state mutation and must not be mistaken for a
 *         // definition. Set false only if the project wraps its definitions.
 *         "topLevelOnly": true,
 *
 *         // Safety valve on the scan. Default 20000.
 *         "maxFiles": 20000
 *       }
 *     }
 *   }
 * }
 * ```
 *
 * A project with no `plugins.namespace-proxy` entry gets exactly the behavior
 * it had before this file existed: `detect()` is false, the plugin is not among
 * the resolver's frameworks, and `claimsReference` is never consulted.
 *
 * ## Precision safeguards
 *
 *   - **Explicit objects only.** A sigil is never inferred. `$foo.bar` is
 *     invisible to this plugin unless `"$foo"` is in `objects`.
 *   - **`extends` is split by target shape, never guessed.** Inheritance from a
 *     same-stem layer sibling (`widget.bg.ts extends $.Widget` → `widget.ts`)
 *     belongs to the layer-chain plugin and we return null for it. Inheritance
 *     from a different module (`widget.bg.ts extends $.Unit` → `unit/unit.ts`)
 *     is ours, because layer-chain has no namespace map to reach it — but ONLY
 *     via the registry strategy, never the assignment scan. A registry hit is
 *     an authoritative mapping; a wrong inheritance edge corrupts every
 *     type-hierarchy query, so it is not a place to infer.
 *   - **One definition file or nothing.** An assignment-scanned member found in
 *     two different files is ambiguous and stays unresolved.
 *   - **File-node fallback is gated by reference kind.** When a member's
 *     defining file is known but no symbol in it carries the member's name, we
 *     point at the file node — but only for `calls`/`references` refs, never
 *     for a type/inheritance ref where a file is a nonsense target.
 *   - **Comments are stripped before scanning**, with source offsets preserved.
 *
 * ## Hooks
 *
 *   - `detect` — config gate, exactly like `./noop.ts`. Also records the
 *     project's claimed objects, because `claimsReference` gets no context.
 *   - `claimsReference` — the load-bearing one: opts `"$ns.member"` past the
 *     resolver's "no node has this name" pre-filter that drops all of these
 *     today. One `indexOf` + one `Set.has`; it is on the hot path for every
 *     unresolved reference in the project.
 *   - `resolve` — turns the reference into an edge.
 *
 * Both maps are built lazily and memoized per `ResolutionContext` (a fresh
 * context per resolver instance, so a re-index or a sync rebuilds them), which
 * mirrors how `import-resolver.ts` memoizes its own per-context work.
 */
import * as path from 'node:path';
import type { Language, Node } from '../../types';
import { logDebug, logWarn } from '../../errors';
import { getProjectConfigGeneration } from '../../project-config';
import { resolveImportPath } from '../import-resolver';
import { stripCommentsForRegex } from '../strip-comments';
import type {
  FrameworkResolver,
  ResolutionContext,
  ResolvedRef,
  UnresolvedRef,
} from '../types';
import { getPluginOptions, isPluginEnabled } from './plugin-config';

/** Config key and registry name for this plugin. */
export const NAMESPACE_PROXY_PLUGIN_NAME = 'namespace-proxy';

/** How a registry file's imports map onto a `<object>.<member>` reference. */
export type RegistryLevel = 'member' | 'namespace';

/** One registry/barrel file (or glob) whose imports form a namespace map. */
export interface NamespaceRegistryOptions {
  /** Project-relative paths or globs. */
  files?: string[];
  /** Namespace objects this registry maps; omit for all of `objects`. */
  objects?: string[];
  /** `"member"` (default) or `"namespace"`. */
  level?: RegistryLevel;
  /** Sigil prepended to an import's local name under `"namespace"` level. */
  prefix?: string;
}

/** The `$ns.member = …` scan. */
export interface NamespaceAssignmentOptions {
  /** Namespace objects to scan for; omit for all of `objects`. */
  objects?: string[];
  /** Project-relative globs bounding the scan; omit to scan everything. */
  include?: string[];
  /** Assignment operators counting as a definition. */
  operators?: string[];
  /** Only count assignments starting at column 0. Default true. */
  topLevelOnly?: boolean;
  /** Upper bound on files read by the scan. */
  maxFiles?: number;
}

/** Options accepted under `plugins.namespace-proxy` in `codegraph.json`. */
export interface NamespaceProxyPluginOptions {
  objects?: string[];
  registry?: NamespaceRegistryOptions | NamespaceRegistryOptions[];
  assignments?: NamespaceAssignmentOptions;
}

/** Validated, normalized form of one registry entry. */
interface NormalizedRegistry {
  filePatterns: RegExp[];
  /** `null` means "every object in `objects`". */
  objects: ReadonlySet<string> | null;
  level: RegistryLevel;
  prefix: string;
}

/** Validated, normalized form of the assignment scan. */
interface NormalizedAssignments {
  objects: ReadonlySet<string> | null;
  /** `null` means "every indexed file". */
  includePatterns: RegExp[] | null;
  operators: string[];
  topLevelOnly: boolean;
  maxFiles: number;
}

/** Validated, normalized plugin config for one project root. */
interface NormalizedConfig {
  objects: ReadonlySet<string>;
  registries: NormalizedRegistry[];
  assignments: NormalizedAssignments | null;
}

const DEFAULT_OPERATORS = ['=', '??=', '||=', '&&='] as const;
const DEFAULT_MAX_SCAN_FILES = 20000;
const DEFAULT_PREFIX = '$';

/**
 * Kinds that may receive a *file*-node target. A `calls`/`references` edge into
 * a file still tells an agent where the member lives; a `type_of`/`implements`
 * edge into a file is noise.
 */
const FILE_FALLBACK_KINDS = new Set(['calls', 'references']);

/** Preference order when several nodes in the defining file share the name. */
const TARGET_KIND_RANK: Record<string, number> = {
  function: 0,
  method: 1,
  class: 2,
  interface: 3,
  type_alias: 4,
  constant: 5,
  variable: 6,
  property: 7,
  field: 8,
};

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** Per-root normalized config, valid for one project-config generation. */
const configCache = new Map<string, NormalizedConfig | null>();
let configGeneration = getProjectConfigGeneration();

/**
 * Namespace objects claimed by ANY project detected in this process, unioned.
 *
 * `claimsReference(name)` receives no context and therefore no project root, so
 * it cannot ask which project it is being called for. A union is safe: the
 * hook is a pre-filter only — a name it lets through still has to survive
 * `resolve()`, which IS root-aware and re-checks `objects` against that
 * project's own config.
 */
const claimedByRoot = new Map<string, ReadonlySet<string>>();
let claimedObjects = new Set<string>();

function rebuildClaimedObjects(): void {
  const next = new Set<string>();
  for (const objects of claimedByRoot.values()) {
    for (const object of objects) next.add(object);
  }
  claimedObjects = next;
}

function stringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || !entry.trim()) continue;
    out.push(entry.trim());
  }
  return out;
}

/**
 * Glob → anchored RegExp over project-relative POSIX paths. Supports `**`,
 * `*`, `?`. A pattern with no wildcard also matches everything beneath it, so
 * `"src/services"` means the directory, not just a file of that exact name.
 */
function globToRegExp(pattern: string): RegExp | null {
  const normalized = pattern.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
  if (!normalized) return null;

  if (!/[*?]/.test(normalized)) {
    const escaped = normalized.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`^${escaped}(?:/.*)?$`);
  }

  let out = '';
  for (let i = 0; i < normalized.length; i++) {
    const ch = normalized[i]!;
    if (ch === '*') {
      if (normalized[i + 1] === '*') {
        // `**/` spans zero or more directories; a trailing `**` spans the rest.
        if (normalized[i + 2] === '/') {
          out += '(?:.*/)?';
          i += 2;
        } else {
          out += '.*';
          i += 1;
        }
      } else {
        out += '[^/]*';
      }
      continue;
    }
    if (ch === '?') {
      out += '[^/]';
      continue;
    }
    out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`);
}

function compilePatterns(patterns: string[], where: string): RegExp[] {
  const compiled: RegExp[] = [];
  for (const pattern of patterns) {
    const regex = globToRegExp(pattern);
    if (!regex) {
      logWarn(`Ignoring an empty pattern in "plugins.namespace-proxy.${where}"`);
      continue;
    }
    compiled.push(regex);
  }
  return compiled;
}

function matchesAny(patterns: RegExp[], filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/');
  for (const pattern of patterns) {
    if (pattern.test(normalized)) return true;
  }
  return false;
}

/** Warn-and-skip validation of one registry entry. */
function normalizeRegistry(
  raw: unknown,
  objects: ReadonlySet<string>
): NormalizedRegistry | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    logWarn('Ignoring "plugins.namespace-proxy.registry": each entry must be an object');
    return null;
  }
  const entry = raw as NamespaceRegistryOptions;

  const files = stringArray(entry.files);
  if (!files || files.length === 0) {
    logWarn('Ignoring a "plugins.namespace-proxy.registry" entry: "files" must be a non-empty array of paths or globs');
    return null;
  }
  const filePatterns = compilePatterns(files, 'registry.files');
  if (filePatterns.length === 0) return null;

  let entryObjects: ReadonlySet<string> | null = null;
  if (entry.objects !== undefined) {
    const declared = stringArray(entry.objects);
    if (!declared) {
      logWarn('Ignoring "plugins.namespace-proxy.registry.objects": must be an array of namespace object names');
    } else {
      // A registry may only ever map objects the project declared up top.
      const scoped = declared.filter((name) => objects.has(name));
      for (const name of declared) {
        if (!objects.has(name)) {
          logWarn(`Ignoring "${name}" in "plugins.namespace-proxy.registry.objects": not listed in "objects"`);
        }
      }
      if (scoped.length === 0) return null;
      entryObjects = new Set(scoped);
    }
  }

  let level: RegistryLevel = 'member';
  if (entry.level !== undefined) {
    if (entry.level === 'member' || entry.level === 'namespace') {
      level = entry.level;
    } else {
      logWarn('Ignoring "plugins.namespace-proxy.registry.level": must be "member" or "namespace"');
    }
  }

  let prefix = DEFAULT_PREFIX;
  if (entry.prefix !== undefined) {
    if (typeof entry.prefix === 'string') {
      prefix = entry.prefix;
    } else {
      logWarn('Ignoring "plugins.namespace-proxy.registry.prefix": must be a string');
    }
  }

  return { filePatterns, objects: entryObjects, level, prefix };
}

/** Warn-and-skip validation of the assignment scan. */
function normalizeAssignments(
  raw: unknown,
  objects: ReadonlySet<string>
): NormalizedAssignments | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    logWarn('Ignoring "plugins.namespace-proxy.assignments": must be an object');
    return null;
  }
  const entry = raw as NamespaceAssignmentOptions;

  let entryObjects: ReadonlySet<string> | null = null;
  if (entry.objects !== undefined) {
    const declared = stringArray(entry.objects);
    if (!declared) {
      logWarn('Ignoring "plugins.namespace-proxy.assignments.objects": must be an array of namespace object names');
    } else {
      const scoped = declared.filter((name) => objects.has(name));
      for (const name of declared) {
        if (!objects.has(name)) {
          logWarn(`Ignoring "${name}" in "plugins.namespace-proxy.assignments.objects": not listed in "objects"`);
        }
      }
      if (scoped.length === 0) return null;
      entryObjects = new Set(scoped);
    }
  }

  let includePatterns: RegExp[] | null = null;
  if (entry.include !== undefined) {
    const declared = stringArray(entry.include);
    if (!declared) {
      logWarn('Ignoring "plugins.namespace-proxy.assignments.include": must be an array of globs');
    } else if (declared.length > 0) {
      const compiled = compilePatterns(declared, 'assignments.include');
      if (compiled.length > 0) includePatterns = compiled;
    }
  }

  let operators: string[] = [...DEFAULT_OPERATORS];
  if (entry.operators !== undefined) {
    const declared = stringArray(entry.operators);
    if (!declared) {
      logWarn('Ignoring "plugins.namespace-proxy.assignments.operators": must be an array of operator strings');
    } else {
      const known = declared.filter((op) => (DEFAULT_OPERATORS as readonly string[]).includes(op));
      for (const op of declared) {
        if (!(DEFAULT_OPERATORS as readonly string[]).includes(op)) {
          logWarn(`Ignoring "${op}" in "plugins.namespace-proxy.assignments.operators": supported operators are ${DEFAULT_OPERATORS.join(', ')}`);
        }
      }
      if (known.length === 0) return null;
      operators = known;
    }
  }

  let topLevelOnly = true;
  if (entry.topLevelOnly !== undefined) {
    if (typeof entry.topLevelOnly === 'boolean') {
      topLevelOnly = entry.topLevelOnly;
    } else {
      logWarn('Ignoring "plugins.namespace-proxy.assignments.topLevelOnly": must be a boolean');
    }
  }

  let maxFiles = DEFAULT_MAX_SCAN_FILES;
  if (entry.maxFiles !== undefined) {
    if (typeof entry.maxFiles === 'number' && Number.isFinite(entry.maxFiles) && entry.maxFiles > 0) {
      maxFiles = Math.floor(entry.maxFiles);
    } else {
      logWarn('Ignoring "plugins.namespace-proxy.assignments.maxFiles": must be a positive number');
    }
  }

  return { objects: entryObjects, includePatterns, operators, topLevelOnly, maxFiles };
}

/**
 * The project's validated config, or `null` when the plugin is off or its
 * config is unusable. Memoized per root for one project-config generation, so
 * this is safe to call from `resolve()` (i.e. once per unresolved reference).
 */
function getConfig(projectRoot: string): NormalizedConfig | null {
  const generation = getProjectConfigGeneration();
  if (generation !== configGeneration) {
    configCache.clear();
    configGeneration = generation;
  }
  const hit = configCache.get(projectRoot);
  if (hit !== undefined) return hit;

  let config: NormalizedConfig | null = null;
  try {
    if (isPluginEnabled(projectRoot, NAMESPACE_PROXY_PLUGIN_NAME)) {
      const options = getPluginOptions<NamespaceProxyPluginOptions>(
        projectRoot,
        NAMESPACE_PROXY_PLUGIN_NAME
      );

      const declared = stringArray(options.objects);
      if (!declared) {
        logWarn('Ignoring "plugins.namespace-proxy": "objects" must be an array of namespace object names');
      } else if (declared.length === 0) {
        logWarn('Ignoring "plugins.namespace-proxy": "objects" is empty, so nothing can be claimed');
      } else {
        const objects: ReadonlySet<string> = new Set(declared);

        const registries: NormalizedRegistry[] = [];
        if (options.registry !== undefined) {
          const rawEntries = Array.isArray(options.registry) ? options.registry : [options.registry];
          for (const rawEntry of rawEntries) {
            const normalized = normalizeRegistry(rawEntry, objects);
            if (normalized) registries.push(normalized);
          }
        }

        const assignments =
          options.assignments === undefined
            ? null
            : normalizeAssignments(options.assignments, objects);

        if (registries.length === 0 && !assignments) {
          logWarn('Ignoring "plugins.namespace-proxy": neither "registry" nor "assignments" is configured, so there is no resolution strategy to run');
        } else {
          config = { objects, registries, assignments };
        }
      }
    }
  } catch (error) {
    // A plugin must never be the reason an index fails.
    logDebug('namespace-proxy: config load failed', { error: String(error) });
    config = null;
  }

  configCache.set(projectRoot, config);
  return config;
}

// ---------------------------------------------------------------------------
// Strategy 1 — registry-backed
// ---------------------------------------------------------------------------

/** `key → { file, symbol }`, keyed by member name or by namespace object name. */
type RegistryMap = Map<string, { file: string; symbol: string }>;

/** One map per registry entry, in config order. */
const registryMemo = new WeakMap<ResolutionContext, RegistryMap[]>();

const IMPORT_LANGUAGE_BY_EXT: Record<string, Language> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.d.ts': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.py': 'python',
  '.go': 'go',
  '.java': 'java',
  '.kt': 'kotlin',
  '.php': 'php',
};

function importLanguageFor(filePath: string): Language {
  const ext = path.extname(filePath).toLowerCase();
  return IMPORT_LANGUAGE_BY_EXT[ext] ?? 'typescript';
}

function buildRegistryMaps(context: ResolutionContext, config: NormalizedConfig): RegistryMap[] {
  const maps: RegistryMap[] = [];
  const allFiles = config.registries.length > 0 ? context.getAllFiles() : [];

  for (const registry of config.registries) {
    const map: RegistryMap = new Map();
    const files = allFiles.filter((file) => matchesAny(registry.filePatterns, file));

    for (const file of files) {
      const language = importLanguageFor(file);
      let mappings;
      try {
        mappings = context.getImportMappings(file, language);
      } catch (error) {
        logDebug('namespace-proxy: registry import parse failed', { file, error: String(error) });
        continue;
      }

      for (const mapping of mappings) {
        if (!mapping.localName || mapping.isNamespace) continue;
        let resolved: string | null;
        try {
          resolved =
            mapping.resolvedPath ??
            resolveImportPath(mapping.source, file, language, context);
        } catch (error) {
          logDebug('namespace-proxy: registry import path unresolved', {
            file,
            source: mapping.source,
            error: String(error),
          });
          continue;
        }
        if (!resolved) continue;

        // The name the namespace exposes is the LOCAL name (that is the key the
        // registry object literal is built from); the symbol to look for inside
        // the defining file is the EXPORTED name, which differs under `as`.
        const key =
          registry.level === 'namespace'
            ? `${registry.prefix}${mapping.localName}`
            : mapping.localName;
        const symbol = mapping.isDefault ? mapping.localName : mapping.exportedName || mapping.localName;

        // First import wins: a duplicate name across two registry files is
        // ambiguous, and the earlier (config-ordered) file is the better guess.
        if (!map.has(key)) map.set(key, { file: resolved, symbol });
      }
    }

    if (map.size > 0) {
      logDebug('namespace-proxy: registry map built', { files: files.length, members: map.size });
    }
    maps.push(map);
  }

  return maps;
}

function getRegistryMaps(context: ResolutionContext, config: NormalizedConfig): RegistryMap[] {
  let maps = registryMemo.get(context);
  if (!maps) {
    maps = buildRegistryMaps(context, config);
    registryMemo.set(context, maps);
  }
  return maps;
}

// ---------------------------------------------------------------------------
// Strategy 2 — assignment scan
// ---------------------------------------------------------------------------

interface AssignmentSite {
  file: string;
  /** Identifier on the right-hand side, when the assignment names one. */
  rhs?: string;
}

/**
 * `object → member-path → sites`. A `$ns.a.b = …` definition is filed under
 * both `"a.b"` (so `$ns.a.b(…)` matches exactly) and `"a"` (so a reference that
 * only reaches the first segment still lands in the right file).
 */
type AssignmentMap = Map<string, Map<string, AssignmentSite[]>>;

const assignmentMemo = new WeakMap<ResolutionContext, AssignmentMap>();

/** Extensions the assignment scan reads. The pattern is a JS/TS-family idiom. */
const SCANNABLE_EXT = /\.(?:[cm]?[jt]sx?|ets|svelte|vue|astro)$/i;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * `<object>.<member>[.<more>] <op> …`, anchored so it cannot fire inside a
 * longer identifier, and with `==`/`!=`/`>=`/`+=` and friends excluded.
 */
function buildAssignmentRegex(object: string, operators: string[]): RegExp {
  const ops = [...operators]
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp)
    .join('|');
  return new RegExp(
    `(?:^|[^\\w$.])${escapeRegExp(object)}` +
      `\\.([A-Za-z_$][\\w$]*)((?:\\.[A-Za-z_$][\\w$]*)*)` +
      `\\s*(?<![=!<>+\\-*/%&|^])(?:${ops})(?!=)`,
    'g'
  );
}

const RHS_PATTERNS: RegExp[] = [
  /^\s*(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/,
  /^\s*class\s+([A-Za-z_$][\w$]*)/,
  /^\s*(?:new\s+)?([A-Za-z_$][\w$]*)\s*[;,()]?\s*$/,
];

function extractRhsIdentifier(rest: string): string | undefined {
  for (const pattern of RHS_PATTERNS) {
    const match = pattern.exec(rest);
    if (match?.[1]) return match[1];
  }
  return undefined;
}

function buildAssignmentMap(
  context: ResolutionContext,
  assignments: NormalizedAssignments,
  objects: ReadonlySet<string>
): AssignmentMap {
  const map: AssignmentMap = new Map();
  const scanObjects = [...(assignments.objects ?? objects)];
  if (scanObjects.length === 0) return map;

  const regexes = scanObjects.map(
    (object) => [object, buildAssignmentRegex(object, assignments.operators)] as const
  );

  let scanned = 0;
  for (const file of context.getAllFiles()) {
    if (scanned >= assignments.maxFiles) {
      logWarn(`"plugins.namespace-proxy.assignments" stopped after ${assignments.maxFiles} files; narrow "include" or raise "maxFiles"`);
      break;
    }
    if (!SCANNABLE_EXT.test(file)) continue;
    if (assignments.includePatterns && !matchesAny(assignments.includePatterns, file)) continue;

    let content: string | null;
    try {
      content = context.readFile(file);
    } catch {
      continue;
    }
    if (!content) continue;
    scanned++;

    // Cheap gate before the (stripping + regex) cost.
    let interesting = false;
    for (const [object] of regexes) {
      if (content.includes(`${object}.`)) {
        interesting = true;
        break;
      }
    }
    if (!interesting) continue;

    const stripped = stripCommentsForRegex(content, 'typescript');

    for (const [object, regex] of regexes) {
      regex.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = regex.exec(stripped)) !== null) {
        const member = match[1];
        if (!member) continue;

        // A dynamic export is a top-level statement. The leading `(?:^|[^\w$.])`
        // consumes one character unless the object sits at offset 0, so the
        // object's own start is one past the match index in every other case.
        if (assignments.topLevelOnly) {
          const objectStart = stripped.startsWith(object, match.index)
            ? match.index
            : match.index + 1;
          const lineStart = stripped.lastIndexOf('\n', match.index) + 1;
          if (objectStart !== lineStart) continue;
        }

        const after = stripped.slice(match.index + match[0].length);
        const eol = after.indexOf('\n');
        const rhs = extractRhsIdentifier(eol === -1 ? after : after.slice(0, eol));

        let byMember = map.get(object);
        if (!byMember) {
          byMember = new Map();
          map.set(object, byMember);
        }
        const suffix = match[2] ?? '';
        const keys = suffix ? [`${member}${suffix}`, member] : [member];
        for (const key of keys) {
          const sites = byMember.get(key);
          if (sites) sites.push({ file, rhs });
          else byMember.set(key, [{ file, rhs }]);
        }
      }
    }
  }

  return map;
}

function getAssignmentMap(context: ResolutionContext, config: NormalizedConfig): AssignmentMap {
  let map = assignmentMemo.get(context);
  if (!map) {
    map = config.assignments
      ? buildAssignmentMap(context, config.assignments, config.objects)
      : new Map();
    assignmentMemo.set(context, map);
  }
  return map;
}

// ---------------------------------------------------------------------------
// Target selection
// ---------------------------------------------------------------------------

function rank(node: Node): number {
  return TARGET_KIND_RANK[node.kind] ?? 50;
}

/**
 * The best non-file node in `file` named any of `names`, in name order. `null`
 * when the file declares none of them.
 */
function findSymbolInFile(
  context: ResolutionContext,
  file: string,
  names: (string | undefined)[]
): Node | null {
  let nodes: Node[];
  try {
    nodes = context.getNodesInFile(file);
  } catch {
    return null;
  }
  if (nodes.length === 0) return null;

  for (const name of names) {
    if (!name) continue;
    let best: Node | null = null;
    for (const node of nodes) {
      if (node.kind === 'file' || node.name !== name) continue;
      if (!best || rank(node) < rank(best)) best = node;
    }
    if (best) return best;
  }
  return null;
}

function findFileNode(context: ResolutionContext, file: string): Node | null {
  try {
    for (const node of context.getNodesInFile(file)) {
      if (node.kind === 'file') return node;
    }
  } catch {
    return null;
  }
  return null;
}

function resolvedTo(ref: UnresolvedRef, targetNodeId: string, confidence: number): ResolvedRef {
  return { original: ref, targetNodeId, confidence, resolvedBy: 'framework' };
}

/**
 * Turn a known defining file into an edge target.
 *
 * `symbolNames` are tried in order against the file's own symbols; only if none
 * of them is declared there do we consider the file node itself, and only for a
 * reference kind where a file target is meaningful.
 */
/**
 * The part of a file's basename before its first dot — `widget.bg.ts`,
 * `widget.ts` and `widget.pp.tsx` all reduce to `widget`.
 *
 * Deliberately dot-naive rather than layer-aware: the layer suffix vocabulary
 * belongs to the layer-chain plugin's config, and duplicating it here would
 * couple two plugins that are meant to stay independent. Everything after the
 * first dot is a tag or an extension either way, so the first segment is the
 * stem under any vocabulary.
 */
function fileStem(filePath: string): string {
  const slash = filePath.lastIndexOf('/');
  const base = slash === -1 ? filePath : filePath.slice(slash + 1);
  const dot = base.indexOf('.');
  return dot === -1 ? base : base.slice(0, dot);
}

/** The directory portion of a project-relative path (`''` at the root). */
function fileDir(filePath: string): string {
  const slash = filePath.lastIndexOf('/');
  return slash === -1 ? '' : filePath.slice(0, slash);
}

/**
 * Whether `target` is a layer sibling of `from` — same directory, same stem,
 * different file (`widget.bg.ts` → `widget.ts`).
 *
 * This is precisely the layer-chain plugin's territory, and it is the reason
 * this plugin abstains on some `extends` refs: namespace-proxy is registered
 * FIRST, so without this check it would silently pre-empt layer-chain on the
 * case layer-chain models better (it understands tag-set generality; we only
 * know the registry said "this name lives in that file").
 */
function isLayerSibling(from: string, target: string): boolean {
  if (from === target) return false;
  return fileDir(from) === fileDir(target) && fileStem(from) === fileStem(target);
}

function targetInFile(
  context: ResolutionContext,
  ref: UnresolvedRef,
  file: string,
  symbolNames: (string | undefined)[],
  symbolConfidence: number,
  fileConfidence: number
): ResolvedRef | null {
  const symbol = findSymbolInFile(context, file, symbolNames);
  if (symbol) return resolvedTo(ref, symbol.id, symbolConfidence);

  if (!FILE_FALLBACK_KINDS.has(ref.referenceKind)) return null;
  const fileNode = findFileNode(context, file);
  return fileNode ? resolvedTo(ref, fileNode.id, fileConfidence) : null;
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export const namespaceProxyPlugin: FrameworkResolver = {
  name: NAMESPACE_PROXY_PLUGIN_NAME,

  detect(context: ResolutionContext): boolean {
    try {
      const root = context.getProjectRoot();
      const config = getConfig(root);
      // Keep the `claimsReference` union in step with what this root claims —
      // including dropping it when the project turned the plugin back off.
      const previous = claimedByRoot.get(root);
      if (config) {
        claimedByRoot.set(root, config.objects);
        if (previous !== config.objects) rebuildClaimedObjects();
      } else if (previous) {
        claimedByRoot.delete(root);
        rebuildClaimedObjects();
      }
      return config !== null;
    } catch {
      return false;
    }
  },

  /**
   * Opt `"<object>.<member>"` past the resolver's "no node has this name"
   * pre-filter — without this every namespace reference is dropped before
   * `resolve()` is ever called.
   *
   * Hot path: one `indexOf`, one `Set.has`, no allocation beyond the object
   * slice. Deliberately name-only and root-agnostic (the hook has no context);
   * `resolve()` re-checks against the right project's config, so a union
   * false-positive costs one extra `resolve()` call and nothing else.
   */
  claimsReference(name: string): boolean {
    if (claimedObjects.size === 0) return false;
    const dot = name.indexOf('.');
    if (dot <= 0 || dot === name.length - 1) return false;
    return claimedObjects.has(name.slice(0, dot));
  },

  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
    // `extends` is shared territory, split by TARGET SHAPE (ROADMAP 1e).
    //
    // The layer-chain plugin owns inheritance from a same-stem layer sibling
    // (`widget.bg.ts extends $.Widget` → `widget.ts`) and models it properly.
    // But it deliberately abstains when the base class lives in a DIFFERENT
    // module (`widget.bg.ts extends $.Unit` → `unit/unit.ts`) because it has no
    // namespace map to resolve that with — leaving the single most common dead
    // `extends` reference owned by nobody.
    //
    // We can close exactly that gap, and only under the registry strategy: a
    // registry hit is an authoritative name→file mapping, not a guess. The
    // assignment scan is barred below, because a wrong inheritance edge is far
    // worse than a missing one — it corrupts every type-hierarchy query, where
    // a wrong `calls` edge only adds noise to one trail.
    const isExtends = ref.referenceKind === 'extends';

    const name = ref.referenceName;
    const dot = name.indexOf('.');
    if (dot <= 0 || dot === name.length - 1) return null;

    const object = name.slice(0, dot);
    const rest = name.slice(dot + 1);
    const nextDot = rest.indexOf('.');
    const member = nextDot === -1 ? rest : rest.slice(0, nextDot);
    if (!member) return null;
    // `$ns.a.b.c` — `a` is the member; `c` is the symbol most likely being
    // called, and it is only ever looked for INSIDE the file `a` resolves to.
    const lastDot = rest.lastIndexOf('.');
    const tail = lastDot === -1 ? undefined : rest.slice(lastDot + 1) || undefined;

    let config: NormalizedConfig | null;
    try {
      config = getConfig(context.getProjectRoot());
    } catch {
      return null;
    }
    if (!config || !config.objects.has(object)) return null;

    // Strategy 1 — registry-backed. Exact, so it wins and scores high.
    if (config.registries.length > 0) {
      const maps = getRegistryMaps(context, config);
      for (let i = 0; i < config.registries.length; i++) {
        const registry = config.registries[i]!;
        if (registry.objects && !registry.objects.has(object)) continue;
        const map = maps[i];
        if (!map || map.size === 0) continue;

        if (registry.level === 'namespace') {
          const hit = map.get(object);
          if (!hit) continue;
          // Same-stem sibling → layer-chain's edge, not ours (see `isExtends`).
          if (isExtends && isLayerSibling(ref.filePath, hit.file)) return null;
          // The registry named the module; `member` is the symbol inside it.
          const result = targetInFile(context, ref, hit.file, [tail, member], 0.95, 0.8);
          if (result) return result;
          continue;
        }

        const hit = map.get(member);
        if (!hit) continue;
        if (isExtends && isLayerSibling(ref.filePath, hit.file)) return null;
        const result = targetInFile(context, ref, hit.file, [tail, hit.symbol, member], 0.95, 0.8);
        if (result) return result;
      }
    }

    // Strategy 2 — assignment scan. Mechanical, so it scores lower and refuses
    // to guess between two candidate definition files. Never used for
    // `extends`: an inferred inheritance edge is not worth its blast radius.
    if (config.assignments && !isExtends) {
      const byMember = getAssignmentMap(context, config).get(object);
      // Longest match first: `$ns.a.b` prefers a `$ns.a.b = …` definition over
      // the `$ns.a = …` one it also nests under.
      const sites = (rest !== member ? byMember?.get(rest) : undefined) ?? byMember?.get(member);
      if (sites && sites.length > 0) {
        const files = new Set(sites.map((site) => site.file));
        if (files.size === 1) {
          const file = sites[0]!.file;
          const rhsNames = sites.map((site) => site.rhs);
          const result = targetInFile(
            context,
            ref,
            file,
            [tail, member, ...rhsNames],
            0.75,
            0.6
          );
          if (result) return result;
        } else {
          logDebug('namespace-proxy: ambiguous assignment sites, skipping', {
            reference: name,
            files: files.size,
          });
        }
      }
    }

    return null;
  },
};

/**
 * Test/maintenance hook: forget the per-root config memo and the
 * `claimsReference` union. Per-context maps live in `WeakMap`s keyed by the
 * resolution context and need no explicit reset.
 */
export function clearNamespaceProxyCaches(): void {
  configCache.clear();
  configGeneration = getProjectConfigGeneration();
  claimedByRoot.clear();
  claimedObjects = new Set<string>();
}
