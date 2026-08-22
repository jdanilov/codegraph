/**
 * Colour + size encoding for the canvas.
 *
 * Contract (`docs/design/visualizer.md`, "Visual language"): colour is a
 * switchable MODE — node kind or layer — and size is LoC for directories and
 * files, span length for symbols. Keep the two modes visually distinct: kinds
 * are a hand-picked semantic palette, layers a generated hue ramp.
 */
import { DIRECTORY_KIND, type ModelNode } from './model';

export type ColorMode = 'kind' | 'layer';

/** Fallback for a node whose kind (or layer) has no dedicated colour. */
export const NEUTRAL_COLOR = '#8b98ad';

/**
 * NodeKind → colour. Related kinds share a hue family so a glance reads as
 * "containers / behaviour / data / plumbing" before it reads as exact kinds.
 */
const KIND_COLORS: Record<string, string> = {
  [DIRECTORY_KIND]: '#8ab4ff',
  file: '#5ed3f3',
  module: '#a5b4fc',
  namespace: '#a5b4fc',
  class: '#f0abfc',
  struct: '#e5a8fb',
  interface: '#c4b5fd',
  trait: '#c4b5fd',
  protocol: '#c4b5fd',
  function: '#7ee787',
  method: '#4ade80',
  property: '#fcd34d',
  field: '#fcd34d',
  variable: '#fbbf24',
  constant: '#f59e0b',
  enum: '#fb923c',
  enum_member: '#fdba74',
  type_alias: '#a78bfa',
  union: '#a78bfa',
  parameter: '#94a3b8',
  import: '#6b7a90',
  export: '#94a3b8',
  route: '#fb7185',
  component: '#f472b6',
};

/** Kinds worth listing in the legend, in a stable reading order. */
const LEGEND_KIND_ORDER = [
  DIRECTORY_KIND,
  'file',
  'class',
  'interface',
  'function',
  'method',
  'property',
  'constant',
  'type_alias',
  'route',
  'component',
  'import',
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
  if (!layer) return NEUTRAL_COLOR;
  const index = vocabulary.indexOf(layer);
  if (index >= 0) return LAYER_COLORS[index % LAYER_COLORS.length]!;
  // A composite tag (`bs.ps`) isn't in the vocabulary — hash it for stability.
  let hash = 0;
  for (let i = 0; i < layer.length; i++) hash = (hash * 31 + layer.charCodeAt(i)) | 0;
  return LAYER_COLORS[Math.abs(hash) % LAYER_COLORS.length]!;
}

export function colorForNode(node: ModelNode, mode: ColorMode, layers: string[]): string {
  return mode === 'layer' ? colorForLayer(node.layer, layers) : colorForKind(node.kind);
}

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
      .filter((layer) => layer && !layers.includes(layer))
      .sort()
      .map((layer) => ({ key: layer, label: layer, color: colorForLayer(layer, layers) }));
    const rest = present.has('') ? [{ key: '', label: 'no layer', color: NEUTRAL_COLOR }] : [];
    return [...rows, ...extras, ...rest];
  }
  const ordered = LEGEND_KIND_ORDER.filter((kind) => present.has(kind));
  const extras = [...present].filter((kind) => !LEGEND_KIND_ORDER.includes(kind)).sort();
  return [...ordered, ...extras].map((kind) => ({
    key: kind,
    label: kind === DIRECTORY_KIND ? 'directory' : kind.replace(/_/g, ' '),
    color: colorForKind(kind),
  }));
}

/** Colour per edge kind — muted, so edges never outshout nodes. */
const EDGE_COLORS: Record<string, string> = {
  calls: '#7dd3fc',
  imports: '#a5b4fc',
  references: '#94a3b8',
  extends: '#f0abfc',
  implements: '#e9a8fb',
  instantiates: '#fcd34d',
  returns: '#86efac',
  type_of: '#c4b5fd',
  overrides: '#fda4af',
  decorates: '#fdba74',
  exports: '#94a3b8',
};

export function colorForEdgeKind(kind: string): string {
  return EDGE_COLORS[kind] ?? '#7c8aa0';
}

/** The backbone (`contains`) is structure, not data — draw it quietly. */
export const BACKBONE_COLOR = 'rgba(150, 170, 200, 0.34)';
export const BACKBONE_SATELLITE_COLOR = 'rgba(150, 170, 200, 0.2)';

/**
 * Radius in graph units. Square-root so a 5,000-LoC directory reads as bigger
 * than a 500-LoC one without swallowing the screen.
 */
export function radiusForNode(node: ModelNode): number {
  if (node.kind === DIRECTORY_KIND) {
    return clamp(9 + 2.6 * Math.sqrt(node.weight), 10, 44);
  }
  if (node.kind === 'file') {
    return clamp(6 + 1.5 * Math.sqrt(node.weight), 7, 26);
  }
  return clamp(4 + 1.15 * Math.sqrt(node.weight), 4.5, 18);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
