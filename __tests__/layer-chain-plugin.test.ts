/**
 * Layer-chain plugin — inheritance across sibling files distinguished by a
 * filename suffix (`widget.ts` / `widget.bg.ts` / `widget.pp.tsx`).
 *
 * Three layers under test:
 *   1. Config: the `plugins.layer-chain` schema, its defaults, and the
 *      warn-and-skip behavior of every malformed value.
 *   2. Hooks: `claimsReference` (which opts these names past the resolver's
 *      "no node has this name" pre-filter) and `resolve` (one hop to the
 *      nearest strictly-more-general sibling), driven through a synthetic
 *      `ResolutionContext`.
 *   3. End to end: a real temp project, real files, real SQLite — the
 *      `extends` edges show up in the graph, and vanish when the config does.
 *
 * The headline invariant, asserted first and again at the end: a project with
 * no `plugins.layer-chain` entry behaves EXACTLY as it did before this plugin
 * existed — no detection, no claim, no resolution, no edge.
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { CodeGraph } from '../src';
import { initGrammars, loadAllGrammars } from '../src/extraction/grammars';
import { clearProjectConfigCache } from '../src/project-config';
import { clearPluginConfigCache } from '../src/resolution/plugins/plugin-config';
import {
  LAYER_CHAIN_PLUGIN_NAME,
  clearLayerChainCache,
  layerChainPlugin,
} from '../src/resolution/plugins/layer-chain';
import type { ResolutionContext, UnresolvedRef } from '../src/resolution/types';
import type { Node, NodeKind } from '../src/types';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let dir: string;

const writeConfig = (obj: unknown) =>
  fs.writeFileSync(
    path.join(dir, 'codegraph.json'),
    typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2)
  );

/** The representative suffix vocabulary used throughout. */
const LAYERS = ['bg', 'pp', 'cs', 'os', 'ps', 'bs'];

const enable = (options: Record<string, unknown> = { layers: LAYERS }) =>
  writeConfig({ plugins: { [LAYER_CHAIN_PLUGIN_NAME]: options } });

/** A class node at `filePath`, named `name`. */
function classNode(name: string, filePath: string, kind: NodeKind = 'class'): Node {
  return {
    id: `${kind}:${filePath}:${name}`,
    kind,
    name,
    qualifiedName: `${filePath}::${name}`,
    filePath,
    language: filePath.endsWith('x') ? 'tsx' : 'typescript',
    startLine: 1,
    endLine: 3,
    startColumn: 0,
    endColumn: 1,
  };
}

/** Context whose project root is the temp dir and whose name index is `nodes`. */
function makeContext(nodes: Node[] = []): ResolutionContext {
  const byName = new Map<string, Node[]>();
  for (const node of nodes) {
    const list = byName.get(node.name);
    if (list) list.push(node);
    else byName.set(node.name, [node]);
  }
  return {
    getNodesInFile: (p) => nodes.filter((n) => n.filePath === p),
    getNodesByName: (name) => byName.get(name) ?? [],
    getNodesByQualifiedName: () => [],
    getNodesByKind: () => [],
    getNodesByLowerName: () => [],
    getImportMappings: () => [],
    fileExists: () => false,
    readFile: () => null,
    getProjectRoot: () => dir,
    getAllFiles: () => nodes.map((n) => n.filePath),
  };
}

function extendsRef(referenceName: string, filePath: string): UnresolvedRef {
  return {
    fromNodeId: `class:${filePath}:child`,
    referenceName,
    referenceKind: 'extends',
    line: 1,
    column: 0,
    filePath,
    language: filePath.endsWith('x') ? 'tsx' : 'typescript',
  };
}

/**
 * The canonical unit: a shared base, two single-context specializations, and a
 * multi-tag intermediate with its own specialization below it.
 */
const UNIT_NODES = [
  classNode('Widget', 'src/widget/widget.ts'),
  classNode('Widget', 'src/widget/widget.bg.ts'),
  classNode('Widget', 'src/widget/widget.pp.tsx'),
  classNode('Gauge', 'src/gauge/gauge.bs.ps.ts'),
  classNode('Gauge', 'src/gauge/gauge.bs.ts'),
  classNode('Gauge', 'src/gauge/gauge.ps.ts'),
  // The framework base class every unit ultimately derives from — a DIFFERENT
  // stem in a DIFFERENT directory, so it is not layer chaining.
  classNode('Unit', 'src/unit/unit.ts'),
];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-layer-chain-'));
  clearProjectConfigCache();
  clearPluginConfigCache();
  clearLayerChainCache();
});

afterEach(() => {
  clearProjectConfigCache();
  clearPluginConfigCache();
  clearLayerChainCache();
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 1. Opt-in gate — the no-regression invariant
// ---------------------------------------------------------------------------

describe('layer-chain: a project with no config is untouched', () => {
  it('does not detect, claim, or resolve when there is no codegraph.json', () => {
    const context = makeContext(UNIT_NODES);
    expect(layerChainPlugin.detect(context)).toBe(false);
    expect(layerChainPlugin.claimsReference?.('$.Widget')).toBe(false);
    expect(
      layerChainPlugin.resolve(extendsRef('$.Widget', 'src/widget/widget.bg.ts'), context)
    ).toBeNull();
  });

  it('stays off when codegraph.json exists but names no plugins', () => {
    writeConfig({ exclude: ['vendor/**'] });
    const context = makeContext(UNIT_NODES);
    expect(layerChainPlugin.detect(context)).toBe(false);
    expect(layerChainPlugin.claimsReference?.('$.Widget')).toBe(false);
    expect(
      layerChainPlugin.resolve(extendsRef('$.Widget', 'src/widget/widget.bg.ts'), context)
    ).toBeNull();
  });

  it('stays off when another plugin is enabled', () => {
    writeConfig({ plugins: { noop: { label: 'x' } } });
    expect(layerChainPlugin.detect(makeContext(UNIT_NODES))).toBe(false);
  });

  it('stays off when explicitly disabled even with options present', () => {
    writeConfig({
      plugins: { disable: [LAYER_CHAIN_PLUGIN_NAME], [LAYER_CHAIN_PLUGIN_NAME]: { layers: LAYERS } },
    });
    expect(layerChainPlugin.detect(makeContext(UNIT_NODES))).toBe(false);
  });

  it('detects once a layers vocabulary is declared', () => {
    enable();
    expect(layerChainPlugin.detect(makeContext(UNIT_NODES))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. Config validation — warn and skip, never throw
// ---------------------------------------------------------------------------

describe('layer-chain: config validation', () => {
  const badConfigs: Array<[string, Record<string, unknown> | true]> = [
    ['no options at all (bare `true`)', true],
    ['missing layers', {}],
    ['layers is not an array', { layers: 'bg,pp' }],
    ['layers is empty', { layers: [] }],
    ['layers has no usable entries', { layers: ['', '  ', 'has.dot', 42] }],
    ['sigils is present but empty', { layers: LAYERS, sigils: [] }],
    ['sigils has no usable entries', { layers: LAYERS, sigils: ['', 'a.b'] }],
  ];

  for (const [label, options] of badConfigs) {
    it(`stays inert and does not throw: ${label}`, () => {
      writeConfig({ plugins: { [LAYER_CHAIN_PLUGIN_NAME]: options } });
      const context = makeContext(UNIT_NODES);
      expect(() => layerChainPlugin.detect(context)).not.toThrow();
      expect(layerChainPlugin.detect(context)).toBe(false);
      expect(
        layerChainPlugin.resolve(extendsRef('$.Widget', 'src/widget/widget.bg.ts'), context)
      ).toBeNull();
    });
  }

  it('skips individual bad layer tags but keeps the good ones', () => {
    enable({ layers: ['bg', 'HAS.DOT', '', 7, 'pp'] });
    const context = makeContext(UNIT_NODES);
    expect(layerChainPlugin.detect(context)).toBe(true);
    expect(
      layerChainPlugin.resolve(extendsRef('$.Widget', 'src/widget/widget.bg.ts'), context)
        ?.targetNodeId
    ).toBe(classNode('Widget', 'src/widget/widget.ts').id);
  });

  it('falls back to the default `$` sigil when sigils is omitted', () => {
    enable({ layers: LAYERS });
    layerChainPlugin.detect(makeContext(UNIT_NODES));
    expect(layerChainPlugin.claimsReference?.('$.Widget')).toBe(true);
  });

  it('honors a custom sigil list', () => {
    enable({ layers: LAYERS, sigils: ['@ns'] });
    const context = makeContext(UNIT_NODES);
    layerChainPlugin.detect(context);
    expect(layerChainPlugin.claimsReference?.('@ns.Widget')).toBe(true);
    expect(layerChainPlugin.claimsReference?.('$.Widget')).toBe(false);
    expect(
      layerChainPlugin.resolve(extendsRef('@ns.Widget', 'src/widget/widget.bg.ts'), context)
        ?.targetNodeId
    ).toBe(classNode('Widget', 'src/widget/widget.ts').id);
  });

  it('tolerates a non-array roots value by ignoring the scope restriction', () => {
    enable({ layers: LAYERS, roots: 'src' });
    const context = makeContext(UNIT_NODES);
    expect(layerChainPlugin.detect(context)).toBe(true);
    expect(
      layerChainPlugin.resolve(extendsRef('$.Widget', 'src/widget/widget.bg.ts'), context)
    ).not.toBeNull();
  });

  it('picks up a rewritten config after the project-config cache is cleared', () => {
    enable({ layers: ['bg'] });
    expect(layerChainPlugin.detect(makeContext(UNIT_NODES))).toBe(true);
    expect(layerChainPlugin.claimsReference?.('$.Widget')).toBe(true);

    writeConfig({ plugins: {} });
    clearProjectConfigCache();
    clearPluginConfigCache();
    expect(layerChainPlugin.claimsReference?.('$.Widget')).toBe(false);
    expect(layerChainPlugin.detect(makeContext(UNIT_NODES))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. claimsReference — the pre-filter escape hatch
// ---------------------------------------------------------------------------

describe('layer-chain: claimsReference', () => {
  beforeEach(() => {
    enable();
    // `detect` is what registers the project root; the resolver always runs it
    // before any reference reaches the pre-filter.
    layerChainPlugin.detect(makeContext(UNIT_NODES));
  });

  const claimed = ['$.Widget', '$.Gauge', 'bsPs.Gauge', 'bs.Gauge', 'bsOsPs.Thing'];
  for (const name of claimed) {
    it(`claims ${name}`, () => {
      expect(layerChainPlugin.claimsReference?.(name)).toBe(true);
    });
  }

  const rejected = [
    'Widget', // no namespace at all
    '$.Widget.Deep', // more than one dot — a member chain, not a supertype
    '$.', // nothing after the dot
    '.Widget', // nothing before it
    'lodash.merge', // a real imported namespace
    'bsXx.Gauge', // decodes to a tag that isn't declared
    'bsBs.Gauge', // repeated tag
    '$.widget()', // not a bare identifier
  ];
  for (const name of rejected) {
    it(`does not claim ${name}`, () => {
      expect(layerChainPlugin.claimsReference?.(name)).toBe(false);
    });
  }
});

// ---------------------------------------------------------------------------
// 4. resolve — the chain itself
// ---------------------------------------------------------------------------

describe('layer-chain: resolve', () => {
  let context: ResolutionContext;

  beforeEach(() => {
    enable();
    context = makeContext(UNIT_NODES);
    layerChainPlugin.detect(context);
  });

  const resolveTo = (name: string, file: string) =>
    layerChainPlugin.resolve(extendsRef(name, file), context)?.targetNodeId ?? null;

  it('resolves a single-tag file to its layer-stripped base', () => {
    expect(resolveTo('$.Widget', 'src/widget/widget.bg.ts')).toBe(
      classNode('Widget', 'src/widget/widget.ts').id
    );
  });

  it('resolves across a different extension (.pp.tsx -> .ts)', () => {
    expect(resolveTo('$.Widget', 'src/widget/widget.pp.tsx')).toBe(
      classNode('Widget', 'src/widget/widget.ts').id
    );
  });

  it('never chains one specialization to a sibling specialization', () => {
    // `.pp.tsx` reaches the base directly; `.bg.ts` is neither more nor less
    // general than it, so it can never be the target.
    expect(resolveTo('$.Widget', 'src/widget/widget.pp.tsx')).not.toBe(
      classNode('Widget', 'src/widget/widget.bg.ts').id
    );
  });

  it('resolves a single-tag file to the nearest multi-tag intermediate, not the base', () => {
    const withBase = makeContext([...UNIT_NODES, classNode('Gauge', 'src/gauge/gauge.ts')]);
    layerChainPlugin.detect(withBase);
    const hit = layerChainPlugin.resolve(extendsRef('$.Gauge', 'src/gauge/gauge.bs.ts'), withBase);
    expect(hit?.targetNodeId).toBe(classNode('Gauge', 'src/gauge/gauge.bs.ps.ts').id);
  });

  it('resolves a camelCase multi-tag sigil to exactly that sibling', () => {
    expect(resolveTo('bsPs.Gauge', 'src/gauge/gauge.bs.ts')).toBe(
      classNode('Gauge', 'src/gauge/gauge.bs.ps.ts').id
    );
    expect(resolveTo('bsPs.Gauge', 'src/gauge/gauge.ps.ts')).toBe(
      classNode('Gauge', 'src/gauge/gauge.bs.ps.ts').id
    );
  });

  it('resolves the multi-tag intermediate onward to the base — the chain is emergent', () => {
    const withBase = makeContext([...UNIT_NODES, classNode('Gauge', 'src/gauge/gauge.ts')]);
    layerChainPlugin.detect(withBase);
    const hop1 = layerChainPlugin.resolve(extendsRef('bsPs.Gauge', 'src/gauge/gauge.bs.ts'), withBase);
    expect(hop1?.targetNodeId).toBe(classNode('Gauge', 'src/gauge/gauge.bs.ps.ts').id);
    const hop2 = layerChainPlugin.resolve(
      extendsRef('$.Gauge', 'src/gauge/gauge.bs.ps.ts'),
      withBase
    );
    expect(hop2?.targetNodeId).toBe(classNode('Gauge', 'src/gauge/gauge.ts').id);
  });

  it('reports a near-exact framework resolution', () => {
    const hit = layerChainPlugin.resolve(extendsRef('$.Widget', 'src/widget/widget.bg.ts'), context);
    expect(hit?.resolvedBy).toBe('framework');
    expect(hit?.confidence).toBeGreaterThanOrEqual(0.9);
  });
});

// ---------------------------------------------------------------------------
// 5. resolve — abstention. A wrong `extends` edge is worse than none.
// ---------------------------------------------------------------------------

describe('layer-chain: abstains rather than guesses', () => {
  let context: ResolutionContext;

  beforeEach(() => {
    enable();
    context = makeContext(UNIT_NODES);
    layerChainPlugin.detect(context);
  });

  const nothing = (name: string, file: string) =>
    expect(layerChainPlugin.resolve(extendsRef(name, file), context)).toBeNull();

  it('leaves a cross-stem framework base class alone', () => {
    // `Unit` exists, but in another unit's directory — a namespace reference
    // that happens to sit in an `extends` position, not layer chaining.
    nothing('$.Unit', 'src/widget/widget.bg.ts');
  });

  it('does not chain across directories with the same stem', () => {
    const other = makeContext([
      classNode('Widget', 'src/widget/widget.bg.ts'),
      classNode('Widget', 'src/other/widget.ts'),
    ]);
    layerChainPlugin.detect(other);
    expect(
      layerChainPlugin.resolve(extendsRef('$.Widget', 'src/widget/widget.bg.ts'), other)
    ).toBeNull();
  });

  it('does not resolve from an untagged base file', () => {
    nothing('$.Widget', 'src/widget/widget.ts');
  });

  it('does not resolve when no same-named sibling exists', () => {
    nothing('$.Missing', 'src/widget/widget.bg.ts');
  });

  it('does not treat an undeclared filename segment as a tag', () => {
    // `0` is not in the vocabulary, so `widget.bg.0.ts` is one opaque stem and
    // has no layer-stripped sibling at all.
    nothing('$.Widget', 'src/widget/widget.bg.0.ts');
  });

  it('rejects an exact-tag sigil that does not match the actual sibling', () => {
    // Nothing named `gauge.bs.os.ps.*` exists, so the decoded target is absent.
    nothing('bsOsPs.Gauge', 'src/gauge/gauge.bs.ts');
  });

  it('rejects an exact-tag sigil that is not more general than the referrer', () => {
    nothing('bs.Gauge', 'src/gauge/gauge.bs.ps.ts');
  });

  it('rejects a sigil that is neither configured nor a tag set', () => {
    nothing('core.Widget', 'src/widget/widget.bg.ts');
  });

  it('ignores a same-named non-type node in the sibling', () => {
    const other = makeContext([
      classNode('Widget', 'src/widget/widget.bg.ts'),
      classNode('Widget', 'src/widget/widget.ts', 'variable'),
    ]);
    layerChainPlugin.detect(other);
    expect(
      layerChainPlugin.resolve(extendsRef('$.Widget', 'src/widget/widget.bg.ts'), other)
    ).toBeNull();
  });

  it('abstains when two equally-near candidates tie', () => {
    const other = makeContext([
      classNode('Widget', 'src/widget/widget.bg.ts'),
      { ...classNode('Widget', 'src/widget/widget.ts'), id: 'class:a' },
      { ...classNode('Widget', 'src/widget/widget.ts'), id: 'class:b' },
    ]);
    layerChainPlugin.detect(other);
    expect(
      layerChainPlugin.resolve(extendsRef('$.Widget', 'src/widget/widget.bg.ts'), other)
    ).toBeNull();
  });

  it('honors the roots scope', () => {
    enable({ layers: LAYERS, roots: ['packages/app'] });
    clearProjectConfigCache();
    clearPluginConfigCache();
    clearLayerChainCache();
    const scoped = makeContext(UNIT_NODES);
    layerChainPlugin.detect(scoped);
    expect(
      layerChainPlugin.resolve(extendsRef('$.Widget', 'src/widget/widget.bg.ts'), scoped)
    ).toBeNull();

    const inScope = makeContext([
      classNode('Widget', 'packages/app/widget/widget.bg.ts'),
      classNode('Widget', 'packages/app/widget/widget.ts'),
    ]);
    layerChainPlugin.detect(inScope);
    expect(
      layerChainPlugin.resolve(extendsRef('$.Widget', 'packages/app/widget/widget.bg.ts'), inScope)
        ?.targetNodeId
    ).toBe(classNode('Widget', 'packages/app/widget/widget.ts').id);
  });
});

// ---------------------------------------------------------------------------
// 6. Scope boundary — `extends` and nothing else
// ---------------------------------------------------------------------------

describe('layer-chain: only claims extends references', () => {
  const otherKinds = [
    'calls',
    'references',
    'imports',
    'implements',
    'type_of',
    'instantiates',
    'function_ref',
  ] as const;

  for (const kind of otherKinds) {
    it(`is a strict no-op for referenceKind "${kind}"`, () => {
      enable();
      const context = makeContext(UNIT_NODES);
      layerChainPlugin.detect(context);
      const ref = {
        ...extendsRef('$.Widget', 'src/widget/widget.bg.ts'),
        referenceKind: kind,
      } as UnresolvedRef;
      expect(layerChainPlugin.resolve(ref, context)).toBeNull();
    });
  }
});

// ---------------------------------------------------------------------------
// 7. End to end — real files, real SQLite
// ---------------------------------------------------------------------------

describe('layer-chain: end to end', () => {
  let tmpDir: string | undefined;

  beforeAll(async () => {
    await initGrammars();
    await loadAllGrammars();
  });

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
    clearProjectConfigCache();
    clearPluginConfigCache();
    clearLayerChainCache();
  });

  /** A synthetic project using the suffix convention. `config` is optional. */
  function scaffold(config?: unknown): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-layer-e2e-'));
    fs.mkdirSync(path.join(root, 'src/widget'), { recursive: true });
    fs.mkdirSync(path.join(root, 'src/gauge'), { recursive: true });
    fs.mkdirSync(path.join(root, 'src/unit'), { recursive: true });
    const write = (p: string, c: string) => fs.writeFileSync(path.join(root, p), c);

    write('package.json', JSON.stringify({ name: 'layered-fixture', version: '1.0.0' }));
    write('src/unit/unit.ts', 'export class Unit<T> {\n  id = 0\n}\n');
    write(
      'src/widget/widget.ts',
      'export class Widget<T> extends $.Unit<T> {\n  items: string[] = []\n}\n'
    );
    write(
      'src/widget/widget.bg.ts',
      'export class Widget extends $.Widget<bg> {\n  boot() {\n    return this.items\n  }\n}\n'
    );
    write(
      'src/widget/widget.pp.tsx',
      'export class Widget extends $.Widget<pp> {\n  view() {\n    return null\n  }\n}\n'
    );
    write(
      'src/gauge/gauge.bs.ps.ts',
      'export class Gauge<T> extends $.Unit<T> {\n  value = 0\n}\n'
    );
    write('src/gauge/gauge.bs.ts', 'export class Gauge extends bsPs.Gauge<bs> {\n  a = 1\n}\n');
    write('src/gauge/gauge.ps.ts', 'export class Gauge extends bsPs.Gauge<ps> {\n  b = 2\n}\n');
    if (config !== undefined) {
      fs.writeFileSync(path.join(root, 'codegraph.json'), JSON.stringify(config, null, 2));
    }
    clearProjectConfigCache();
    clearPluginConfigCache();
    clearLayerChainCache();
    return root;
  }

  /** `extends` edges as `fromFile -> toFile` pairs. */
  function extendsPairs(cg: CodeGraph): string[] {
    const pairs: string[] = [];
    for (const node of cg.getNodesByKind('class')) {
      for (const edge of cg.getOutgoingEdges(node.id)) {
        if (edge.kind !== 'extends') continue;
        const target = cg.getNode(edge.target);
        if (target) pairs.push(`${node.filePath} -> ${target.filePath}`);
      }
    }
    return pairs.sort();
  }

  it('creates the specialization chain when the plugin is configured', async () => {
    tmpDir = scaffold({
      plugins: { [LAYER_CHAIN_PLUGIN_NAME]: { layers: ['bg', 'pp', 'bs', 'ps'] } },
    });
    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    const pairs = extendsPairs(cg);
    expect(pairs).toContain('src/widget/widget.bg.ts -> src/widget/widget.ts');
    expect(pairs).toContain('src/widget/widget.pp.tsx -> src/widget/widget.ts');
    expect(pairs).toContain('src/gauge/gauge.bs.ts -> src/gauge/gauge.bs.ps.ts');
    expect(pairs).toContain('src/gauge/gauge.ps.ts -> src/gauge/gauge.bs.ps.ts');

    // The cross-stem framework base is deliberately NOT chained.
    expect(pairs.some((p) => p.endsWith('-> src/unit/unit.ts'))).toBe(false);
    // And no specialization is ever wired to a sibling specialization.
    expect(pairs).not.toContain('src/widget/widget.pp.tsx -> src/widget/widget.bg.ts');

    // The chain is reachable as a type hierarchy, which is the point of it.
    const base = cg.getNodesByName('Widget').find((n) => n.filePath === 'src/widget/widget.ts');
    expect(base).toBeDefined();
    const incoming = cg
      .getIncomingEdges(base!.id)
      .filter((e) => e.kind === 'extends')
      .map((e) => cg.getNode(e.source)?.filePath)
      .sort();
    expect(incoming).toEqual(['src/widget/widget.bg.ts', 'src/widget/widget.pp.tsx']);

    cg.close();
  });

  it('creates no such edges for the identical project without the config', async () => {
    tmpDir = scaffold();
    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    expect(extendsPairs(cg)).toEqual([]);
    expect(cg.getDetectedFrameworks()).not.toContain(LAYER_CHAIN_PLUGIN_NAME);

    cg.close();
  });

  it('creates no such edges when the config carries no layers vocabulary', async () => {
    tmpDir = scaffold({ plugins: { [LAYER_CHAIN_PLUGIN_NAME]: true } });
    const cg = CodeGraph.initSync(tmpDir);
    await cg.indexAll();

    expect(extendsPairs(cg)).toEqual([]);

    cg.close();
  });
});
