/**
 * Colour + size encoding for the canvas.
 *
 * Contract (`docs/design/visualizer.md`, "Visual language"): colour is a
 * switchable MODE — node kind or layer — and is applied as the ARC FILL of the
 * sunburst. Size is not a colour concern any more: an entry's LoC is its
 * angular extent, which the layout owns (`sunburst.ts`). Keep the two modes
 * visually distinct: kinds are a hand-picked semantic palette, layers a
 * generated hue ramp.
 */
import { DIRECTORY_KIND, type ModelNode } from './model';

export type ColorMode = 'kind' | 'layer';

/** Fallback for a node whose kind (or layer) has no dedicated colour. */
export const NEUTRAL_COLOR = '#8b98ad';

/**
 * Directories are GREY in both colour modes (phase F).
 *
 * A directory is scaffolding, not content: colouring it like a kind (or like a
 * layer it merely contains) made the disk's inner rings shout louder than the
 * code in them. Grey pushes structure to the background and lets the coloured
 * outer rings carry the meaning.
 */
export const DIRECTORY_COLOR = '#7c8698';

/**
 * "No layer" in the layer mode. Deliberately NOT grey — grey now means
 * "directory", and the two must not read as the same thing.
 */
export const NO_LAYER_COLOR = '#2dd4bf';

/**
 * NodeKind → colour, as SEVEN families (B3 — this supersedes the phase-F
 * table, which had grown by kind rather than by family).
 *
 * The rule is that a glance reads the FAMILY first and the exact kind second,
 * so the families have to be the ones a reader actually groups by, and each
 * family has to own a hue nobody else uses:
 *
 *  - **containers** — `file`, `module`, `namespace` — warm (amber → orange).
 *    A file is the thing a reader navigates by, so it gets the warmest, most
 *    findable colour on the disk; the two kinds that behave like a file to a
 *    reader sit beside it.
 *  - **type declarations** — `class`, `struct`, `interface`, `trait`,
 *    `protocol`, `union`, plus `enum` / `enum_member` / `type_alias` — purple.
 *    They are one idea ("this declares a type"), so they are one hue range,
 *    separated inside it by lightness and saturation rather than by hue:
 *    `class` is the loudest violet, `enum_member` is a lighter tint of `enum`,
 *    and the rarely-seen ones (`trait`, `protocol`, `union`) are the muted
 *    ones, which is also the right emphasis.
 *  - **callables** — `function`, `method` — two greens, unchanged.
 *  - **members** — `property`, `field` — teal: data, but data that belongs to
 *    something, so it sits between the callables and the free-standing data.
 *  - **data** — `variable`, `constant`, `parameter` — blue, with `parameter`
 *    the lightest of the three (it is the most incidental).
 *  - **plumbing** — `import`, `export` — cyan. They were grey, which said
 *    "ignore me" about the edges that carry a project's whole shape.
 *  - **framework** — `route`, `component` — rose and pink, deliberately the
 *    loudest thing on the disk: they are the entry points.
 */
const KIND_COLORS: Record<string, string> = {
  [DIRECTORY_KIND]: DIRECTORY_COLOR,
  // containers
  file: '#fbbd23',
  module: '#f99e2f',
  namespace: '#f78c45',
  // type declarations
  class: '#a68bf9',
  struct: '#b774f1',
  interface: '#945ef3',
  trait: '#c3bdf4',
  protocol: '#ab97d8',
  union: '#e5d8ee',
  enum: '#bf56f0',
  enum_member: '#deaef4',
  type_alias: '#da8cee',
  // callables
  function: '#7ee787',
  method: '#4ade80',
  // members
  property: '#5fe7c7',
  field: '#34d5c8',
  // data
  variable: '#639cf8',
  constant: '#5184f0',
  parameter: '#9bc7fd',
  // plumbing
  import: '#4bdbf1',
  export: '#94d9f9',
  // framework
  route: '#fb7185',
  component: '#f472b6',
};

/**
 * Legend reading order — BY FAMILY, and every kind, not a subset (B3).
 *
 * The legend is where the families above are actually learnt, so it lists them
 * contiguously: a reader scanning down it sees each hue arrive once and finish
 * before the next begins. It used to be a hand-picked dozen with everything
 * else appended alphabetically after them, which broke every family in two —
 * `class` and `interface` near the top, `struct` and `trait` alphabetised into
 * the tail. Anything not named here is still appended (a language could always
 * produce a kind this list has not heard of), and the legend still shows only
 * the kinds actually on the disk.
 */
const LEGEND_KIND_ORDER = [
  DIRECTORY_KIND,
  // containers
  'file',
  'module',
  'namespace',
  // type declarations
  'class',
  'struct',
  'interface',
  'trait',
  'protocol',
  'union',
  'enum',
  'enum_member',
  'type_alias',
  // callables
  'function',
  'method',
  // members
  'property',
  'field',
  // data
  'variable',
  'constant',
  'parameter',
  // plumbing
  'import',
  'export',
  // framework
  'route',
  'component',
];

/** Hue ramp for layers — generated, so any project vocabulary is covered. */
const LAYER_COLORS = [
  '#5ed3f3',
  '#7ee787',
  '#fbbf24',
  '#f472b6',
  '#a78bfa',
  '#fb923c',
  '#4ade80',
  '#f87171',
  '#38bdf8',
  '#c084fc',
];

export function colorForKind(kind: string): string {
  return KIND_COLORS[kind] ?? NEUTRAL_COLOR;
}

export function colorForLayer(layer: string | undefined, vocabulary: string[]): string {
  if (!layer) return NO_LAYER_COLOR;
  const index = vocabulary.indexOf(layer);
  if (index >= 0) return LAYER_COLORS[index % LAYER_COLORS.length]!;
  // A composite tag (`bs.ps`) isn't in the vocabulary — hash it for stability.
  let hash = 0;
  for (let i = 0; i < layer.length; i++) hash = (hash * 31 + layer.charCodeAt(i)) | 0;
  return LAYER_COLORS[Math.abs(hash) % LAYER_COLORS.length]!;
}

export function colorForNode(node: ModelNode, mode: ColorMode, layers: string[]): string {
  // A directory is grey in EVERY mode — see {@link DIRECTORY_COLOR}.
  if (node.kind === DIRECTORY_KIND) return DIRECTORY_COLOR;
  return mode === 'layer' ? colorForLayer(node.layer, layers) : colorForKind(node.kind);
}

/**
 * Legend key standing in for "this arc is a directory" in the LAYER mode,
 * where a directory has no layer of its own but is still on screen in grey.
 */
export const DIRECTORY_LEGEND_KEY = '@directory';

/**
 * Legend rows for the active mode: only entries that actually occur in the
 * mounted slice, so the legend never advertises colours that aren't on screen.
 */
export function legendEntries(
  mode: ColorMode,
  present: Set<string>,
  layers: string[]
): Array<{ key: string; label: string; color: string }> {
  if (mode === 'layer') {
    const rows = layers
      .filter((layer) => present.has(layer))
      .map((layer) => ({ key: layer, label: layer, color: colorForLayer(layer, layers) }));
    const extras = [...present]
      .filter((layer) => layer && layer !== DIRECTORY_LEGEND_KEY && !layers.includes(layer))
      .sort()
      .map((layer) => ({ key: layer, label: layer, color: colorForLayer(layer, layers) }));
    const rest = present.has('') ? [{ key: '', label: 'no layer', color: NO_LAYER_COLOR }] : [];
    const directories = present.has(DIRECTORY_LEGEND_KEY)
      ? [{ key: DIRECTORY_LEGEND_KEY, label: 'directory', color: DIRECTORY_COLOR }]
      : [];
    return [...rows, ...extras, ...rest, ...directories];
  }
  const ordered = LEGEND_KIND_ORDER.filter((kind) => present.has(kind));
  const extras = [...present].filter((kind) => !LEGEND_KIND_ORDER.includes(kind)).sort();
  return [...ordered, ...extras].map((kind) => ({
    key: kind,
    label: kind === DIRECTORY_KIND ? 'directory' : kind.replace(/_/g, ' '),
    color: colorForKind(kind),
  }));
}

/**
 * Edge colour is DIRECTION, not kind (phase F).
 *
 * Per-kind colours were a legend nobody could hold in their head while looking
 * at a rope of bundled curves. What a developer actually asks of an edge in
 * this view is "does this reach me, or do I reach it" — so an edge is green
 * when it comes INTO the hovered/selected wedge and amber when it goes OUT of
 * it. The kind is still on the wedge's tooltip and the edge chips; the
 * provenance distinction is orthogonal and survives as solid vs **dashed**.
 *
 * This table is the single source of truth: the canvas paints from it and the
 * legend panel reads the same entries, so the two can never drift.
 */
export type EdgeDirection = 'incoming' | 'outgoing' | 'neutral';

export const EDGE_DIRECTION_COLORS: Record<EdgeDirection, string> = {
  incoming: '#4ade80',
  outgoing: '#f5a524',
  neutral: '#8494ab',
};

/** Legend rows for edges: colour, label and what the colour means. */
export const EDGE_DIRECTION_LEGEND: Array<{
  key: EdgeDirection;
  label: string;
  meaning: string;
  color: string;
}> = [
  {
    key: 'incoming',
    label: 'incoming',
    meaning: 'something else references the focused entry',
    color: EDGE_DIRECTION_COLORS.incoming,
  },
  {
    key: 'outgoing',
    label: 'outgoing',
    meaning: 'the focused entry references something else',
    color: EDGE_DIRECTION_COLORS.outgoing,
  },
];

/** Provenance rows for the same legend — solid parsed, dashed synthesized. */
export const EDGE_PROVENANCE_LEGEND: Array<{
  key: 'parsed' | 'heuristic';
  label: string;
  meaning: string;
  dashed: boolean;
}> = [
  { key: 'parsed', label: 'solid', meaning: 'parsed from the source', dashed: false },
  { key: 'heuristic', label: 'dashed', meaning: 'synthesized (heuristic) relation', dashed: true },
];

export function colorForEdgeDirection(direction: EdgeDirection): string {
  return EDGE_DIRECTION_COLORS[direction];
}

