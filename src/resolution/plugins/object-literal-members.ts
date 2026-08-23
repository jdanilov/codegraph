/**
 * Object-literal member extraction — ROADMAP item 1i.
 *
 * ## The problem
 *
 * A codebase that publishes its modules by assigning an object literal onto a
 * namespace object
 *
 *   $ns.controller = {
 *     async init () { … },
 *     async refresh () { … },
 *     timeout: 5000,
 *   };
 *
 * extracts to a FILE NODE AND NOTHING ELSE. `init` and `refresh` never become
 * symbols, so nothing can point at them: an event-bus subscription naming one as
 * its handler has no target, `codegraph_node("refresh")` says "not found", and
 * every flow question that crosses the module ends in a Read.
 *
 * This is NOT a JavaScript-vs-TypeScript difference — the identical file as
 * `a.js` and as `b.ts` both yield only the file node. Core *has* the walker
 * (`extractObjectLiteralFunctions` in `extraction/tree-sitter.ts`), but it hangs
 * off the VARIABLE-DECLARATION path and is additionally gated on the declaration
 * being exported. A statement-level `$ns.member = { … }` is an
 * `assignment_expression`, so it never reaches that code at all.
 *
 * ## What this plugin does
 *
 * For files a project opts in, it re-parses the source with the SAME tree-sitter
 * grammar core used (grammars are already loaded and in memory when `extract()`
 * runs, and `getParser` hands them back synchronously), finds
 * `<configured object>.<member…> = { … }` assignments, and emits one node per
 * function-valued property of the assigned object literal — plus, optionally, a
 * node for the assigned object itself, and a `contains` edge from that container
 * to each member it mints.
 *
 * The containment edges matter as much as the nodes. Core emits `contains` from
 * the node stack its tree-sitter walk maintains, which a resolver running after
 * the walk cannot join (the same constraint `reattributeFileScopeRefs` exists
 * for) — so before those edges were emitted here, a container and its members
 * were minted as siblings with nothing joining them: a component's own methods
 * were structurally invisible to `getContainedNodes`, to containment-shaped MCP
 * answers, and to every consumer that reads the backbone.
 *
 * It is an AST walk, deliberately: a regex over raw text would mint NODES, and a
 * wrong node is worse than a wrong edge — every edge later resolved onto it
 * inherits the error. Anything the grammar doesn't hand back in exactly the
 * expected shape (computed member access, a call-wrapped right-hand side, a
 * spread) is skipped rather than guessed at.
 *
 * ## Configuration (`codegraph.json`)
 *
 * ```jsonc
 * {
 *   "plugins": {
 *     "object-literal-members": {
 *       // REQUIRED. The assignment TARGETS whose object literals are module
 *       // definitions, written exactly as they appear in source. An entry may
 *       // be dotted (`"module.exports"`, `"window.App"`); the longest matching
 *       // entry wins. NOTHING outside this list is ever touched — the plugin
 *       // never infers a namespace from a `$` prefix or from any other shape.
 *       "objects": ["$ns", "module.exports"],
 *
 *       // Project-relative globs bounding which files are scanned. Omit to scan
 *       // every file of a configured language. Supports `**`, `*`, `?`; a
 *       // pattern with no wildcard also matches everything beneath it.
 *       "include": ["src/legacy/**"],
 *
 *       // Language scope. Subset of the JS family this plugin supports:
 *       // javascript, jsx, typescript, tsx. Default: all four.
 *       "languages": ["javascript", "jsx"],
 *
 *       // Assignment operators that count as a module definition.
 *       // Default: ["=", "??=", "||=", "&&="].
 *       "operators": ["=", "??="],
 *
 *       // Only consider assignments that are top-level statements of the file.
 *       // Default true, and it is the main precision lever: a module definition
 *       // is a top-level statement, whereas `this.state = { … }` or an options
 *       // bag passed inside a function is not a module. Set false for a
 *       // codebase that wraps its definitions in an IIFE.
 *       "topLevelOnly": true,
 *
 *       // How many member segments the assignment target may carry after the
 *       // configured object: `$ns.controller` is 1, `$ns.ui.panel` is 2.
 *       // Default 2, hard cap 6.
 *       "maxMemberDepth": 2,
 *
 *       // How many levels of object literal to descend. 1 (default) means the
 *       // assigned object's own properties; 2 also descends one level of nested
 *       // object literals (`{ ui: { open () {} } }`). Hard cap 4.
 *       "maxDepth": 1,
 *
 *       // Emit a node for the assigned object itself (named by the last segment
 *       // of the target, e.g. `controller`), so a reference to the CONTAINER
 *       // resolves to a symbol instead of falling back to the file node.
 *       // Default true.
 *       "emitContainer": true,
 *
 *       // Node-explosion valve: at most this many nodes from one file.
 *       // Default 500.
 *       "maxNodesPerFile": 500,
 *
 *       // Callee dotted-paths whose CALL may wrap the object literal:
 *       // `$ns.Widget = $ui.component('Widget', { … })` descends into the
 *       // literal exactly as if it were the direct right-hand side, and the
 *       // container node gets kind `component` (it is a UI component
 *       // definition). Exact-match only — there is deliberately no "unwrap
 *       // any call" mode, because a factory that does NOT treat its object
 *       // argument as a member table would mint wrong nodes. When a wrapper
 *       // call carries several object-literal arguments, the LAST one is used
 *       // (the options/definition-object convention); a wrapper call with no
 *       // object-literal argument abstains. Default: none.
 *       "wrappers": ["$ui.component"],
 *
 *       // Move the file-scope references that fall inside an emitted node's
 *       // span onto that node (see `FrameworkExtractionResult.
 *       // reattributeFileScopeRefs`). Default true — without it the graph says
 *       // "this FILE calls X" where the truth is "this member calls X", which
 *       // is a half-bridged flow: the agent gets a hop it then has to read the
 *       // file to finish. Set false to keep the file-level attribution.
 *       "reattributeReferences": true
 *     }
 *   }
 * }
 * ```
 *
 * A project with no `plugins.object-literal-members` entry gets exactly the
 * behavior it had before this file existed: `detect()` is false, the plugin is
 * not among the detected frameworks, and `extract()` is never called.
 *
 * ## Precision safeguards
 *
 *   - **Explicit targets only.** `$foo.bar = { … }` is invisible unless `"$foo"`
 *     (or `"$foo.bar"`) is in `objects`.
 *   - **Real AST, never text.** The target must be a chain of plain
 *     `identifier` / `property_identifier` links; a computed access
 *     (`$ns[key] = …`) or any other shape abstains. The value must be an object
 *     literal *directly* — a call that returns one is unwrapped only when its
 *     callee is explicitly listed in `wrappers`.
 *   - **Function members only, and only when there are some.** A pure data/config
 *     object (`{ a: 1, b: 2 }`) emits NOTHING, including no container node. This
 *     mirrors core's own `hasInlineFns` gate and is what keeps a config-heavy
 *     repo from doubling its node count.
 *   - **Ids are core's ids.** `generateNodeId(filePath, kind, name, line)` — the
 *     same helper and the same inputs core uses, so an id is stable across
 *     re-indexes and a sync doesn't churn edges.
 *   - **Qualified names follow core's `::` hierarchy**, rooted at the assignment
 *     target as written: `$ns.controller` for the container, `$ns.controller::init`
 *     for a member. The member's simple NAME is the bare key (`init`), which is
 *     what the namespace-proxy plugin looks for when it resolves
 *     `$ns.controller.init` into this file.
 *
 * ## Cost
 *
 * This re-parses files the pipeline already parsed, so the work is gated before
 * the parse: extension → configured language → `include` globs → a substring
 * scan for `"<object>."` in the raw text. A file that can't possibly match is
 * never handed to a parser.
 *
 * ## Hooks
 *
 *   - `detect` — config gate, exactly like `./noop.ts`. Also records the project
 *     root, because `extract()` is given only a file path (see below).
 *   - `extract` — the whole plugin. Its result also opts into
 *     `reattributeFileScopeRefs`, so the calls made by an emitted member stop
 *     being attributed to the file node (see the option of the same name).
 *   - `resolve` — required by the interface; always null. This plugin mints
 *     symbols, it does not resolve references. The nodes it emits are ordinary
 *     symbols that every existing resolver (namespace-proxy, event-bus, plain
 *     name matching) can then aim at.
 *
 * ### How `extract()` learns the project root
 *
 * `extract(filePath, content)` gets no `ResolutionContext`, and in a parse WORKER
 * (`extraction/parse-worker.ts`) `detect()` never runs at all — the worker
 * statically imports the registry and filters it by name. The root comes from
 * `getExtractionProjectRoot()` (plugin-config): the orchestrator sets it on the
 * main thread before extraction starts, and the parse pool forwards it to every
 * worker in the `load-grammars` message.
 */
import * as path from 'node:path';
import type { Node as SyntaxNode } from 'web-tree-sitter';
import type { Edge, Language, Node, NodeKind } from '../../types';
import { logDebug, logWarn } from '../../errors';
import { getProjectConfigGeneration } from '../../project-config';
import { generateNodeId, getChildByField, getNodeText, getPrecedingDocstring } from '../../extraction/tree-sitter-helpers';
import { getParser } from '../../extraction/grammars';
import type {
  FrameworkExtractionResult,
  FrameworkResolver,
  ResolutionContext,
  ResolvedRef,
  UnresolvedRef,
} from '../types';
import { getExtractionProjectRoot, getPluginOptions, isPluginEnabled } from './plugin-config';

/** Config key and registry name for this plugin. */
export const OBJECT_LITERAL_MEMBERS_PLUGIN_NAME = 'object-literal-members';

/** Options accepted under `plugins.object-literal-members` in `codegraph.json`. */
export interface ObjectLiteralMembersOptions {
  /** Assignment targets whose object literals are module definitions. */
  objects?: string[];
  /** Project-relative globs bounding the scan; omit to scan everything. */
  include?: string[];
  /** Language scope; omit for the whole JS family. */
  languages?: string[];
  /** Assignment operators counting as a definition. */
  operators?: string[];
  /** Only consider top-level statements. Default true. */
  topLevelOnly?: boolean;
  /** Member segments allowed after the configured object. Default 2. */
  maxMemberDepth?: number;
  /** Levels of object literal to descend. Default 1. */
  maxDepth?: number;
  /** Emit a node for the assigned object itself. Default true. */
  emitContainer?: boolean;
  /** Upper bound on nodes emitted from one file. Default 500. */
  maxNodesPerFile?: number;
  /** Move file-scope references into the emitted spans. Default true. */
  reattributeReferences?: boolean;
  /** Callee dotted-paths whose call may wrap the object literal. Default none. */
  wrappers?: string[];
}

/** Validated, normalized plugin config for one project root. */
interface NormalizedConfig {
  /** Configured targets, pre-split into segments, longest first. */
  objects: string[][];
  /** Raw target strings, for the cheap pre-parse substring gate. */
  objectPrefixes: string[];
  includePatterns: RegExp[] | null;
  languages: ReadonlySet<Language>;
  operators: ReadonlySet<string>;
  topLevelOnly: boolean;
  maxMemberDepth: number;
  maxDepth: number;
  emitContainer: boolean;
  maxNodesPerFile: number;
  reattributeReferences: boolean;
  /** Exact callee texts whose call wraps the member table. Empty = no unwrap. */
  wrappers: ReadonlySet<string>;
}

/** Languages this plugin understands. The grammar for each is a JS/TS grammar. */
const SUPPORTED_LANGUAGES: readonly Language[] = ['javascript', 'jsx', 'typescript', 'tsx'];

/** Extension → language, restricted to the JS family (mirrors core's map). */
const LANGUAGE_BY_EXT: Record<string, Language> = {
  '.js': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.jsx': 'jsx',
  '.ts': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.tsx': 'tsx',
};

const DEFAULT_OPERATORS = ['=', '??=', '||=', '&&='] as const;
const DEFAULT_MAX_MEMBER_DEPTH = 2;
const MAX_MEMBER_DEPTH_CAP = 6;
const DEFAULT_MAX_DEPTH = 1;
const MAX_DEPTH_CAP = 4;
const DEFAULT_MAX_NODES_PER_FILE = 500;

/** Kind for a member whose value is a function. Matches core's own choice for
 *  object-literal methods (`extractObjectLiteralFunctions` → `extractFunction`). */
const MEMBER_KIND: NodeKind = 'function';

/** Kind for the assigned object itself. It is a value binding, not a type. */
const CONTAINER_KIND: NodeKind = 'variable';

const EMPTY_RESULT: FrameworkExtractionResult = Object.freeze({
  nodes: Object.freeze([]) as unknown as Node[],
  references: Object.freeze([]) as unknown as UnresolvedRef[],
  edges: Object.freeze([]) as unknown as Edge[],
});

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** Per-root normalized config, valid for one project-config generation. */
const configCache = new Map<string, NormalizedConfig | null>();
let configGeneration = getProjectConfigGeneration();

/** Project root recorded by `detect()` on the main thread. */
let activeRoot: string | null = null;

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
 * Glob → anchored RegExp over project-relative POSIX paths. Supports `**`, `*`,
 * `?`. A pattern with no wildcard also matches everything beneath it, so
 * `"src/legacy"` means the directory, not just a file of that exact name.
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

function matchesAny(patterns: RegExp[], filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/');
  for (const pattern of patterns) {
    if (pattern.test(normalized)) return true;
  }
  return false;
}

/** A positive integer option, clamped to `cap`; warn-and-default otherwise. */
function positiveInt(value: unknown, fallback: number, cap: number, where: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) {
    logWarn(`Ignoring "plugins.${OBJECT_LITERAL_MEMBERS_PLUGIN_NAME}.${where}": must be a positive number`);
    return fallback;
  }
  return Math.min(Math.floor(value), cap);
}

function boolOption(value: unknown, fallback: boolean, where: string): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') {
    logWarn(`Ignoring "plugins.${OBJECT_LITERAL_MEMBERS_PLUGIN_NAME}.${where}": must be a boolean`);
    return fallback;
  }
  return value;
}

/** Split a configured target (`"module.exports"`) into its identifier segments,
 *  or null when it isn't a plain dotted identifier chain. */
function splitTarget(target: string): string[] | null {
  const parts = target.split('.');
  if (parts.length === 0) return null;
  for (const part of parts) {
    if (!/^[A-Za-z_$][\w$]*$/.test(part)) return null;
  }
  return parts;
}

function normalize(raw: Readonly<Partial<ObjectLiteralMembersOptions>>): NormalizedConfig | null {
  const declared = stringArray(raw.objects);
  if (!declared) {
    logWarn(`Ignoring "plugins.${OBJECT_LITERAL_MEMBERS_PLUGIN_NAME}": "objects" must be an array of assignment targets`);
    return null;
  }
  if (declared.length === 0) {
    logWarn(`Ignoring "plugins.${OBJECT_LITERAL_MEMBERS_PLUGIN_NAME}": "objects" is empty, so nothing can be extracted`);
    return null;
  }

  const objects: string[][] = [];
  const objectPrefixes: string[] = [];
  for (const target of declared) {
    const parts = splitTarget(target);
    if (!parts) {
      logWarn(`Ignoring "${target}" in "plugins.${OBJECT_LITERAL_MEMBERS_PLUGIN_NAME}.objects": must be a plain (optionally dotted) identifier`);
      continue;
    }
    objects.push(parts);
    objectPrefixes.push(`${parts.join('.')}.`);
  }
  if (objects.length === 0) return null;
  // Longest target first, so `module.exports` is preferred over `module`.
  objects.sort((a, b) => b.length - a.length);

  let includePatterns: RegExp[] | null = null;
  if (raw.include !== undefined) {
    const patterns = stringArray(raw.include);
    if (!patterns) {
      logWarn(`Ignoring "plugins.${OBJECT_LITERAL_MEMBERS_PLUGIN_NAME}.include": must be an array of globs`);
    } else if (patterns.length > 0) {
      const compiled: RegExp[] = [];
      for (const pattern of patterns) {
        const regex = globToRegExp(pattern);
        if (regex) compiled.push(regex);
        else logWarn(`Ignoring an empty pattern in "plugins.${OBJECT_LITERAL_MEMBERS_PLUGIN_NAME}.include"`);
      }
      if (compiled.length > 0) includePatterns = compiled;
    }
  }

  let languages: ReadonlySet<Language> = new Set(SUPPORTED_LANGUAGES);
  if (raw.languages !== undefined) {
    const declaredLangs = stringArray(raw.languages);
    if (!declaredLangs) {
      logWarn(`Ignoring "plugins.${OBJECT_LITERAL_MEMBERS_PLUGIN_NAME}.languages": must be an array of language names`);
    } else {
      const scoped = new Set<Language>();
      for (const lang of declaredLangs) {
        if ((SUPPORTED_LANGUAGES as readonly string[]).includes(lang)) scoped.add(lang as Language);
        else logWarn(`Ignoring "${lang}" in "plugins.${OBJECT_LITERAL_MEMBERS_PLUGIN_NAME}.languages": supported languages are ${SUPPORTED_LANGUAGES.join(', ')}`);
      }
      if (scoped.size === 0) return null;
      languages = scoped;
    }
  }

  let operators: ReadonlySet<string> = new Set<string>(DEFAULT_OPERATORS);
  if (raw.operators !== undefined) {
    const declaredOps = stringArray(raw.operators);
    if (!declaredOps) {
      logWarn(`Ignoring "plugins.${OBJECT_LITERAL_MEMBERS_PLUGIN_NAME}.operators": must be an array of operator strings`);
    } else {
      const known = new Set<string>();
      for (const op of declaredOps) {
        if ((DEFAULT_OPERATORS as readonly string[]).includes(op)) known.add(op);
        else logWarn(`Ignoring "${op}" in "plugins.${OBJECT_LITERAL_MEMBERS_PLUGIN_NAME}.operators": supported operators are ${DEFAULT_OPERATORS.join(', ')}`);
      }
      if (known.size === 0) return null;
      operators = known;
    }
  }

  let wrappers: ReadonlySet<string> = new Set<string>();
  if (raw.wrappers !== undefined) {
    const declaredWrappers = stringArray(raw.wrappers);
    if (!declaredWrappers) {
      logWarn(`Ignoring "plugins.${OBJECT_LITERAL_MEMBERS_PLUGIN_NAME}.wrappers": must be an array of callee paths`);
    } else {
      const valid = new Set<string>();
      for (const wrapper of declaredWrappers) {
        // Same shape rule as `objects`: a plain, optionally dotted identifier
        // chain, exactly as the callee appears in source.
        const parts = splitTarget(wrapper);
        if (parts) valid.add(parts.join('.'));
        else logWarn(`Ignoring "${wrapper}" in "plugins.${OBJECT_LITERAL_MEMBERS_PLUGIN_NAME}.wrappers": must be a plain (optionally dotted) identifier`);
      }
      wrappers = valid;
    }
  }

  return {
    objects,
    objectPrefixes,
    includePatterns,
    languages,
    operators,
    topLevelOnly: boolOption(raw.topLevelOnly, true, 'topLevelOnly'),
    maxMemberDepth: positiveInt(raw.maxMemberDepth, DEFAULT_MAX_MEMBER_DEPTH, MAX_MEMBER_DEPTH_CAP, 'maxMemberDepth'),
    maxDepth: positiveInt(raw.maxDepth, DEFAULT_MAX_DEPTH, MAX_DEPTH_CAP, 'maxDepth'),
    emitContainer: boolOption(raw.emitContainer, true, 'emitContainer'),
    maxNodesPerFile: positiveInt(raw.maxNodesPerFile, DEFAULT_MAX_NODES_PER_FILE, 100000, 'maxNodesPerFile'),
    reattributeReferences: boolOption(raw.reattributeReferences, true, 'reattributeReferences'),
    wrappers,
  };
}

/**
 * The project's validated config, or `null` when the plugin is off or its config
 * is unusable. Memoized per root for one project-config generation, so it is
 * safe to call once per file.
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
    if (isPluginEnabled(projectRoot, OBJECT_LITERAL_MEMBERS_PLUGIN_NAME)) {
      config = normalize(
        getPluginOptions<ObjectLiteralMembersOptions>(projectRoot, OBJECT_LITERAL_MEMBERS_PLUGIN_NAME)
      );
    }
  } catch (error) {
    // A plugin must never be the reason an index fails.
    logDebug('object-literal-members: config load failed', { error: String(error) });
    config = null;
  }

  configCache.set(projectRoot, config);
  return config;
}

/** The root `extract()` should read config from: the root `detect()` recorded
 *  on the main thread, else the one the orchestrator set for this thread
 *  (which is how a parse worker — where `detect()` never runs — learns it). */
function currentRoot(): string | null {
  return activeRoot ?? getExtractionProjectRoot();
}

// ---------------------------------------------------------------------------
// AST walk
// ---------------------------------------------------------------------------

const OBJECT_TYPES = new Set(['object', 'object_expression']);
const FUNCTION_VALUE_TYPES = new Set(['arrow_function', 'function_expression', 'function']);

/** Property-key text with surrounding quotes stripped (`'foo'` → `foo`). Mirrors
 *  core's `objectKeyName`. */
function keyName(key: SyntaxNode, source: string): string {
  return getNodeText(key, source).replace(/^['"`]|['"`]$/g, '');
}

/**
 * The assignment target as a chain of identifier segments (`$ns.ui.panel` →
 * `['$ns','ui','panel']`), or null for anything that isn't a plain dotted chain
 * — a computed access (`$ns[key]`), an optional chain, a call, a `this`
 * expression. Abstaining here is the whole precision story of the target side.
 */
function targetSegments(node: SyntaxNode, source: string): string[] | null {
  if (node.type === 'identifier') {
    const text = getNodeText(node, source);
    return text ? [text] : null;
  }
  if (node.type !== 'member_expression') return null;
  const object = getChildByField(node, 'object');
  const property = getChildByField(node, 'property');
  if (!object || !property) return null;
  if (property.type !== 'property_identifier') return null;
  // `a?.b = …` is not a valid assignment target, but be explicit rather than
  // relying on the grammar to have rejected it.
  for (let i = 0; i < node.childCount; i++) {
    if (node.child(i)?.type === '?.') return null;
  }
  const base = targetSegments(object, source);
  if (!base) return null;
  const name = getNodeText(property, source);
  if (!name) return null;
  return [...base, name];
}

/** The operator text of an assignment node (`=` or the augmented operator). */
function assignmentOperator(node: SyntaxNode, source: string): string | null {
  if (node.type === 'assignment_expression') return '=';
  if (node.type !== 'augmented_assignment_expression') return null;
  const op = getChildByField(node, 'operator');
  return op ? getNodeText(op, source) : null;
}

/** Whether an object literal has at least one inline function member — core's
 *  `objectHasInlineFunctions` gate, which is what keeps a pure data object from
 *  minting nodes. Recurses only as far as `maxDepth` allows. */
function hasInlineFunctions(obj: SyntaxNode, depth: number, maxDepth: number): boolean {
  for (let i = 0; i < obj.namedChildCount; i++) {
    const member = obj.namedChild(i);
    if (!member) continue;
    if (member.type === 'method_definition') return true;
    if (member.type !== 'pair') continue;
    const value = getChildByField(member, 'value');
    if (!value) continue;
    if (FUNCTION_VALUE_TYPES.has(value.type)) return true;
    if (
      depth < maxDepth &&
      OBJECT_TYPES.has(value.type) &&
      hasInlineFunctions(value, depth + 1, maxDepth)
    ) {
      return true;
    }
  }
  return false;
}

/** `async` marker on a method/arrow/function expression. */
function isAsyncFunction(node: SyntaxNode): boolean {
  for (let i = 0; i < node.childCount; i++) {
    if (node.child(i)?.type === 'async') return true;
  }
  return false;
}

/** `name(params)` — the parameters as written, when the grammar exposes them. */
function buildSignature(name: string, fnNode: SyntaxNode, source: string): string {
  const params =
    getChildByField(fnNode, 'parameters') ??
    getChildByField(fnNode, 'parameter') ??
    null;
  const text = params ? getNodeText(params, source).replace(/\s+/g, ' ') : '';
  if (!text) return `${name}()`;
  return text.startsWith('(') ? `${name}${text}` : `${name}(${text})`;
}

interface EmitContext {
  filePath: string;
  language: Language;
  source: string;
  config: NormalizedConfig;
  nodes: Node[];
  edges: Edge[];
  ids: Set<string>;
  now: number;
}

/**
 * Push a node and return its id, or `null` when nothing was minted (the
 * per-file cap, an empty name, or an id this file already emitted).
 *
 * The id is the return value precisely so the caller can hang a `contains` edge
 * off it — and `null` on a dedupe hit is deliberate: an edge is only ever drawn
 * to a node THIS call created, so a container never claims to contain a node it
 * did not mint.
 */
function pushNode(
  ctx: EmitContext,
  kind: NodeKind,
  name: string,
  qualifiedName: string,
  span: SyntaxNode,
  extra?: Partial<Node>
): string | null {
  if (!name) return null;
  if (ctx.nodes.length >= ctx.config.maxNodesPerFile) return null;
  const startLine = span.startPosition.row + 1;
  const id = generateNodeId(ctx.filePath, kind, name, startLine);
  if (ctx.ids.has(id)) return null;
  ctx.ids.add(id);
  ctx.nodes.push({
    id,
    kind,
    name,
    qualifiedName,
    filePath: ctx.filePath,
    language: ctx.language,
    startLine,
    endLine: span.endPosition.row + 1,
    startColumn: span.startPosition.column,
    endColumn: span.endPosition.column,
    updatedAt: ctx.now,
    ...extra,
  });
  return id;
}

/**
 * `container contains member`, exactly as core's tree-sitter walk spells it:
 * no line/col (containment is a structural fact, not a call site) and no
 * `provenance` override, because this IS an AST fact — the member is lexically
 * inside the object literal the container node spans.
 *
 * Coordinate-less edges de-duplicate in the database (the identity index folds
 * NULL line/col), so re-emitting one across a sync is a no-op.
 */
function pushContains(ctx: EmitContext, containerId: string | null, memberId: string | null): void {
  if (!containerId || !memberId || containerId === memberId) return;
  ctx.edges.push({ source: containerId, target: memberId, kind: 'contains' });
}

/**
 * Emit the container node plus one node per function-valued member of `obj`,
 * joined by `contains` edges. Returns the container's id (`null` when there is
 * no container node — `emitContainer: false`, a duplicate id, or the per-file
 * cap), and emits NOTHING — container included — when the object carries no
 * function members at all.
 *
 * The `contains` edges are the point: without them the members are structurally
 * orphaned, which is what made a component's own methods invisible to every
 * consumer that reads the containment backbone. With `emitContainer: false`
 * there is nothing to contain them, so no edge is emitted and the members hang
 * off the file exactly as they did before — that is the honest answer for a
 * configuration that asked for no container.
 */
function emitObject(
  ctx: EmitContext,
  obj: SyntaxNode,
  span: SyntaxNode,
  name: string,
  qualifiedName: string,
  depth: number,
  containerKind: NodeKind = CONTAINER_KIND
): string | null {
  if (!hasInlineFunctions(obj, depth, ctx.config.maxDepth)) return null;

  const containerId = ctx.config.emitContainer
    ? pushNode(ctx, containerKind, name, qualifiedName, span, {
        docstring: getPrecedingDocstring(span, ctx.source),
      })
    : null;

  for (let i = 0; i < obj.namedChildCount; i++) {
    const member = obj.namedChild(i);
    if (!member) continue;

    if (member.type === 'method_definition') {
      const key = getChildByField(member, 'name');
      if (!key) continue;
      const memberName = keyName(key, ctx.source);
      if (!memberName) continue;
      const memberId = pushNode(ctx, MEMBER_KIND, memberName, `${qualifiedName}::${memberName}`, member, {
        signature: buildSignature(memberName, member, ctx.source),
        isAsync: isAsyncFunction(member) || undefined,
        docstring: getPrecedingDocstring(member, ctx.source),
      });
      pushContains(ctx, containerId, memberId);
      continue;
    }

    if (member.type !== 'pair') continue;
    const key = getChildByField(member, 'key');
    const value = getChildByField(member, 'value');
    if (!key || !value) continue;
    const memberName = keyName(key, ctx.source);
    if (!memberName) continue;

    if (FUNCTION_VALUE_TYPES.has(value.type)) {
      const memberId = pushNode(ctx, MEMBER_KIND, memberName, `${qualifiedName}::${memberName}`, member, {
        signature: buildSignature(memberName, value, ctx.source),
        isAsync: isAsyncFunction(value) || undefined,
        docstring: getPrecedingDocstring(member, ctx.source),
      });
      pushContains(ctx, containerId, memberId);
      continue;
    }

    if (depth < ctx.config.maxDepth && OBJECT_TYPES.has(value.type)) {
      // A nested member table is itself a member of the object above it, so the
      // backbone runs container → nested container → its own members.
      const nestedId = emitObject(ctx, value, member, memberName, `${qualifiedName}::${memberName}`, depth + 1);
      pushContains(ctx, containerId, nestedId);
    }
  }

  return containerId;
}

/**
 * The object-literal member table of a configured wrapper call, or null.
 *
 * `$ns.Widget = $ui.component('Widget', { … })`: the literal is the call's
 * argument, not the RHS, so the direct-RHS check never sees it. Unwrapping is
 * strictly opt-in per callee (exact text match against `wrappers`) because a
 * factory that does NOT treat its object argument as a member table would mint
 * wrong nodes. Several object-literal arguments → the LAST one (the
 * options/definition-object convention); none → abstain.
 */
function unwrapWrapperCall(ctx: EmitContext, call: SyntaxNode): SyntaxNode | null {
  const callee = getChildByField(call, 'function');
  if (!callee) return null;
  if (!ctx.config.wrappers.has(getNodeText(callee, ctx.source))) return null;

  const args = getChildByField(call, 'arguments');
  if (!args) return null;
  let literal: SyntaxNode | null = null;
  for (let i = 0; i < args.namedChildCount; i++) {
    const arg = args.namedChild(i);
    if (arg && OBJECT_TYPES.has(arg.type)) literal = arg;
  }
  return literal;
}

/** Handle one `<target> <op> { … }` assignment, if it is one we own. */
function visitAssignment(ctx: EmitContext, assign: SyntaxNode): void {
  const operator = assignmentOperator(assign, ctx.source);
  if (!operator || !ctx.config.operators.has(operator)) return;

  const right = getChildByField(assign, 'right');
  if (!right) return;
  let literal: SyntaxNode | null = null;
  let viaWrapper = false;
  if (OBJECT_TYPES.has(right.type)) {
    literal = right;
  } else if (right.type === 'call_expression' && ctx.config.wrappers.size > 0) {
    literal = unwrapWrapperCall(ctx, right);
    viaWrapper = literal !== null;
  }
  if (!literal) return;

  const left = getChildByField(assign, 'left');
  if (!left) return;
  const segments = targetSegments(left, ctx.source);
  if (!segments) return;

  for (const target of ctx.config.objects) {
    if (segments.length <= target.length) continue;
    let matched = true;
    for (let i = 0; i < target.length; i++) {
      if (segments[i] !== target[i]) {
        matched = false;
        break;
      }
    }
    if (!matched) continue;

    const members = segments.slice(target.length);
    if (members.length > ctx.config.maxMemberDepth) return;

    const containerName = members[members.length - 1]!;
    // A wrapper-produced container is a UI component definition, not a plain
    // value binding — surface that in its kind.
    emitObject(ctx, literal, assign, containerName, segments.join('.'), 1, viaWrapper ? 'component' : CONTAINER_KIND);
    return;
  }
}

/** Assignment nodes reachable per the `topLevelOnly` setting. */
function collectAssignments(root: SyntaxNode, topLevelOnly: boolean): SyntaxNode[] {
  const found: SyntaxNode[] = [];
  if (topLevelOnly) {
    for (let i = 0; i < root.namedChildCount; i++) {
      const stmt = root.namedChild(i);
      if (stmt?.type !== 'expression_statement') continue;
      for (let j = 0; j < stmt.namedChildCount; j++) {
        const expr = stmt.namedChild(j);
        if (expr && (expr.type === 'assignment_expression' || expr.type === 'augmented_assignment_expression')) {
          found.push(expr);
        }
      }
    }
    return found;
  }

  // Bounded DFS. The cap is a safety valve on a pathological file, not a
  // tuning knob — a normal source file is orders of magnitude below it.
  const MAX_VISITS = 200000;
  let visits = 0;
  const stack: SyntaxNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (++visits > MAX_VISITS) break;
    if (node.type === 'assignment_expression' || node.type === 'augmented_assignment_expression') {
      found.push(node);
    }
    for (let i = node.namedChildCount - 1; i >= 0; i--) {
      const child = node.namedChild(i);
      if (child) stack.push(child);
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export const objectLiteralMembersPlugin: FrameworkResolver = {
  name: OBJECT_LITERAL_MEMBERS_PLUGIN_NAME,
  languages: [...SUPPORTED_LANGUAGES],

  detect(context: ResolutionContext): boolean {
    try {
      const root = context.getProjectRoot();
      const config = getConfig(root);
      if (config) {
        activeRoot = root;
      } else if (activeRoot === root) {
        activeRoot = null;
      }
      return config !== null;
    } catch {
      return false;
    }
  },

  extract(filePath: string, content: string): FrameworkExtractionResult {
    const root = currentRoot();
    if (!root) return EMPTY_RESULT;

    const config = getConfig(root);
    if (!config) return EMPTY_RESULT;

    // --- cheap gates, cheapest first: nothing below re-parses a file that
    // cannot possibly carry a configured assignment target.
    const language = LANGUAGE_BY_EXT[path.extname(filePath).toLowerCase()];
    if (!language || !config.languages.has(language)) return EMPTY_RESULT;
    if (config.includePatterns && !matchesAny(config.includePatterns, filePath)) return EMPTY_RESULT;
    if (!content || content.indexOf('=') === -1) return EMPTY_RESULT;

    let candidate = false;
    for (const prefix of config.objectPrefixes) {
      if (content.includes(prefix)) {
        candidate = true;
        break;
      }
    }
    if (!candidate) return EMPTY_RESULT;

    try {
      const parser = getParser(language);
      if (!parser) return EMPTY_RESULT;
      const tree = parser.parse(content);
      if (!tree) return EMPTY_RESULT;

      const ctx: EmitContext = {
        filePath,
        language,
        source: content,
        config,
        nodes: [],
        edges: [],
        ids: new Set(),
        now: Date.now(),
      };
      for (const assign of collectAssignments(tree.rootNode, config.topLevelOnly)) {
        visitAssignment(ctx, assign);
        if (ctx.nodes.length >= config.maxNodesPerFile) break;
      }
      tree.delete?.();

      if (ctx.nodes.length === 0) return EMPTY_RESULT;
      return {
        nodes: ctx.nodes,
        references: [],
        // `contains`, container → member: the backbone core's own walk emits
        // from its node stack, which this plugin runs too late to join.
        edges: ctx.edges,
        // The calls inside these members were attributed to the FILE node
        // during core's walk (the object literal opened no scope frame). Ask
        // for them to be moved onto the member that actually makes them —
        // otherwise the flow breaks one hop short of the handler and the agent
        // reads the file to finish it.
        reattributeFileScopeRefs: config.reattributeReferences,
      };
    } catch (error) {
      logDebug('object-literal-members: extraction failed', { filePath, error: String(error) });
      return EMPTY_RESULT;
    }
  },

  // This plugin mints symbols; it resolves nothing. The nodes it emits are
  // ordinary symbols the existing resolvers (namespace-proxy, event-bus, plain
  // name matching) aim at on their own.
  resolve(_ref: UnresolvedRef, _context: ResolutionContext): ResolvedRef | null {
    return null;
  },
};

/**
 * Test/maintenance hook: forget the per-root config memo and the recorded
 * project root.
 */
export function resetObjectLiteralMembersState(): void {
  configCache.clear();
  configGeneration = getProjectConfigGeneration();
  activeRoot = null;
}
