/**
 * Layer-chain resolution — inheritance across sibling files that a project
 * distinguishes by a filename suffix.
 *
 * ## The convention
 *
 * Some codebases split ONE logical class across sibling files, each of which
 * specializes the previous for a different runtime context. The context is
 * declared by a suffix in the filename, between the stem and the extension:
 *
 *     widget.ts        export class Widget<T> extends $.Unit<T> { … }   // shared
 *     widget.bg.ts     export class Widget extends $.Widget<bg> { … }   // context "bg"
 *     widget.pp.tsx    export class Widget extends $.Widget<pp> { … }   // context "pp"
 *
 * The supertype is named through a namespace object (`$`), which no AST
 * extractor can follow — nothing declares `$`, so every one of these
 * `extends` references dies unresolved and the specialization chain, usually
 * the central architectural fact of such a codebase, is absent from the graph.
 *
 * A file may carry SEVERAL suffix tags (`widget.bs.ps.ts`), meaning "shared by
 * the `bs` and `ps` contexts". Such a file is itself specialized by the
 * single-tag siblings (`widget.bs.ts`, `widget.ps.ts`), and it in turn
 * specializes the untagged base (`widget.ts`). Chains are therefore arbitrarily
 * deep and branch; see "Chain depth" below.
 *
 * ## Config
 *
 * Opt in per project through `codegraph.json`. The plugin does nothing at all
 * without an entry, and nothing useful without a `layers` vocabulary:
 *
 * ```jsonc
 * {
 *   "plugins": {
 *     "layer-chain": {
 *       // REQUIRED. The suffix vocabulary: every tag that may appear between a
 *       // file's stem and its extension. Lowercase alphanumeric; order is not
 *       // significant. A filename segment outside this list is NOT a tag, so
 *       // unrelated dotted filenames (`widget.test.ts`, `types.d.ts`) are
 *       // untouched.
 *       "layers": ["bg", "pp", "cs", "os", "ps", "bs"],
 *
 *       // Namespace sigils that introduce a layer-chain supertype, i.e. the
 *       // `$` in `extends $.Widget<bg>`. A sigil listed here means "the
 *       // NEAREST more general sibling". Defaults to ["$"].
 *       "sigils": ["$"],
 *
 *       // OPTIONAL. Project-root-relative directory prefixes the convention
 *       // applies to. Omitted or empty = the whole project.
 *       "roots": ["packages/app/src"]
 *     }
 *   }
 * }
 * ```
 *
 * A sigil that is NOT in `sigils` but decodes as a camelCase concatenation of
 * declared tags — `bsPs` → `{bs, ps}`, `bsOsPs` → `{bs, os, ps}` — is read as
 * naming that exact sibling, so `widget.bs.ts`'s `extends bsPs.Widget<bs>`
 * targets `widget.bs.ps.ts` specifically and nothing else. An explicit `sigils`
 * entry always wins over that decoding.
 *
 * ## Chain depth
 *
 * Each reference resolves exactly ONE hop, to the nearest sibling that is
 * strictly more general than the referring file. Depth is emergent: every file
 * in the chain resolves its own hop, so `widget.bs.ts → widget.bs.ps.ts →
 * widget.ts` falls out of three independent one-hop resolutions with no
 * traversal, no recursion, and no depth limit to configure. "More general"
 * means the target's tag set is a strict SUPERSET of the referring file's
 * (it covers more contexts), with the untagged base treated as universal —
 * which is also what keeps `widget.pp.tsx` from ever resolving to
 * `widget.bg.ts` (neither covers the other) and makes it skip straight to the
 * base.
 *
 * ## Precision
 *
 * A wrong `extends` edge is far more damaging than a missing one — inheritance
 * drives every type-hierarchy query — so this abstains unless every one of the
 * following holds. It never invents a target:
 *
 *   - the reference is `extends`. Every other kind is a strict no-op (the
 *     namespace-proxy plugin owns those).
 *   - the referring file carries at least one declared tag (a base file has
 *     nothing more general to extend).
 *   - the sigil is configured, or decodes entirely to declared tags.
 *   - a node with that exact name really exists, is a type declaration, and
 *     sits in the same directory under the same stem.
 *   - its tag set strictly covers the referring file's (and equals the decoded
 *     set exactly, when the sigil named one).
 *   - the match is unique. Two equally-near candidates ⇒ no edge.
 *
 * Cross-stem supertypes — `extends $.Unit<T>`, the framework base class living
 * in some other module — are deliberately left alone: they are namespace
 * references that happen to appear in an `extends` position, not layer chaining.
 *
 * See ./noop.ts for the plugin contract this follows.
 */
import type { Node, NodeKind } from '../../types';
import { logWarn } from '../../errors';
import { getProjectConfigGeneration } from '../../project-config';
import type { FrameworkResolver, ResolutionContext, ResolvedRef, UnresolvedRef } from '../types';
import { getPluginOptions, isPluginEnabled } from './plugin-config';

/** Config key and registry name for this plugin. */
export const LAYER_CHAIN_PLUGIN_NAME = 'layer-chain';

/** Options accepted under `plugins.layer-chain` in `codegraph.json`. */
export interface LayerChainPluginOptions {
  /** Filename suffix vocabulary, e.g. `["bg", "pp"]`. Required. */
  layers?: string[];
  /** Namespace sigils introducing a chain supertype. Defaults to `["$"]`. */
  sigils?: string[];
  /** Project-root-relative directory prefixes the convention applies to. */
  roots?: string[];
}

/** Default `sigils` when the project doesn't override it. */
const DEFAULT_SIGILS = ['$'];

/**
 * Node kinds a supertype may legitimately be. `extends` in the languages this
 * convention appears in always names a type declaration; anything else with a
 * colliding name (a variable, a route, a property) is not a candidate.
 */
const TYPE_KINDS: ReadonlySet<NodeKind> = new Set<NodeKind>([
  'class',
  'interface',
  'struct',
  'trait',
  'protocol',
]);

/** A tag must be lowercase alphanumeric so the camelCase sigil decoding is sound. */
const TAG_PATTERN = /^[a-z0-9]+$/;

/** The `<Name>` half of `<sigil>.<Name>` must be a bare identifier. */
const IDENTIFIER_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** Validated, precompiled view of one project's `layer-chain` options. */
interface CompiledOptions {
  /** Declared suffix vocabulary, lowercased. Never empty. */
  readonly layers: ReadonlySet<string>;
  /** Sigils meaning "the nearest more general sibling". Never empty. */
  readonly sigils: ReadonlySet<string>;
  /** Normalized directory prefixes; empty means the whole project. */
  readonly roots: readonly string[];
}

/**
 * Per-project compiled options, valid for one project-config generation.
 *
 * `claimsReference` gets no context and therefore no project root, so it reads
 * this map — populated by `detect()`, which the resolver always runs first (see
 * `detectFrameworks`). Entries are recompiled, not dropped, when the generation
 * moves, so a config rewrite mid-session can never silently turn the hook off.
 */
const compiledByRoot = new Map<string, { generation: number; options: CompiledOptions | null }>();

/** Slashes forward, no trailing slash, no leading `./`. */
function normalizePath(value: string): string {
  let out = value.replace(/\\/g, '/');
  while (out.startsWith('./')) out = out.slice(2);
  while (out.endsWith('/')) out = out.slice(0, -1);
  return out;
}

/**
 * Validate and precompile one project's options. Every malformed value is
 * warned-and-skipped; a project that ends up without a usable `layers`
 * vocabulary gets `null`, i.e. the plugin stays inert rather than guessing.
 */
function compile(projectRoot: string): CompiledOptions | null {
  if (!isPluginEnabled(projectRoot, LAYER_CHAIN_PLUGIN_NAME)) return null;
  const raw = getPluginOptions<LayerChainPluginOptions>(projectRoot, LAYER_CHAIN_PLUGIN_NAME);

  const layers = new Set<string>();
  if (raw.layers === undefined) {
    logWarn(`Ignoring plugin "${LAYER_CHAIN_PLUGIN_NAME}": "layers" is required (the filename suffix vocabulary)`, {
      projectRoot,
    });
    return null;
  }
  if (!Array.isArray(raw.layers)) {
    logWarn(`Ignoring plugin "${LAYER_CHAIN_PLUGIN_NAME}": "layers" must be an array of filename suffix tags`, {
      projectRoot,
    });
    return null;
  }
  for (const entry of raw.layers) {
    const tag = typeof entry === 'string' ? entry.trim().toLowerCase() : '';
    if (!tag || !TAG_PATTERN.test(tag)) {
      logWarn(`Ignoring a "${LAYER_CHAIN_PLUGIN_NAME}.layers" entry: "${String(entry)}" is not a lowercase alphanumeric suffix tag`, {
        projectRoot,
      });
      continue;
    }
    layers.add(tag);
  }
  if (layers.size === 0) {
    logWarn(`Ignoring plugin "${LAYER_CHAIN_PLUGIN_NAME}": "layers" declared no usable suffix tags`, { projectRoot });
    return null;
  }

  const sigils = new Set<string>();
  if (raw.sigils === undefined) {
    for (const s of DEFAULT_SIGILS) sigils.add(s);
  } else if (!Array.isArray(raw.sigils)) {
    logWarn(`Ignoring "${LAYER_CHAIN_PLUGIN_NAME}.sigils": must be an array of namespace names`, { projectRoot });
    for (const s of DEFAULT_SIGILS) sigils.add(s);
  } else {
    for (const entry of raw.sigils) {
      const sigil = typeof entry === 'string' ? entry.trim() : '';
      if (!sigil || sigil.includes('.')) {
        logWarn(`Ignoring a "${LAYER_CHAIN_PLUGIN_NAME}.sigils" entry: "${String(entry)}" is not a namespace name`, {
          projectRoot,
        });
        continue;
      }
      sigils.add(sigil);
    }
    if (sigils.size === 0) {
      logWarn(`Ignoring plugin "${LAYER_CHAIN_PLUGIN_NAME}": "sigils" declared no usable namespace names`, { projectRoot });
      return null;
    }
  }

  const roots: string[] = [];
  if (raw.roots !== undefined) {
    if (!Array.isArray(raw.roots)) {
      logWarn(`Ignoring "${LAYER_CHAIN_PLUGIN_NAME}.roots": must be an array of project-relative directories`, {
        projectRoot,
      });
    } else {
      for (const entry of raw.roots) {
        const dir = typeof entry === 'string' ? normalizePath(entry.trim()) : '';
        if (!dir) {
          logWarn(`Ignoring a "${LAYER_CHAIN_PLUGIN_NAME}.roots" entry: every directory must be a non-empty string`, {
            projectRoot,
          });
          continue;
        }
        roots.push(dir);
      }
    }
  }

  return { layers, sigils, roots };
}

/** Compiled options for a project, memoized per config generation. */
function optionsFor(projectRoot: string): CompiledOptions | null {
  const generation = getProjectConfigGeneration();
  const hit = compiledByRoot.get(projectRoot);
  if (hit && hit.generation === generation) return hit.options;
  const options = compile(projectRoot);
  compiledByRoot.set(projectRoot, { generation, options });
  return options;
}

/**
 * Decode a camelCase sigil into the tag set it names — `bsPs` → `["bs","ps"]`.
 * Returns null unless EVERY segment is a declared tag and none repeats, so a
 * sigil naming anything else (a real imported namespace, a type) is rejected.
 */
function decodeSigilTags(sigil: string, layers: ReadonlySet<string>): string[] | null {
  if (!sigil || !/^[a-z][A-Za-z0-9]*$/.test(sigil)) return null;
  const parts = sigil.split(/(?=[A-Z])/);
  const tags: string[] = [];
  for (const part of parts) {
    const tag = part.toLowerCase();
    if (!layers.has(tag) || tags.includes(tag)) return null;
    tags.push(tag);
  }
  return tags.length > 0 ? tags : null;
}

/** A source file decomposed into directory, stem, and trailing layer tags. */
interface LayerPath {
  /** Normalized full path, for identity comparison. */
  full: string;
  /** Directory, normalized, `''` at the project root. */
  dir: string;
  /** Everything before the trailing tag run — the logical unit's name. */
  stem: string;
  /** Trailing declared tags, lowercased, in filename order, deduplicated. */
  tags: string[];
}

/**
 * Split `src/widget/widget.bs.ps.ts` into `{dir: 'src/widget', stem: 'widget',
 * tags: ['bs','ps']}`.
 *
 * Tags are the CONTIGUOUS TRAILING run of declared vocabulary segments, and the
 * stem always keeps at least one segment. That is what makes unrelated dotted
 * filenames inert: in `widget.bg.0.ts` the trailing `0` isn't a declared tag, so
 * the run is empty and the whole thing is one opaque stem — no accidental
 * chaining off a build-order or `.d`/`.test` segment.
 */
function parseLayerPath(filePath: string, layers: ReadonlySet<string>): LayerPath | null {
  const full = normalizePath(filePath);
  const slash = full.lastIndexOf('/');
  const dir = slash === -1 ? '' : full.slice(0, slash);
  const base = slash === -1 ? full : full.slice(slash + 1);

  const parts = base.split('.');
  if (parts.length < 2) return null; // no extension — not a source file we chain
  const segments = parts.slice(0, -1);
  if (segments.length === 0 || !segments[0]) return null; // dotfile

  let end = segments.length;
  const tags: string[] = [];
  while (end > 1) {
    const tag = segments[end - 1]!.toLowerCase();
    if (!layers.has(tag)) break;
    if (!tags.includes(tag)) tags.unshift(tag);
    end--;
  }

  return { full, dir, stem: segments.slice(0, end).join('.'), tags };
}

/**
 * Is `parent` strictly more general than `child`? Tags are the contexts a file
 * applies to, and an untagged file applies to ALL of them — so the base is the
 * most general thing there is, and otherwise generality is strict superset.
 */
function covers(parent: readonly string[], child: readonly string[]): boolean {
  if (child.length === 0) return false; // a base file has nothing above it
  if (parent.length === 0) return true; // untagged = universal
  if (parent.length <= child.length) return false;
  return child.every((tag) => parent.includes(tag));
}

/** How general a tag set is; lower is nearer to the referring file. */
function generality(tags: readonly string[]): number {
  return tags.length === 0 ? Number.POSITIVE_INFINITY : tags.length;
}

function sameTagSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((tag) => b.includes(tag));
}

/** Does `filePath` sit under one of the configured roots (empty = everywhere)? */
function inScope(filePath: string, roots: readonly string[]): boolean {
  if (roots.length === 0) return true;
  const normalized = normalizePath(filePath);
  return roots.some((root) => normalized === root || normalized.startsWith(root + '/'));
}

export const layerChainPlugin: FrameworkResolver = {
  name: LAYER_CHAIN_PLUGIN_NAME,

  detect(context: ResolutionContext): boolean {
    try {
      // Compiling here (rather than only on the first `resolve`) is what lets
      // `claimsReference` — which receives no context — find this project's
      // vocabulary at all.
      return optionsFor(context.getProjectRoot()) !== null;
    } catch {
      return false;
    }
  },

  /**
   * Opt `<sigil>.<Name>` past the resolver's "no node has this name" pre-filter,
   * which is what drops every one of these references today.
   *
   * On the hot path for every unresolved reference in the project, so it bails
   * on cheap string shape before touching any config: exactly one dot, a bare
   * identifier after it, and only then a set lookup per configured project
   * (one, outside a multi-project daemon).
   */
  claimsReference(name: string): boolean {
    if (compiledByRoot.size === 0) return false;
    const dot = name.indexOf('.');
    if (dot <= 0 || dot === name.length - 1) return false;
    if (name.indexOf('.', dot + 1) !== -1) return false;
    const head = name.slice(0, dot);
    if (!IDENTIFIER_PATTERN.test(name.slice(dot + 1))) return false;

    for (const projectRoot of compiledByRoot.keys()) {
      const options = optionsFor(projectRoot);
      if (!options) continue;
      if (options.sigils.has(head)) return true;
      if (decodeSigilTags(head, options.layers)) return true;
    }
    return false;
  },

  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
    // Strictly `extends` only. Non-inheritance namespace references belong to
    // the namespace-proxy plugin; claiming them here would double-resolve.
    if (ref.referenceKind !== 'extends') return null;

    const dot = ref.referenceName.indexOf('.');
    if (dot <= 0 || dot === ref.referenceName.length - 1) return null;
    if (ref.referenceName.indexOf('.', dot + 1) !== -1) return null;
    const head = ref.referenceName.slice(0, dot);
    const typeName = ref.referenceName.slice(dot + 1);
    if (!IDENTIFIER_PATTERN.test(typeName)) return null;

    let projectRoot: string;
    try {
      projectRoot = context.getProjectRoot();
    } catch {
      return null;
    }
    const options = optionsFor(projectRoot);
    if (!options) return null;
    if (!inScope(ref.filePath, options.roots)) return null;

    const from = parseLayerPath(ref.filePath, options.layers);
    // An untagged file is already the most general form of its unit — there is
    // no more general sibling for it to extend.
    if (!from || from.tags.length === 0) return null;

    // A configured sigil means "nearest more general sibling"; anything else
    // has to name an exact tag set, or this isn't ours.
    let wanted: string[] | undefined;
    if (!options.sigils.has(head)) {
      const decoded = decodeSigilTags(head, options.layers);
      if (!decoded) return null;
      wanted = decoded;
    }

    let best: Node | null = null;
    let bestGenerality = Number.POSITIVE_INFINITY;
    let ambiguous = false;

    for (const candidate of context.getNodesByName(typeName)) {
      if (!TYPE_KINDS.has(candidate.kind)) continue;
      if (candidate.name !== typeName) continue; // getNodesByName may be case-insensitive
      const target = parseLayerPath(candidate.filePath, options.layers);
      if (!target) continue;
      if (target.full === from.full) continue; // never chain a file to itself
      if (target.dir !== from.dir || target.stem !== from.stem) continue;
      if (!covers(target.tags, from.tags)) continue;
      if (wanted && !sameTagSet(target.tags, wanted)) continue;

      const rank = generality(target.tags);
      if (best === null || rank < bestGenerality) {
        best = candidate;
        bestGenerality = rank;
        ambiguous = false;
        continue;
      }
      if (rank !== bestGenerality || candidate.id === best.id) continue;
      // Two equally-near candidates. A real class outranks a merged interface
      // declaration; anything else is a genuine tie and gets no edge at all.
      if (best.kind !== 'class' && candidate.kind === 'class') {
        best = candidate;
        ambiguous = false;
      } else if (best.kind !== 'class' || candidate.kind === 'class') {
        ambiguous = true;
      }
    }

    if (!best || ambiguous) return null;

    return {
      original: ref,
      targetNodeId: best.id,
      // A verified same-name declaration in the layer-stripped sibling is a
      // near-exact match: the file, the stem, the tag ordering and the name all
      // had to line up for it to get here.
      confidence: 0.95,
      resolvedBy: 'framework',
    };
  },
};

/**
 * Test/maintenance hook: forget every project's precompiled options.
 *
 * Production correctness rides the project-config generation counter instead
 * (see `optionsFor`); this exists so a test that reuses a temp-dir path, or a
 * long-lived process shutting a project down, can drop the entry outright.
 */
export function clearLayerChainCache(): void {
  compiledByRoot.clear();
}
