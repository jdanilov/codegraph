/**
 * Event-bus edge detection — string-keyed message buses, declared per project.
 *
 * A message bus is pure dynamic dispatch: the dispatch site and the handler
 * share nothing but a string.
 *
 *     await bus.send('area.itemSaved', payload);   // one file / one bundle
 *     bus.on('area.itemSaved', onItemSaved);       // another file entirely
 *
 * Nothing in the AST connects those two lines, so the flow dies at the dispatch
 * and an agent falls back to grep. The built-in emitter synthesizer covers the
 * `.emit`/`.fire`/`.dispatchEvent` ↔ `.on`/`.once`/`.addListener` shape through
 * hardcoded regexes, which is the right default — but a project whose dominant
 * dispatch verb is something else (`send`, `publish`, `request`, …) gets almost
 * nothing from it, and widening that hardcoded constant would raise the
 * false-positive rate for every project that never asked for it.
 *
 * So this plugin owns its own detection, with a vocabulary the project declares.
 * It is opt-in and inert without config, exactly like every plugin here
 * (see ./noop.ts for the contract).
 *
 * ## Config schema — `plugins["event-bus"]` in `codegraph.json`
 *
 * ```jsonc
 * {
 *   "plugins": {
 *     "event-bus": {
 *       // SHORTHAND. Each name is an INDEPENDENT bus with its own event
 *       // namespace — `$bus.send('x')` never reaches `$otherBus.on('x')`.
 *       "objects":   ["$bus", "$iframeBus"],
 *       "dispatch":  ["send", "emit"],       // verbs that FIRE an event
 *       "subscribe": ["on", "once"],         // verbs that REGISTER a handler
 *
 *       // LONG FORM (may be used instead of, or together with, the shorthand).
 *       // One entry = ONE logical bus. Several `objects` inside a single entry
 *       // are ALIASES of that one bus and DO share an event namespace; separate
 *       // entries never cross-talk. Each entry carries its own verb vocabulary.
 *       "buses": [
 *         {
 *           "name":      "app",              // optional label, shown on the edge
 *           "objects":   ["$bus", "appBus"], // aliases of the SAME bus
 *           "dispatch":  ["send", "publish"],
 *           "subscribe": ["on", "once"]
 *         },
 *         { "objects": ["$workerBus"], "dispatch": ["post"], "subscribe": ["handle"] }
 *       ],
 *
 *       // Precision knobs (optional; defaults shown).
 *       "maxHandlersPerEvent":    6,
 *       "maxDispatchersPerEvent": 32,
 *       "maxHandlerChainDepth":   5,
 *       "deferToBuiltinEmitter":  true
 *     }
 *   }
 * }
 * ```
 *
 * Every key is optional and independently validated: a malformed value is
 * warned about and skipped, never thrown. `dispatch` defaults to
 * `["send", "emit"]` and `subscribe` to `["on", "once"]`. With no usable
 * `objects` the plugin reports itself undetected and does nothing at all —
 * there is no "all objects" mode, by design.
 *
 * Object names may be dotted (`app.bus`), and a reference reached through a
 * receiver (`this.$bus.send(…)`) matches a declared `$bus`.
 *
 * ## How it resolves
 *
 * The dispatch references already exist in `unresolved_refs` — `$bus.send`
 * with a real source node, file and line — they simply never resolve, because
 * no symbol is named that. So:
 *
 *   - `claimsReference` opts `<object>.<dispatchVerb>` past the resolver's
 *     "no node has this name" pre-filter (a single Set lookup — it is on the
 *     hot path);
 *   - the first claimed reference triggers ONE project scan that records every
 *     subscription (`event → named handler node`) and every dispatch site, per
 *     bus, from comment-stripped source;
 *   - `resolve` takes the event name recorded at the reference's own line (or,
 *     for a file the scan skipped, reads that one line through the context's
 *     LRU-cached `getFileLines`) and returns the matching subscriber's handler.
 *
 * ## Precision discipline (mirrors the built-in synthesizer's)
 *
 *   - Comments are stripped before any regex runs (`../strip-comments`), so a
 *     commented-out `bus.on('x', handler)` never registers a handler.
 *   - Named handlers only — written plainly (`onX`), through a receiver of any
 *     depth (`this.onX`, `store.onX`, `this.root.utils.onX`), and/or bound
 *     (`this.onX.bind(this)`). `bus.on('x', () => …)` is deliberately ignored:
 *     an anonymous body has no node to point at, and guessing is worse than
 *     silence.
 *   - A receiver path DISAMBIGUATES, it is never dropped. See "Receiver paths"
 *     below — the segments in front of the handler name decide which tiers of
 *     the lookup are even allowed to answer.
 *   - Event fan-out is capped on BOTH sides. An event with more than
 *     `maxHandlersPerEvent` handlers is skipped outright — a generic key like
 *     `'change'` cannot be paired confidently without type information — and so
 *     is one with more than `maxDispatchersPerEvent` dispatch sites. The
 *     handler cap defaults to the built-in synthesizer's 6; the dispatcher cap
 *     is looser (32) because one dispatch reference resolves to one handler
 *     here, so a widely-fired event is not itself an ambiguity — it is only a
 *     smell.
 *   - A handler name resolves same-file first, then through the file's import
 *     mappings, then project-wide ONLY when exactly one function/method carries
 *     the name. An ambiguous name resolves to nothing.
 *   - Buses never cross-talk: the event namespace is per bus, so two buses may
 *     use the same event string with no interference.
 *   - `deferToBuiltinEmitter` (default true) keeps the built-in emitter
 *     synthesizer as the single producer for the pairs it already covers —
 *     a `emit`/`fire`/`dispatchEvent` dispatch whose event has a handler
 *     registered with `on`/`once`/`addListener` resolves to nothing here.
 *     Without it both would emit an edge for the same pair (they survive the
 *     edge-identity index separately, since a resolved-reference edge carries a
 *     line/column and a synthesized one does not) and the graph would
 *     double-count the hop.
 *
 * ## Receiver paths
 *
 * A handler is written as a dotted expression: the LAST segment names the
 * symbol, everything before it is the receiver path. Leading `this` / `self`
 * segments are skipped (they name the enclosing object, not a lookup step), and
 * the whole expression is capped at `maxHandlerChainDepth` segments so a
 * pathological expression can neither be scanned nor guessed at.
 *
 * The path is what decides how far the lookup may reach:
 *
 *   - `bus.on('x', onX)` — no receiver. Same file, then the file `onX` was
 *     imported from, then project-wide when EXACTLY ONE function/method carries
 *     the name. Unchanged.
 *   - `bus.on('x', this.onX)` / `this.onX.bind(this)` — the receiver is the
 *     ENCLOSING object, so the handler is one of its members: the registering
 *     file (and its imports) may answer, but the project-wide tier may NOT. A
 *     same-named function in an unrelated file is not "the method on this" —
 *     it is a coincidence, and pairing it fabricates a control-flow hop.
 *   - `bus.on('x', store.onX)` / `bus.on('x', this.root.utils.onX)` — a NAMED
 *     receiver path of any depth. Same file first (preferring a candidate the
 *     last receiver segment actually encloses), then the file the path's ROOT or
 *     its OWNER segment was imported from, then project-wide — where the owner
 *     segment first narrows the candidates, and only a single survivor is
 *     accepted. Ambiguity still resolves to nothing.
 *
 * One more abstention has no receiver to reason about: when the registering file
 * itself binds the bare handler name as a local `const`/`let`/`var` that
 * extraction did not turn into a node (a callback declared inside another
 * function, say), the name is LOCAL and a project-wide symbol sharing it is a
 * different thing entirely — so the project-wide tier is skipped there too.
 *
 * ## Edge tagging
 *
 * Every produced edge is meant to render as what it is — a heuristic bridge,
 * not a static call — so each result carries {@link EventBusEdgeTag} on its
 * `edge` property: `provenance: 'heuristic'`, `metadata.synthesizedBy`, the bus
 * label, the event key, and `registeredAt` (the `file:line` of the `bus.on`
 * that wired it up — the one thing an agent would otherwise grep for).
 *
 * NOTE: the resolver's `resolve()` hook currently has no channel for edge
 * provenance — `ResolvedRef` carries only `targetNodeId`/`confidence`/
 * `resolvedBy`, and `createEdges` builds the edge's metadata itself — so the
 * tag below is inert until that channel exists. It is attached anyway so the
 * plugin needs no change when it does; edges land today as ordinary `calls`
 * edges with `metadata.resolvedBy = 'framework'` and `metadata.refName =
 * '<object>.<verb>'`.
 */
import type { Language, Node } from '../../types';
import { logWarn } from '../../errors';
import type { FrameworkResolver, ResolutionContext, ResolvedRef, UnresolvedRef } from '../types';
import { stripCommentsForRegex, type CommentLang } from '../strip-comments';
import { getPluginOptions, isPluginEnabled } from './plugin-config';

/** Config key and registry name for this plugin. */
export const EVENT_BUS_PLUGIN_NAME = 'event-bus';

/** `metadata.synthesizedBy` value carried by every edge this plugin produces. */
export const EVENT_BUS_SYNTHESIZED_BY = 'event-bus';

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/** One logical bus. Objects listed together are aliases sharing one namespace. */
export interface EventBusChannelOptions {
  /** Label surfaced on the edge; defaults to the first object name. */
  name?: string;
  /** Object expressions the bus is reached through (`$bus`, `app.bus`, …). */
  objects?: string[];
  /** Verbs that FIRE an event. Default `["send", "emit"]`. */
  dispatch?: string[];
  /** Verbs that REGISTER a handler. Default `["on", "once"]`. */
  subscribe?: string[];
}

/** Options accepted under `plugins["event-bus"]` in `codegraph.json`. */
export interface EventBusPluginOptions extends EventBusChannelOptions {
  /** Independent buses, each with its own verb vocabulary and namespace. */
  buses?: EventBusChannelOptions[];
  /** Skip an event with more named handlers than this. Default 6. */
  maxHandlersPerEvent?: number;
  /** Skip an event with more dispatch sites than this. Default 32. */
  maxDispatchersPerEvent?: number;
  /**
   * Longest dotted handler expression a subscription may use, counted in
   * segments INCLUDING a leading `this`/`self` — `this.root.utils.onX` is 4.
   * Default 5, hard-limited to 8. Set it to 2 to restrict handlers to the bare
   * and single-receiver forms (`onX`, `this.onX`, `store.onX`).
   */
  maxHandlerChainDepth?: number;
  /** Leave `emit`/`on`-shaped pairs to the built-in synthesizer. Default true. */
  deferToBuiltinEmitter?: boolean;
}

/** Edge shape this plugin intends for every reference it resolves. */
export interface EventBusEdgeTag {
  provenance: 'heuristic';
  metadata: {
    synthesizedBy: typeof EVENT_BUS_SYNTHESIZED_BY;
    /** Bus label the dispatch rode. */
    bus: string;
    /** The string key that paired dispatch to handler. */
    event: string;
    /** `file:line` of the subscription that wired the handler up. */
    registeredAt: string;
    /** Present when the event had several handlers and one was chosen. */
    handlerCount?: number;
  };
}

/** A `ResolvedRef` carrying this plugin's intended edge tagging. */
export interface EventBusResolvedRef extends ResolvedRef {
  edge: EventBusEdgeTag;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Mirrors the built-in emitter synthesizer's EVENT_FANOUT_CAP. */
const DEFAULT_MAX_HANDLERS_PER_EVENT = 6;
/** One dispatch reference yields one edge, so this only guards catch-all keys. */
const DEFAULT_MAX_DISPATCHERS_PER_EVENT = 32;
/** Segments a handler expression may carry, counting a leading `this`. */
const DEFAULT_MAX_HANDLER_CHAIN_DEPTH = 5;
/**
 * Hard ceiling on the chain depth. It bounds the subscribe regex itself, so a
 * longer expression simply fails to match — there is no suffix of a 30-segment
 * chain the scanner could mistake for a receiver path.
 */
const MAX_HANDLER_CHAIN_DEPTH_LIMIT = 8;
/**
 * Project-wide candidates the receiver path is allowed to narrow. Beyond this
 * the name is a generic one (`get`, `run`) whose owner-segment agreement would
 * be coincidence as often as evidence, so it abstains instead of scanning on.
 */
const MAX_NARROWED_CANDIDATES = 32;
/** Upper bounds for the configurable caps — a config typo can't unbound them. */
const CAP_LIMIT = 256;
/** Bounds on the declared vocabulary, so a config can't build a pathological regex. */
const MAX_OBJECTS_PER_BUS = 32;
const MAX_VERBS_PER_LIST = 16;
const MAX_BUSES = 16;

/** Verbs the built-in emitter synthesizer already pairs (dispatch side). */
const BUILTIN_DISPATCH_VERBS: ReadonlySet<string> = new Set(['emit', 'fire', 'dispatchEvent']);
/** Verbs the built-in emitter synthesizer already pairs (subscribe side). */
const BUILTIN_SUBSCRIBE_VERBS: ReadonlySet<string> = new Set(['on', 'once', 'addListener']);

const DEFAULT_DISPATCH_VERBS = ['send', 'emit'];
const DEFAULT_SUBSCRIBE_VERBS = ['on', 'once'];

/** Node kinds a named handler may resolve to. */
const HANDLER_KINDS: ReadonlySet<string> = new Set(['function', 'method']);

/** Chain segments that name the enclosing object rather than a lookup step. */
const SELF_SEGMENTS: ReadonlySet<string> = new Set(['this', 'self']);

/**
 * Comment syntax per indexed language. A file whose language is absent is not
 * scanned at all — an unstrippable file could register a handler from a
 * commented-out line, and a missed edge beats a wrong one. Languages sharing a
 * comment syntax reuse the closest supported stripper.
 */
const COMMENT_LANG: Partial<Record<Language, CommentLang>> = {
  typescript: 'typescript',
  tsx: 'typescript',
  javascript: 'javascript',
  jsx: 'javascript',
  arkts: 'typescript',
  vue: 'typescript',
  svelte: 'typescript',
  astro: 'typescript',
  dart: 'java',
  kotlin: 'java',
  scala: 'java',
  java: 'java',
  csharp: 'csharp',
  swift: 'swift',
  objc: 'c',
  c: 'c',
  cpp: 'cpp',
  go: 'go',
  rust: 'rust',
  php: 'php',
  python: 'python',
  ruby: 'ruby',
  erlang: 'erlang',
};

/**
 * Event keys we accept from a literal. Deliberately narrow: it rejects template
 * interpolation (`` `evt.${id}` ``, which is not a static key) and prose, which
 * a stray quoted sentence in an argument list would otherwise contribute.
 */
const EVENT_KEY_RE = /^[\w$.:/@|#-]+$/;

// ---------------------------------------------------------------------------
// Vocabulary (parsed config)
// ---------------------------------------------------------------------------

interface BusSpec {
  label: string;
  objects: string[];
  dispatch: ReadonlySet<string>;
  subscribe: ReadonlySet<string>;
  /** `<object>.<dispatchVerb>('event'` — captures verb, quote, event. */
  dispatchRe: RegExp;
  /** `<object>.<subscribeVerb>('event', handler)` — named handlers only. */
  subscribeRe: RegExp;
}

interface Vocab {
  buses: BusSpec[];
  /** Object expression → owning bus. */
  byObject: Map<string, BusSpec>;
  /** Union of every bus's dispatch verbs — the hot-path gate in `resolve`. */
  dispatchVerbs: ReadonlySet<string>;
  /** `<object>.<dispatchVerb>` names, for `claimsReference`. */
  claimed: ReadonlySet<string>;
  /** Cheap substring gate: every declared object's leading segment. */
  tokens: string[];
  maxHandlers: number;
  maxDispatchers: number;
  /** Segments a handler expression may carry (a leading `this` counts). */
  maxChainDepth: number;
  deferToBuiltin: boolean;
}

// ---------------------------------------------------------------------------
// Per-project state
// ---------------------------------------------------------------------------

interface Subscription {
  handlerId: string;
  /** `file:line` of the registration call. */
  registeredAt: string;
  /** Sort key so handler choice is deterministic across runs. */
  sortKey: string;
}

interface EventEntry {
  /** handler node id → registration site. */
  handlers: Map<string, Subscription>;
  dispatchSites: number;
  /** Some handler was registered with a verb the built-in synthesizer pairs. */
  builtinSubscribe: boolean;
}

interface DispatchSite {
  line: number;
  /** 0-based column of the object token. */
  column: number;
  busLabel: string;
  verb: string;
  event: string;
  /** Quote character used for the event literal. */
  quote: string;
}

interface BusIndex {
  /** bus label → event key → pairing state. */
  events: Map<string, Map<string, EventEntry>>;
  /** file → dispatch sites found in it. */
  sites: Map<string, DispatchSite[]>;
  /** Files the scan actually read (others fall back to a per-line read). */
  scanned: Set<string>;
}

/** Parsed config per project root, refreshed by `detect()` on every run. */
const VOCABS = new Map<string, Vocab>();
/** Scan results per project root, rebuilt lazily on the first claimed ref. */
const INDEXES = new Map<string, BusIndex>();
/**
 * Union of every configured project's claimed names. `claimsReference` gets no
 * context and therefore no project root, so it answers from the union; the
 * per-root check still happens in `resolve`, and a claim only means "let this
 * name reach resolve", never "resolve it".
 */
let CLAIMED: ReadonlySet<string> = new Set<string>();

function rebuildClaimed(): void {
  const union = new Set<string>();
  for (const vocab of VOCABS.values()) {
    for (const name of vocab.claimed) union.add(name);
  }
  CLAIMED = union;
}

/** Test/maintenance hook: forget every project's parsed config and scan. */
export function resetEventBusPluginState(): void {
  VOCABS.clear();
  INDEXES.clear();
  CLAIMED = new Set<string>();
}

// ---------------------------------------------------------------------------
// Config parsing
// ---------------------------------------------------------------------------

const IDENT_RE = /^[A-Za-z_$][\w$]*$/;
const OBJECT_RE = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/;

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Validated, de-duplicated string list; warns once per rejected value. */
function stringList(
  raw: unknown,
  shape: RegExp,
  limit: number,
  what: string
): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    logWarn(`${EVENT_BUS_PLUGIN_NAME}: "${what}" must be an array of strings — ignoring it`);
    return [];
  }
  const out: string[] = [];
  for (const value of raw) {
    if (typeof value !== 'string') {
      logWarn(`${EVENT_BUS_PLUGIN_NAME}: "${what}" entries must be strings — skipping one`);
      continue;
    }
    const trimmed = value.trim();
    if (!shape.test(trimmed)) {
      logWarn(`${EVENT_BUS_PLUGIN_NAME}: "${what}" entry ${JSON.stringify(value)} is not a valid name — skipping it`);
      continue;
    }
    if (!out.includes(trimmed)) out.push(trimmed);
    if (out.length >= limit) break;
  }
  return out;
}

function cap(raw: unknown, fallback: number, what: string): number {
  if (raw === undefined) return fallback;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 1) {
    logWarn(`${EVENT_BUS_PLUGIN_NAME}: "${what}" must be a positive number — using ${fallback}`);
    return fallback;
  }
  return Math.min(Math.floor(raw), CAP_LIMIT);
}

function buildBus(
  raw: EventBusChannelOptions,
  objects: string[],
  maxChainDepth: number
): BusSpec | null {
  if (objects.length === 0) return null;
  const dispatch = stringList(raw.dispatch, IDENT_RE, MAX_VERBS_PER_LIST, 'dispatch');
  const subscribe = stringList(raw.subscribe, IDENT_RE, MAX_VERBS_PER_LIST, 'subscribe');
  const dispatchVerbs = dispatch.length > 0 ? dispatch : DEFAULT_DISPATCH_VERBS;
  const subscribeVerbs = subscribe.length > 0 ? subscribe : DEFAULT_SUBSCRIBE_VERBS;

  const objectAlt = objects.map(escapeRe).join('|');
  // `(?<![\w$])` keeps `myBus` from matching a declared `Bus` while still
  // allowing a receiver (`this.$bus`), whose preceding char is a dot.
  const receiver = `(?<![\\w$])(?:${objectAlt})\\s*\\.\\s*`;
  return {
    label: typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : objects[0]!,
    objects,
    dispatch: new Set(dispatchVerbs),
    subscribe: new Set(subscribeVerbs),
    dispatchRe: new RegExp(
      `${receiver}(${dispatchVerbs.map(escapeRe).join('|')})\\s*\\(\\s*(['"\`])([^'"\`\\n]+)\\2`,
      'g'
    ),
    // Named handlers only: a named function expression, or a dotted chain of up
    // to `maxChainDepth` segments (`handler`, `this.handler`,
    // `receiver.handler`, `this.root.ns.handler`), any of them optionally
    // bound. The chain bound lives in the regex on purpose — a longer
    // expression then fails to match OUTRIGHT rather than matching some suffix
    // of itself, which would invent a receiver path that isn't there.
    //
    // The required `)`/`,` tail is what excludes every anonymous form —
    // `(e) => …`, `e => …`, `async () => …`, `function () {}` can none of them
    // satisfy it, and an anonymous body has no node to point at anyway. It is
    // also what peels `.bind(this)` back off the chain: the chain is greedy, so
    // it first swallows `…handler.bind`, fails the tail on the `(`, and
    // backtracks onto the explicit bind clause.
    subscribeRe: new RegExp(
      `${receiver}(${subscribeVerbs.map(escapeRe).join('|')})\\s*\\(\\s*(['"\`])([^'"\`\\n]+)\\2\\s*,\\s*` +
        `(?:function\\s+([\\w$]+)` +
        `|([A-Za-z_$][\\w$]*(?:\\s*\\.\\s*[A-Za-z_$][\\w$]*){0,${maxChainDepth - 1}}))` +
        `(?:\\s*\\.\\s*bind\\s*\\([^)\\n]*\\))?\\s*[),]`,
      'g'
    ),
  };
}

/** Clamp for `maxHandlerChainDepth` — its own, tighter than the fan-out caps. */
function chainDepth(raw: unknown): number {
  if (raw === undefined) return DEFAULT_MAX_HANDLER_CHAIN_DEPTH;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 1) {
    logWarn(
      `${EVENT_BUS_PLUGIN_NAME}: "maxHandlerChainDepth" must be a positive number — using ${DEFAULT_MAX_HANDLER_CHAIN_DEPTH}`
    );
    return DEFAULT_MAX_HANDLER_CHAIN_DEPTH;
  }
  return Math.min(Math.floor(raw), MAX_HANDLER_CHAIN_DEPTH_LIMIT);
}

/**
 * A handler expression split into the symbol it names and the path it was
 * reached through, or null when the expression is unusable (empty, deeper than
 * the cap, or ending on `this`).
 */
interface HandlerExpr {
  /** Final segment — the symbol the subscription points at. */
  name: string;
  /** Segments in front of it, with any leading `this`/`self` dropped. */
  receiver: string[];
  /**
   * The expression started at `this`/`self`. With no further receiver segments
   * that makes the handler a member of the ENCLOSING object, which nothing
   * project-wide can corroborate.
   */
  enclosing: boolean;
}

function parseHandlerExpr(raw: string, maxDepth: number): HandlerExpr | null {
  const segments: string[] = [];
  for (const part of raw.split('.')) {
    const trimmed = part.trim();
    if (!trimmed) return null;
    segments.push(trimmed);
  }
  if (segments.length === 0 || segments.length > maxDepth) return null;
  const name = segments[segments.length - 1]!;
  // `foo.this` is not a handler, and a bare `this` names no symbol.
  if (SELF_SEGMENTS.has(name)) return null;
  let start = 0;
  while (start < segments.length - 1 && SELF_SEGMENTS.has(segments[start]!)) start += 1;
  return {
    name,
    receiver: segments.slice(start, segments.length - 1),
    enclosing: start > 0,
  };
}

/**
 * Parse `plugins["event-bus"]` into a vocabulary, or null when the project
 * declares nothing usable (in which case the plugin stays undetected).
 */
function buildVocab(projectRoot: string): Vocab | null {
  const options = getPluginOptions<EventBusPluginOptions>(projectRoot, EVENT_BUS_PLUGIN_NAME);
  const buses: BusSpec[] = [];
  // Handler-expression depth is a plugin-level precision knob, not a per-bus
  // vocabulary choice, so every bus's subscribe regex is built with the same one.
  const maxChainDepth = chainDepth(options.maxHandlerChainDepth);

  // Shorthand: every top-level object is its own independent bus.
  const flatObjects = stringList(options.objects, OBJECT_RE, MAX_OBJECTS_PER_BUS, 'objects');
  for (const object of flatObjects) {
    const bus = buildBus(options, [object], maxChainDepth);
    if (bus) buses.push(bus);
  }

  // Long form: one entry per bus, its objects being aliases of that one bus.
  const rawBuses = options.buses;
  if (rawBuses !== undefined) {
    if (!Array.isArray(rawBuses)) {
      logWarn(`${EVENT_BUS_PLUGIN_NAME}: "buses" must be an array — ignoring it`);
    } else {
      for (const entry of rawBuses.slice(0, MAX_BUSES)) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
          logWarn(`${EVENT_BUS_PLUGIN_NAME}: each "buses" entry must be an object — skipping one`);
          continue;
        }
        const channel = entry as EventBusChannelOptions;
        const objects = stringList(channel.objects, OBJECT_RE, MAX_OBJECTS_PER_BUS, 'buses[].objects');
        const bus = buildBus(channel, objects, maxChainDepth);
        if (bus) buses.push(bus);
        else {
          logWarn(`${EVENT_BUS_PLUGIN_NAME}: a "buses" entry declares no usable "objects" — skipping it`);
        }
      }
    }
  }

  if (buses.length === 0) return null;

  const byObject = new Map<string, BusSpec>();
  const dispatchVerbs = new Set<string>();
  const claimed = new Set<string>();
  const tokens: string[] = [];
  for (const bus of buses.slice(0, MAX_BUSES)) {
    for (const object of bus.objects) {
      if (byObject.has(object)) {
        logWarn(`${EVENT_BUS_PLUGIN_NAME}: object ${JSON.stringify(object)} is declared on more than one bus — keeping the first`);
        continue;
      }
      byObject.set(object, bus);
      const head = object.slice(object.lastIndexOf('.') + 1);
      if (!tokens.includes(head)) tokens.push(head);
      for (const verb of bus.dispatch) claimed.add(`${object}.${verb}`);
    }
    for (const verb of bus.dispatch) dispatchVerbs.add(verb);
  }

  return {
    buses: buses.slice(0, MAX_BUSES),
    byObject,
    dispatchVerbs,
    claimed,
    tokens,
    maxHandlers: cap(options.maxHandlersPerEvent, DEFAULT_MAX_HANDLERS_PER_EVENT, 'maxHandlersPerEvent'),
    maxDispatchers: cap(options.maxDispatchersPerEvent, DEFAULT_MAX_DISPATCHERS_PER_EVENT, 'maxDispatchersPerEvent'),
    maxChainDepth,
    deferToBuiltin: options.deferToBuiltinEmitter !== false,
  };
}

// ---------------------------------------------------------------------------
// Scanning
// ---------------------------------------------------------------------------

/**
 * Per-match line resolver over `src`, 1-based. Built lazily and answered by
 * binary search: the `src.slice(0, i).split('\n').length` idiom is O(file) per
 * match, which goes quadratic on a file dense with bus calls.
 */
function makeLineAt(src: string): (index: number) => { line: number; column: number } {
  let starts: number[] | null = null;
  return (index: number) => {
    if (!starts) {
      starts = [0];
      for (let i = src.indexOf('\n'); i !== -1; i = src.indexOf('\n', i + 1)) starts.push(i + 1);
    }
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid]! <= index) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo + 1, column: index - starts[lo]! };
  };
}

function fileLanguage(nodes: Node[]): Language | null {
  for (const node of nodes) {
    if (node.language) return node.language;
  }
  return null;
}

/** Extensions a relative module specifier may resolve to, in preference order. */
const MODULE_EXTENSIONS = [
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts',
  '.vue', '.svelte', '.ets', '.py', '.rb', '.php',
];

/**
 * The file a RELATIVE module specifier points at, or null. Import mappings
 * carry a `resolvedPath` only sometimes — the full import resolver runs later,
 * on its own references — so a relative specifier is walked here directly. Only
 * relative forms are handled: a bare specifier is a package, and a path alias
 * belongs to the import resolver, not to a plugin guessing at it.
 */
function resolveRelativeModule(
  context: ResolutionContext,
  file: string,
  source: string
): string | null {
  if (!source.startsWith('./') && !source.startsWith('../')) return null;
  const dir = file.replace(/\\/g, '/').slice(0, file.lastIndexOf('/') + 1);
  const stack: string[] = [];
  for (const part of (dir + source).split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') stack.pop();
    else stack.push(part);
  }
  const base = stack.join('/');
  if (!base) return null;
  if (/\.[A-Za-z0-9]+$/.test(base) && context.fileExists(base)) return base;
  for (const ext of MODULE_EXTENSIONS) {
    if (context.fileExists(base + ext)) return base + ext;
    if (context.fileExists(`${base}/index${ext}`)) return `${base}/index${ext}`;
  }
  return null;
}

/**
 * Is `node` a member of something the receiver path's OWNER segment names —
 * either through its qualified name (`Owner::member`) or by living inside the
 * span of a same-file node called `owner` (an object literal's methods, a
 * class's methods)? This is the only corroboration a receiver path can offer
 * without type information, so it is used to PREFER and to NARROW candidates,
 * never on its own to accept one.
 */
function ownedBy(ownerScope: Node[], owner: string, node: Node): boolean {
  const qualified = node.qualifiedName;
  if (qualified) {
    // Only the SCOPE part counts — the trailing segment is the member's own
    // name. Path separators are deliberately not split on: a qualified name
    // that embeds a file path would otherwise let a directory name pose as an
    // owner and wave through every candidate under it.
    const scope = qualified.split(/(?:::|[.#])+/);
    for (let i = 0; i < scope.length - 1; i += 1) {
      if (scope[i] === owner) return true;
    }
  }
  for (const candidate of ownerScope) {
    if (candidate.name !== owner || candidate.id === node.id) continue;
    const from = candidate.startLine;
    const to = candidate.endLine ?? candidate.startLine;
    if (from <= node.startLine && to >= (node.endLine ?? node.startLine)) return true;
  }
  return false;
}

/**
 * Does the registering file bind `name` as a local `const`/`let`/`var` that
 * extraction produced no node for? Then the name is LOCAL — a callback declared
 * inside another function, typically — and a project-wide symbol that happens to
 * share it is a different thing entirely.
 */
function bindsLocally(source: string | undefined, name: string): boolean {
  if (!source) return false;
  return new RegExp(`(?:^|[^\\w$.])(?:const|let|var)\\s+${escapeRe(name)}\\s*=`, 'm').test(source);
}

/**
 * The function/method node a handler expression refers to, or null when it
 * cannot be pinned down. Order is unchanged — the registering file itself (the
 * common case, and the only unambiguous one), then the file the handler or its
 * receiver path was imported from, then a project-wide match — and the
 * project-wide tier still demands EXACTLY ONE survivor.
 *
 * What the receiver path adds is which of those tiers may answer at all, and
 * which candidate wins when a tier offers several. See the "Receiver paths"
 * section in this file's header.
 */
function findHandler(
  context: ResolutionContext,
  file: string,
  fileNodes: Node[],
  language: Language | null,
  handler: HandlerExpr,
  source?: string
): Node | null {
  const { name, receiver } = handler;
  const owner = receiver.length > 0 ? receiver[receiver.length - 1]! : null;
  const root = receiver.length > 0 ? receiver[0]! : null;

  // 1. The registering file. With a receiver path, prefer a candidate the owner
  //    segment actually encloses; without one, the earliest declaration wins.
  const local: Node[] = [];
  for (const node of fileNodes) {
    if (node.name === name && HANDLER_KINDS.has(node.kind)) local.push(node);
  }
  if (local.length > 0) {
    let best: Node | null = null;
    let bestOwned = false;
    for (const node of local) {
      const owned = owner ? ownedBy(fileNodes, owner, node) : false;
      if (!best || (owned && !bestOwned) || (owned === bestOwned && node.startLine < best.startLine)) {
        best = node;
        bestOwned = owned;
      }
    }
    if (best) return best;
  }

  // 2. The file the handler — or the receiver path's root or owner — was
  //    imported from. A `this`-only receiver has no path to import.
  if (language) {
    const nameInFile = (filePath: string, wanted: string): Node | null => {
      for (const node of context.getNodesInFile(filePath)) {
        if (HANDLER_KINDS.has(node.kind) && node.name === wanted) return node;
      }
      return null;
    };
    try {
      for (const mapping of context.getImportMappings(file, language)) {
        const wantsName = mapping.localName === name;
        // `store.onX` / `ns.store.onX` — a receiver segment names the module,
        // the final segment names the handler inside it.
        const wantsReceiver =
          !wantsName && (mapping.localName === root || mapping.localName === owner);
        if (!wantsName && !wantsReceiver) continue;
        const target = mapping.resolvedPath ?? resolveRelativeModule(context, file, mapping.source);
        if (!target) continue;
        const hit = wantsName
          ? (nameInFile(target, mapping.exportedName || name) ?? nameInFile(target, name))
          : nameInFile(target, name);
        if (hit) return hit;
      }
    } catch {
      // Import mappings are an optimization, never a requirement.
    }
  }

  // 3. Project-wide — but only when there is something to project onto.
  //    `this.onX` names a member of the enclosing object; a same-named function
  //    in an unrelated file is a coincidence, not that member.
  if (handler.enclosing && receiver.length === 0) return null;
  if (receiver.length === 0 && bindsLocally(source, name)) return null;

  const matches = context.getNodesByName(name).filter((node) => HANDLER_KINDS.has(node.kind));
  if (matches.length === 1) return matches[0]!;
  // Several candidates: the owner segment may still single one out, but only if
  // it singles out exactly one. Anything else stays ambiguous, i.e. nothing.
  if (!owner || matches.length === 0 || matches.length > MAX_NARROWED_CANDIDATES) return null;
  const narrowed = matches.filter((node) =>
    ownedBy(context.getNodesInFile(node.filePath), owner, node)
  );
  return narrowed.length === 1 ? narrowed[0]! : null;
}

function eventEntry(index: BusIndex, busLabel: string, event: string): EventEntry {
  let perBus = index.events.get(busLabel);
  if (!perBus) {
    perBus = new Map<string, EventEntry>();
    index.events.set(busLabel, perBus);
  }
  let entry = perBus.get(event);
  if (!entry) {
    entry = { handlers: new Map<string, Subscription>(), dispatchSites: 0, builtinSubscribe: false };
    perBus.set(event, entry);
  }
  return entry;
}

/**
 * One pass over the project's indexed files, recording every subscription and
 * every dispatch site per bus. Files that do not mention a declared bus object
 * are rejected by a substring test before anything expensive happens, so the
 * cost on a project that merely enables the plugin is a read per file.
 */
function buildIndex(context: ResolutionContext, vocab: Vocab): BusIndex {
  const index: BusIndex = { events: new Map(), sites: new Map(), scanned: new Set() };

  let files: string[];
  try {
    files = context.getAllFiles();
  } catch {
    return index;
  }

  for (const file of files) {
    let content: string | null;
    try {
      content = context.readFile(file);
    } catch {
      continue;
    }
    if (!content) continue;
    if (!vocab.tokens.some((token) => content!.includes(token))) continue;

    const fileNodes = context.getNodesInFile(file);
    const language = fileLanguage(fileNodes);
    const commentLang = language ? COMMENT_LANG[language] : undefined;
    if (!commentLang) continue;

    const source = stripCommentsForRegex(content, commentLang);
    const locate = makeLineAt(source);
    index.scanned.add(file);

    for (const bus of vocab.buses) {
      if (!bus.objects.some((object) => source.includes(object))) continue;

      bus.subscribeRe.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = bus.subscribeRe.exec(source))) {
        const verb = match[1]!;
        const quote = match[2]!;
        const event = match[3]!;
        if (!EVENT_KEY_RE.test(event)) continue;
        // A named function expression has no receiver; a chain carries one.
        const expr = match[4]
          ? { name: match[4], receiver: [] as string[], enclosing: false }
          : parseHandlerExpr(match[5] ?? '', vocab.maxChainDepth);
        if (!expr) continue;
        const handler = findHandler(context, file, fileNodes, language, expr, source);
        if (!handler) continue;
        const { line } = locate(match.index);
        const entry = eventEntry(index, bus.label, event);
        if (!entry.handlers.has(handler.id)) {
          entry.handlers.set(handler.id, {
            handlerId: handler.id,
            registeredAt: `${file}:${line}`,
            sortKey: `${handler.filePath}:${String(handler.startLine).padStart(8, '0')}:${handler.id}`,
          });
        }
        // Single/double quotes only: the built-in synthesizer's own regexes do
        // not match a template literal, so a backtick key is NOT covered by it.
        if (BUILTIN_SUBSCRIBE_VERBS.has(verb) && quote !== '`') entry.builtinSubscribe = true;
      }

      bus.dispatchRe.lastIndex = 0;
      while ((match = bus.dispatchRe.exec(source))) {
        const verb = match[1]!;
        const quote = match[2]!;
        const event = match[3]!;
        if (!EVENT_KEY_RE.test(event)) continue;
        const { line, column } = locate(match.index);
        eventEntry(index, bus.label, event).dispatchSites += 1;
        const sites = index.sites.get(file);
        const site: DispatchSite = { line, column, busLabel: bus.label, verb, event, quote };
        if (sites) sites.push(site);
        else index.sites.set(file, [site]);
      }
    }
  }

  return index;
}

function indexFor(context: ResolutionContext, projectRoot: string, vocab: Vocab): BusIndex {
  let index = INDEXES.get(projectRoot);
  if (!index) {
    index = buildIndex(context, vocab);
    INDEXES.set(projectRoot, index);
  }
  return index;
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/** The bus a `<objectExpression>` belongs to, allowing a receiver prefix. */
function busFor(vocab: Vocab, objectPath: string): BusSpec | undefined {
  const direct = vocab.byObject.get(objectPath);
  if (direct) return direct;
  const dot = objectPath.lastIndexOf('.');
  return dot > 0 ? vocab.byObject.get(objectPath.slice(dot + 1)) : undefined;
}

/** Pick the recorded dispatch site that matches this reference's position. */
function siteAt(
  index: BusIndex,
  ref: UnresolvedRef,
  bus: BusSpec,
  verb: string
): DispatchSite | null {
  const sites = index.sites.get(ref.filePath);
  if (!sites) return null;
  let best: DispatchSite | null = null;
  let bestDelta = Number.POSITIVE_INFINITY;
  for (const site of sites) {
    if (site.line !== ref.line || site.busLabel !== bus.label || site.verb !== verb) continue;
    const delta = Math.abs(site.column - ref.column);
    if (delta < bestDelta) {
      best = site;
      bestDelta = delta;
    } else if (delta === bestDelta && best && best.event !== site.event) {
      return null; // Two equally-close dispatches of different events — never guess.
    }
  }
  return best;
}

/**
 * Fallback for a file the scan skipped (a language with no comment stripper).
 * Reads just the reference's own line — `getFileLines` is LRU-cached, so this
 * never re-splits a whole file per reference.
 */
function siteFromLine(
  context: ResolutionContext,
  ref: UnresolvedRef,
  bus: BusSpec,
  verb: string
): DispatchSite | null {
  let line: string | undefined;
  try {
    const lines = context.getFileLines
      ? context.getFileLines(ref.filePath)
      : (context.readFile(ref.filePath)?.split(/\r?\n/) ?? null);
    line = lines?.[ref.line - 1];
  } catch {
    return null;
  }
  if (!line) return null;

  let best: DispatchSite | null = null;
  let bestDelta = Number.POSITIVE_INFINITY;
  bus.dispatchRe.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = bus.dispatchRe.exec(line))) {
    if (match[1] !== verb || !EVENT_KEY_RE.test(match[3]!)) continue;
    const delta = Math.abs(match.index - ref.column);
    if (delta < bestDelta) {
      best = {
        line: ref.line,
        column: match.index,
        busLabel: bus.label,
        verb,
        event: match[3]!,
        quote: match[2]!,
      };
      bestDelta = delta;
    }
  }
  return best;
}

export const eventBusPlugin: FrameworkResolver = {
  name: EVENT_BUS_PLUGIN_NAME,

  /**
   * Config-gated like every plugin. Also refreshes the parsed vocabulary and
   * drops the previous run's scan — `detect()` runs once per resolution pass,
   * which makes it the natural (and only) invalidation point available to a
   * plugin, so an incremental sync never resolves against a stale index.
   */
  detect(context: ResolutionContext): boolean {
    let projectRoot: string;
    try {
      projectRoot = context.getProjectRoot();
    } catch {
      return false;
    }
    try {
      INDEXES.delete(projectRoot);
      if (!isPluginEnabled(projectRoot, EVENT_BUS_PLUGIN_NAME)) {
        if (VOCABS.delete(projectRoot)) rebuildClaimed();
        return false;
      }
      const vocab = buildVocab(projectRoot);
      if (!vocab) {
        logWarn(
          `${EVENT_BUS_PLUGIN_NAME}: enabled but no bus objects are declared — set "objects" or "buses" in codegraph.json`
        );
        if (VOCABS.delete(projectRoot)) rebuildClaimed();
        return false;
      }
      VOCABS.set(projectRoot, vocab);
      rebuildClaimed();
      return true;
    } catch {
      if (VOCABS.delete(projectRoot)) rebuildClaimed();
      return false;
    }
  },

  /**
   * Opt `<object>.<dispatchVerb>` past the resolver's "no node has this name"
   * pre-filter. Hot path — a Set lookup and, only for a doubly-dotted name, one
   * more. Empty (and therefore free) for any project that configured no bus.
   */
  claimsReference(name: string): boolean {
    if (CLAIMED.size === 0) return false;
    if (CLAIMED.has(name)) return true;
    const dot = name.lastIndexOf('.');
    if (dot <= 0) return false;
    const prev = name.lastIndexOf('.', dot - 1);
    return prev >= 0 && CLAIMED.has(name.slice(prev + 1));
  },

  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
    if (VOCABS.size === 0) return null;
    if (ref.referenceKind !== 'calls') return null;
    const dot = ref.referenceName.lastIndexOf('.');
    if (dot <= 0) return null;

    let projectRoot: string;
    try {
      projectRoot = context.getProjectRoot();
    } catch {
      return null;
    }
    const vocab = VOCABS.get(projectRoot);
    if (!vocab) return null;

    const verb = ref.referenceName.slice(dot + 1);
    if (!vocab.dispatchVerbs.has(verb)) return null;
    const bus = busFor(vocab, ref.referenceName.slice(0, dot));
    if (!bus || !bus.dispatch.has(verb)) return null;

    const index = indexFor(context, projectRoot, vocab);
    const site = siteAt(index, ref, bus, verb) ??
      (index.scanned.has(ref.filePath) ? null : siteFromLine(context, ref, bus, verb));
    if (!site) return null; // Dynamic key (`bus.send(name)`) or an unreadable line.

    const entry = index.events.get(bus.label)?.get(site.event);
    if (!entry || entry.handlers.size === 0) return null;

    // Fan-out caps — a generic key cannot be paired confidently without type
    // information, so skip it rather than over-link (the built-in synthesizer's
    // discipline, and the reason its cap is the default here).
    if (entry.handlers.size > vocab.maxHandlers) return null;
    if (entry.dispatchSites > vocab.maxDispatchers) return null;

    // Leave the pairs the built-in emitter synthesizer already covers to it, so
    // one hop never becomes two edges.
    if (
      vocab.deferToBuiltin &&
      entry.builtinSubscribe &&
      BUILTIN_DISPATCH_VERBS.has(verb) &&
      site.quote !== '`'
    ) {
      return null;
    }

    const candidates = [...entry.handlers.values()]
      .filter((subscription) => subscription.handlerId !== ref.fromNodeId)
      .sort((a, b) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0));
    const chosen = candidates[0];
    if (!chosen) return null;

    const result: EventBusResolvedRef = {
      original: ref,
      targetNodeId: chosen.handlerId,
      // One reference yields one edge, so a multi-handler event is an
      // approximation — deterministic, but say so through the confidence.
      confidence: candidates.length === 1 ? 0.95 : 0.9,
      resolvedBy: 'framework',
      edge: {
        provenance: 'heuristic',
        metadata: {
          synthesizedBy: EVENT_BUS_SYNTHESIZED_BY,
          bus: bus.label,
          event: site.event,
          registeredAt: chosen.registeredAt,
          ...(candidates.length > 1 ? { handlerCount: candidates.length } : {}),
        },
      },
    };
    return result;
  },
};
