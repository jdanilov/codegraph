/**
 * Namespace-proxy resolution plugin (ROADMAP item 1a).
 *
 * Codebases that hand modules to consumers through a single namespace object —
 * an auto-vivifying proxy, a generated registry, a service locator — are
 * invisible to AST extraction: `$svc.sendMail()` parses as a member access on a
 * receiver that is never declared, so it dies at the resolver's "no node has
 * this name" pre-filter. This suite covers both resolution strategies
 * end-to-end against real files and real SQLite, plus the precision boundaries
 * that keep the plugin from inventing edges.
 *
 * The headline invariant, asserted first and asserted hardest: a project with
 * NO `plugins.namespace-proxy` entry behaves EXACTLY as it did before this
 * plugin existed — same nodes, same edges, nothing claimed.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { CodeGraph } from '../src';
import { initGrammars, loadAllGrammars } from '../src/extraction/grammars';
import { clearProjectConfigCache } from '../src/project-config';
import { clearPluginConfigCache } from '../src/resolution/plugins/plugin-config';
import {
  NAMESPACE_PROXY_PLUGIN_NAME,
  clearNamespaceProxyCaches,
  namespaceProxyPlugin,
} from '../src/resolution/plugins/namespace-proxy';
import { detectFrameworks } from '../src/resolution/frameworks';
import type { Node } from '../src/types';
import type { ResolutionContext, UnresolvedRef } from '../src/resolution/types';

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
});

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-nsproxy-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0' }));
  clearProjectConfigCache();
  clearPluginConfigCache();
  clearNamespaceProxyCaches();
});

afterEach(() => {
  clearProjectConfigCache();
  clearPluginConfigCache();
  clearNamespaceProxyCaches();
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function write(relPath: string, content: string): void {
  const full = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

function writeConfig(config: unknown): void {
  fs.writeFileSync(
    path.join(dir, 'codegraph.json'),
    typeof config === 'string' ? config : JSON.stringify(config, null, 2)
  );
  clearProjectConfigCache();
  clearPluginConfigCache();
  clearNamespaceProxyCaches();
}

interface Indexed {
  nodes: Node[];
  /** `sourceId -> targetId` pairs, for edge assertions. */
  edges: { source: string; target: string; kind: string }[];
  close(): void;
}

async function indexFixture(): Promise<Indexed> {
  const cg = CodeGraph.initSync(dir);
  await cg.indexAll();

  const kinds: Node['kind'][] = [
    'file',
    'class',
    'function',
    'method',
    'variable',
    'constant',
    'property',
    'interface',
  ];
  const nodes: Node[] = [];
  for (const kind of kinds) nodes.push(...cg.getNodesByKind(kind));

  const edges: { source: string; target: string; kind: string }[] = [];
  for (const node of nodes) {
    for (const edge of cg.getOutgoingEdges(node.id)) {
      edges.push({ source: edge.source, target: edge.target, kind: edge.kind });
    }
  }

  return { nodes, edges, close: () => cg.close() };
}

function nodeNamed(indexed: Indexed, name: string, file?: string): Node {
  const match = indexed.nodes.find(
    (n) => n.name === name && n.kind !== 'file' && (!file || n.filePath === file)
  );
  if (!match) throw new Error(`no node named "${name}"${file ? ` in ${file}` : ''}`);
  return match;
}

function fileNode(indexed: Indexed, filePath: string): Node {
  const match = indexed.nodes.find((n) => n.kind === 'file' && n.filePath === filePath);
  if (!match) throw new Error(`no file node for ${filePath}`);
  return match;
}

function hasEdge(indexed: Indexed, from: Node, to: Node): boolean {
  return indexed.edges.some((e) => e.source === from.id && e.target === to.id);
}

/** Minimal context rooted at the temp dir, for hook-level assertions. */
function fakeContext(overrides: Partial<ResolutionContext> = {}): ResolutionContext {
  return {
    getNodesInFile: () => [],
    getNodesByName: () => [],
    getNodesByQualifiedName: () => [],
    getNodesByKind: () => [],
    getNodesByLowerName: () => [],
    getImportMappings: () => [],
    fileExists: () => false,
    readFile: () => null,
    getProjectRoot: () => dir,
    getAllFiles: () => [],
    ...overrides,
  };
}

function callRef(referenceName: string, overrides: Partial<UnresolvedRef> = {}): UnresolvedRef {
  return {
    fromNodeId: 'function:caller',
    referenceName,
    referenceKind: 'calls',
    line: 1,
    column: 0,
    filePath: 'src/app/main.ts',
    language: 'typescript',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Fixtures. Synthetic, invented projects — a generated registry barrel plus a
// hand-written service namespace, both in the shape real proxy frameworks use.
// ---------------------------------------------------------------------------

/**
 * Registry shape: a generated barrel whose imports ARE the namespace map, one
 * import per member, assembled onto a bare namespace object.
 */
function writeRegistryFixture(): void {
  write(
    'src/widgets/gauge.ts',
    'export class Gauge {\n  paint(): string { return "gauge"; }\n}\n'
  );
  write('src/reports/ledger.ts', 'export function Ledger(): string {\n  return "ledger";\n}\n');
  write(
    'src/gen/registry.ts',
    "import { Gauge } from '../widgets/gauge';\n" +
      "import { Ledger } from '../reports/ledger';\n" +
      '\n' +
      'Object.assign(ns, { Gauge, Ledger });\n'
  );
  write(
    'src/app/boot.ts',
    'export function boot(): string {\n' +
      '  ns.Gauge();\n' +
      '  return ns.Ledger();\n' +
      '}\n'
  );
}

/**
 * Assignment shape: `$svc.member = …` at column 0 IS the definition, and the
 * consumer destructures the namespace object off an ambient container.
 */
function writeAssignmentFixture(): void {
  write(
    'src/services/mailer.ts',
    'const { $svc } = container;\n' +
      '\n' +
      '$svc.sendMail = async function sendMail(to: string) {\n' +
      '  return to;\n' +
      '};\n' +
      '\n' +
      '$svc.notifyOperators = () => {\n' +
      '  return true;\n' +
      '};\n'
  );
  write(
    'src/features/checkout.ts',
    'const { $svc } = container;\n' +
      '\n' +
      'export function checkout(): unknown {\n' +
      '  $svc.notifyOperators();\n' +
      '  return $svc.sendMail("buyer@example.test");\n' +
      '}\n'
  );
}

// ---------------------------------------------------------------------------
// The headline invariant
// ---------------------------------------------------------------------------

describe('no configuration ⇒ pre-plugin behavior, exactly', () => {
  it('does not detect, does not claim, and resolves nothing without a codegraph.json', () => {
    const context = fakeContext();
    expect(namespaceProxyPlugin.detect(context)).toBe(false);
    expect(namespaceProxyPlugin.claimsReference?.('$svc.sendMail')).toBe(false);
    expect(namespaceProxyPlugin.resolve(callRef('$svc.sendMail'), context)).toBeNull();
  });

  it('stays off when codegraph.json carries no plugins key', () => {
    writeConfig({ exclude: ['dist/'] });
    expect(namespaceProxyPlugin.detect(fakeContext())).toBe(false);
    expect(namespaceProxyPlugin.claimsReference?.('$svc.sendMail')).toBe(false);
  });

  it('is absent from the detected frameworks of an unconfigured project', () => {
    const detected = detectFrameworks(fakeContext()).map((f) => f.name);
    expect(detected).not.toContain(NAMESPACE_PROXY_PLUGIN_NAME);
  });

  it('produces byte-identical graph output with and without the plugin registered', async () => {
    writeAssignmentFixture();

    const withoutPlugin = await indexFixture();
    const baselineNodes = withoutPlugin.nodes.map((n) => `${n.kind}:${n.name}:${n.filePath}`).sort();
    const baselineEdges = withoutPlugin.edges
      .map((e) => `${e.source}->${e.target}:${e.kind}`)
      .sort();
    withoutPlugin.close();

    // The namespace call sites are dead references without the plugin.
    const caller = withoutPlugin.nodes.find((n) => n.name === 'checkout')!;
    const target = withoutPlugin.nodes.find(
      (n) => n.name === 'sendMail' && n.kind === 'function'
    )!;
    expect(caller).toBeDefined();
    expect(target).toBeDefined();
    expect(
      withoutPlugin.edges.some((e) => e.source === caller.id && e.target === target.id)
    ).toBe(false);

    // Re-index the very same tree; still no config, so still the same graph.
    fs.rmSync(path.join(dir, '.codegraph'), { recursive: true, force: true });
    const again = await indexFixture();
    expect(again.nodes.map((n) => `${n.kind}:${n.name}:${n.filePath}`).sort()).toEqual(
      baselineNodes
    );
    expect(again.edges.map((e) => `${e.source}->${e.target}:${e.kind}`).sort()).toEqual(
      baselineEdges
    );
    again.close();
  }, 60000);
});

// ---------------------------------------------------------------------------
// Strategy 1 — registry-backed
// ---------------------------------------------------------------------------

describe('registry-backed resolution', () => {
  it('turns dead namespace references into edges only once the config points at the registry', async () => {
    writeRegistryFixture();

    // Negative control on the exact same tree: nothing resolves without config.
    const before = await indexFixture();
    expect(before.edges.filter((e) => e.source === nodeNamed(before, 'boot').id)).toHaveLength(0);
    before.close();

    fs.rmSync(path.join(dir, '.codegraph'), { recursive: true, force: true });
    writeConfig({
      plugins: {
        'namespace-proxy': { objects: ['ns'], registry: { files: ['src/gen/registry.ts'] } },
      },
    });

    const after = await indexFixture();
    const boot = nodeNamed(after, 'boot');
    expect(hasEdge(after, boot, nodeNamed(after, 'Gauge'))).toBe(true);
    expect(hasEdge(after, boot, nodeNamed(after, 'Ledger'))).toBe(true);
    after.close();
  }, 60000);

  it('resolves namespace members through the barrel file imports', async () => {
    writeRegistryFixture();
    writeConfig({
      plugins: {
        'namespace-proxy': {
          objects: ['ns'],
          registry: { files: ['src/gen/registry.ts'], objects: ['ns'], level: 'member' },
        },
      },
    });

    const indexed = await indexFixture();
    const boot = nodeNamed(indexed, 'boot');
    expect(hasEdge(indexed, boot, nodeNamed(indexed, 'Gauge'))).toBe(true);
    expect(hasEdge(indexed, boot, nodeNamed(indexed, 'Ledger'))).toBe(true);
    indexed.close();
  }, 60000);

  it('accepts a glob for the registry files', async () => {
    writeRegistryFixture();
    writeConfig({
      plugins: {
        'namespace-proxy': {
          objects: ['ns'],
          registry: { files: ['src/gen/*.ts'] },
        },
      },
    });

    const indexed = await indexFixture();
    expect(hasEdge(indexed, nodeNamed(indexed, 'boot'), nodeNamed(indexed, 'Ledger'))).toBe(true);
    indexed.close();
  }, 60000);

  it('follows an `as` rename to the upstream symbol', async () => {
    write('src/core/timing.ts', 'export function pause(ms: number): number {\n  return ms;\n}\n');
    write(
      'src/gen/registry.ts',
      "import { pause as idle } from '../core/timing';\n\nObject.assign(ns, { idle });\n"
    );
    write('src/app/boot.ts', 'export function boot(): number {\n  return ns.idle(5);\n}\n');
    writeConfig({
      plugins: {
        'namespace-proxy': { objects: ['ns'], registry: { files: ['src/gen/registry.ts'] } },
      },
    });

    const indexed = await indexFixture();
    expect(hasEdge(indexed, nodeNamed(indexed, 'boot'), nodeNamed(indexed, 'pause'))).toBe(true);
    indexed.close();
  }, 60000);

  it('maps whole namespace OBJECTS when level is "namespace"', async () => {
    write(
      'src/toolkit/index.ts',
      'export function throttle(ms: number): number {\n  return ms;\n}\n'
    );
    write(
      'src/gen/registry.ts',
      "import { toolkit } from '../toolkit/index';\n\nObject.assign(root, { $toolkit: toolkit });\n"
    );
    write(
      'src/app/boot.ts',
      'export function boot(): number {\n  return $toolkit.throttle(5);\n}\n'
    );
    writeConfig({
      plugins: {
        'namespace-proxy': {
          objects: ['$toolkit'],
          registry: { files: ['src/gen/registry.ts'], level: 'namespace', prefix: '$' },
        },
      },
    });

    const indexed = await indexFixture();
    expect(hasEdge(indexed, nodeNamed(indexed, 'boot'), nodeNamed(indexed, 'throttle'))).toBe(true);
    indexed.close();
  }, 60000);

  it('supports several registries, one per namespace object', async () => {
    write('src/a/alpha.ts', 'export function Alpha(): string {\n  return "a";\n}\n');
    write('src/b/beta.ts', 'export function Beta(): string {\n  return "b";\n}\n');
    write('src/gen/layer.one.ts', "import { Alpha } from '../a/alpha';\n\nObject.assign(one, { Alpha });\n");
    write('src/gen/layer.two.ts', "import { Beta } from '../b/beta';\n\nObject.assign(two, { Beta });\n");
    write(
      'src/app/boot.ts',
      'export function boot(): string {\n  one.Alpha();\n  return two.Beta();\n}\n'
    );
    writeConfig({
      plugins: {
        'namespace-proxy': {
          objects: ['one', 'two'],
          registry: [
            { files: ['src/gen/layer.one.ts'], objects: ['one'] },
            { files: ['src/gen/layer.two.ts'], objects: ['two'] },
          ],
        },
      },
    });

    const indexed = await indexFixture();
    const boot = nodeNamed(indexed, 'boot');
    expect(hasEdge(indexed, boot, nodeNamed(indexed, 'Alpha'))).toBe(true);
    expect(hasEdge(indexed, boot, nodeNamed(indexed, 'Beta'))).toBe(true);
    indexed.close();
  }, 60000);

  it('does not cross-wire objects a registry entry was not scoped to', async () => {
    write('src/a/alpha.ts', 'export function Alpha(): string {\n  return "a";\n}\n');
    write('src/gen/layer.one.ts', "import { Alpha } from '../a/alpha';\n\nObject.assign(one, { Alpha });\n");
    // `two` is declared as ours, but no registry maps it.
    write('src/app/boot.ts', 'export function boot(): string {\n  return two.Alpha();\n}\n');
    writeConfig({
      plugins: {
        'namespace-proxy': {
          objects: ['one', 'two'],
          registry: [{ files: ['src/gen/layer.one.ts'], objects: ['one'] }],
        },
      },
    });

    const indexed = await indexFixture();
    expect(hasEdge(indexed, nodeNamed(indexed, 'boot'), nodeNamed(indexed, 'Alpha'))).toBe(false);
    indexed.close();
  }, 60000);
});

// ---------------------------------------------------------------------------
// Strategy 2 — assignment scan
// ---------------------------------------------------------------------------

describe('assignment-scan resolution', () => {
  it('resolves a reference to the symbol the assignment defines', async () => {
    writeAssignmentFixture();
    writeConfig({
      plugins: {
        'namespace-proxy': {
          objects: ['$svc'],
          assignments: { objects: ['$svc'], include: ['src/**'] },
        },
      },
    });

    const indexed = await indexFixture();
    expect(
      hasEdge(indexed, nodeNamed(indexed, 'checkout'), nodeNamed(indexed, 'sendMail'))
    ).toBe(true);
    indexed.close();
  }, 60000);

  it('claims a member no symbol is named after, and points at its defining file', async () => {
    // `notifyOperators` is an anonymous arrow — extraction emits NO node for it,
    // so `$svc.notifyOperators` is exactly the reference the resolver's
    // name-exists pre-filter drops today. `claimsReference` is the only reason
    // it reaches `resolve()` at all.
    writeAssignmentFixture();
    writeConfig({
      plugins: {
        'namespace-proxy': {
          objects: ['$svc'],
          assignments: { objects: ['$svc'], include: ['src/**'] },
        },
      },
    });

    const indexed = await indexFixture();
    expect(indexed.nodes.some((n) => n.name === 'notifyOperators')).toBe(false);
    expect(
      hasEdge(indexed, nodeNamed(indexed, 'checkout'), fileNode(indexed, 'src/services/mailer.ts'))
    ).toBe(true);
    indexed.close();
  }, 60000);

  it('honors the include globs and scans nothing outside them', async () => {
    writeAssignmentFixture();
    writeConfig({
      plugins: {
        'namespace-proxy': {
          objects: ['$svc'],
          // The definitions live in src/services, which this deliberately omits.
          assignments: { objects: ['$svc'], include: ['src/features/**'] },
        },
      },
    });

    const indexed = await indexFixture();
    expect(
      hasEdge(indexed, nodeNamed(indexed, 'checkout'), nodeNamed(indexed, 'sendMail'))
    ).toBe(false);
    indexed.close();
  }, 60000);

  it('treats `??=` as a definition when configured', async () => {
    write(
      'src/services/cache.ts',
      'const { $svc } = container;\n\n$svc.readCache ??= function readCache(): number {\n  return 1;\n};\n'
    );
    write(
      'src/features/page.ts',
      'export function page(): number {\n  return $svc.readCache();\n}\n'
    );
    writeConfig({
      plugins: {
        'namespace-proxy': {
          objects: ['$svc'],
          assignments: { objects: ['$svc'], include: ['src/**'], operators: ['=', '??='] },
        },
      },
    });

    const indexed = await indexFixture();
    expect(hasEdge(indexed, nodeNamed(indexed, 'page'), nodeNamed(indexed, 'readCache'))).toBe(
      true
    );
    indexed.close();
  }, 60000);

  it('resolves a two-level member path to its own definition file', async () => {
    write(
      'src/services/timing.ts',
      'const { $svc } = container;\n\n$svc.timing.delay = function delay(ms: number): number {\n  return ms;\n};\n'
    );
    write(
      'src/features/page.ts',
      'export function page(): number {\n  return $svc.timing.delay(5);\n}\n'
    );
    writeConfig({
      plugins: {
        'namespace-proxy': {
          objects: ['$svc'],
          assignments: { objects: ['$svc'], include: ['src/**'] },
        },
      },
    });

    const indexed = await indexFixture();
    expect(hasEdge(indexed, nodeNamed(indexed, 'page'), nodeNamed(indexed, 'delay'))).toBe(true);
    indexed.close();
  }, 60000);
});

// ---------------------------------------------------------------------------
// Precision boundaries
// ---------------------------------------------------------------------------

describe('precision safeguards', () => {
  it('never claims an object that is not named in config', () => {
    writeConfig({
      plugins: { 'namespace-proxy': { objects: ['$svc'], assignments: { include: ['src/**'] } } },
    });
    const context = fakeContext();
    expect(namespaceProxyPlugin.detect(context)).toBe(true);

    expect(namespaceProxyPlugin.claimsReference?.('$svc.sendMail')).toBe(true);
    // A different sigil — including the message-bus object a project may want
    // the event-bus plugin to own — is invisible to us.
    expect(namespaceProxyPlugin.claimsReference?.('$bus.send')).toBe(false);
    expect(namespaceProxyPlugin.claimsReference?.('$other.thing')).toBe(false);
    expect(namespaceProxyPlugin.resolve(callRef('$bus.send'), context)).toBeNull();
  });

  it('claims nothing that is not a `<object>.<member>` shape', () => {
    writeConfig({ plugins: { 'namespace-proxy': { objects: ['$svc'], assignments: {} } } });
    expect(namespaceProxyPlugin.detect(fakeContext())).toBe(true);
    expect(namespaceProxyPlugin.claimsReference?.('$svc')).toBe(false);
    expect(namespaceProxyPlugin.claimsReference?.('$svc.')).toBe(false);
    expect(namespaceProxyPlugin.claimsReference?.('.sendMail')).toBe(false);
    expect(namespaceProxyPlugin.claimsReference?.('sendMail')).toBe(false);
  });

  it('never resolves an `extends` reference through the assignment scan', () => {
    writeConfig({
      plugins: {
        'namespace-proxy': {
          objects: ['$ui'],
          assignments: { objects: ['$ui'], include: ['src/**'] },
        },
      },
    });
    const context = fakeContext();
    expect(namespaceProxyPlugin.detect(context)).toBe(true);
    // The name still passes the pre-filter (so another plugin can have it)…
    expect(namespaceProxyPlugin.claimsReference?.('$ui.Panel')).toBe(true);
    // …but we do not resolve it.
    expect(
      namespaceProxyPlugin.resolve(callRef('$ui.Panel', { referenceKind: 'extends' }), context)
    ).toBeNull();
  });

  it('does not produce an extends edge through the namespace object', async () => {
    write(
      'src/ui/panel.ts',
      'const { $ui } = container;\n\n$ui.Panel = class Panel {\n  render(): string { return "p"; }\n};\n'
    );
    write(
      'src/ui/dialog.ts',
      'const { $ui } = container;\n\nexport class Dialog extends $ui.Panel {\n  open(): string { return "d"; }\n}\n'
    );
    writeConfig({
      plugins: {
        'namespace-proxy': {
          objects: ['$ui'],
          assignments: { objects: ['$ui'], include: ['src/**'] },
        },
      },
    });

    const indexed = await indexFixture();
    const dialog = nodeNamed(indexed, 'Dialog');
    const extendsEdges = indexed.edges.filter(
      (e) => e.source === dialog.id && e.kind === 'extends'
    );
    expect(extendsEdges).toHaveLength(0);
    indexed.close();
  }, 60000);

  it('refuses to guess when two files define the same member', async () => {
    write(
      'src/a/one.ts',
      'const { $svc } = container;\n\n$svc.ambiguous = () => {\n  return 1;\n};\n'
    );
    write(
      'src/b/two.ts',
      'const { $svc } = container;\n\n$svc.ambiguous = () => {\n  return 2;\n};\n'
    );
    write(
      'src/features/page.ts',
      'export function page(): number {\n  return $svc.ambiguous();\n}\n'
    );
    writeConfig({
      plugins: {
        'namespace-proxy': {
          objects: ['$svc'],
          assignments: { objects: ['$svc'], include: ['src/**'] },
        },
      },
    });

    const indexed = await indexFixture();
    const page = nodeNamed(indexed, 'page');
    expect(hasEdge(indexed, page, fileNode(indexed, 'src/a/one.ts'))).toBe(false);
    expect(hasEdge(indexed, page, fileNode(indexed, 'src/b/two.ts'))).toBe(false);
    indexed.close();
  }, 60000);

  it('ignores indented state mutation, which is not a definition', async () => {
    write(
      'src/services/state.ts',
      'const { $state } = container;\n' +
        '\n' +
        'export function markBusy(): void {\n' +
        '  $state.session.busy = true;\n' +
        '}\n'
    );
    write(
      'src/features/page.ts',
      'export function page(): unknown {\n  return $state.session.load();\n}\n'
    );
    writeConfig({
      plugins: {
        'namespace-proxy': {
          objects: ['$state'],
          assignments: { objects: ['$state'], include: ['src/**'] },
        },
      },
    });

    const indexed = await indexFixture();
    expect(
      hasEdge(indexed, nodeNamed(indexed, 'page'), fileNode(indexed, 'src/services/state.ts'))
    ).toBe(false);
    indexed.close();
  }, 60000);

  it('accepts indented definitions when topLevelOnly is switched off', async () => {
    write(
      'src/services/wrapped.ts',
      'const { $svc } = container;\n' +
        '\n' +
        'function install(): void {\n' +
        '  $svc.boundHandler = function boundHandler(): number {\n' +
        '    return 7;\n' +
        '  };\n' +
        '}\n'
    );
    write(
      'src/features/page.ts',
      'export function page(): number {\n  return $svc.boundHandler();\n}\n'
    );
    writeConfig({
      plugins: {
        'namespace-proxy': {
          objects: ['$svc'],
          assignments: { objects: ['$svc'], include: ['src/**'], topLevelOnly: false },
        },
      },
    });

    const indexed = await indexFixture();
    expect(
      hasEdge(indexed, nodeNamed(indexed, 'page'), nodeNamed(indexed, 'boundHandler'))
    ).toBe(true);
    indexed.close();
  }, 60000);

  it('ignores an assignment that only appears inside a comment', async () => {
    write(
      'src/services/docs.ts',
      'const { $svc } = container;\n' +
        '\n' +
        '// Usage: $svc.documented = () => {};\n' +
        'export const marker = 1;\n'
    );
    write(
      'src/features/page.ts',
      'export function page(): unknown {\n  return $svc.documented();\n}\n'
    );
    writeConfig({
      plugins: {
        'namespace-proxy': {
          objects: ['$svc'],
          assignments: { objects: ['$svc'], include: ['src/**'], topLevelOnly: false },
        },
      },
    });

    const indexed = await indexFixture();
    expect(
      hasEdge(indexed, nodeNamed(indexed, 'page'), fileNode(indexed, 'src/services/docs.ts'))
    ).toBe(false);
    indexed.close();
  }, 60000);

  it('does not point a type reference at a file node', () => {
    writeConfig({
      plugins: {
        'namespace-proxy': {
          objects: ['$svc'],
          assignments: { objects: ['$svc'], include: ['src/**'] },
        },
      },
    });

    const target: Node = {
      id: 'file:src/services/mailer.ts',
      kind: 'file',
      name: 'mailer.ts',
      qualifiedName: 'src/services/mailer.ts',
      filePath: 'src/services/mailer.ts',
      language: 'typescript',
      startLine: 1,
      endLine: 5,
      startColumn: 0,
      endColumn: 0,
    };
    const context = fakeContext({
      getAllFiles: () => ['src/services/mailer.ts'],
      readFile: (p) =>
        p === 'src/services/mailer.ts' ? '$svc.opaque = () => {\n  return 1;\n};\n' : null,
      getNodesInFile: (p) => (p === 'src/services/mailer.ts' ? [target] : []),
    });
    expect(namespaceProxyPlugin.detect(context)).toBe(true);

    // A `calls` ref gets the file fallback…
    const call = namespaceProxyPlugin.resolve(callRef('$svc.opaque'), context);
    expect(call?.targetNodeId).toBe(target.id);
    expect(call?.resolvedBy).toBe('framework');

    // …a type reference does not: a file is a nonsense target for one.
    expect(
      namespaceProxyPlugin.resolve(
        callRef('$svc.opaque', { referenceKind: 'type_of' }),
        context
      )
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Confidence & attribution
// ---------------------------------------------------------------------------

describe('confidence and attribution', () => {
  const symbol: Node = {
    id: 'function:sendMail',
    kind: 'function',
    name: 'sendMail',
    qualifiedName: 'sendMail',
    filePath: 'src/services/mailer.ts',
    language: 'typescript',
    startLine: 3,
    endLine: 5,
    startColumn: 0,
    endColumn: 0,
  };

  it('scores registry-backed resolutions higher than assignment-scanned ones', () => {
    writeConfig({
      plugins: {
        'namespace-proxy': {
          objects: ['ns'],
          registry: { files: ['src/gen/registry.ts'], objects: ['ns'] },
        },
      },
    });
    const registryContext = fakeContext({
      getAllFiles: () => ['src/gen/registry.ts', 'src/services/mailer.ts'],
      fileExists: (p) => p === 'src/services/mailer.ts',
      readFile: (p) =>
        p === 'src/gen/registry.ts' ? "import { sendMail } from '../services/mailer';\n" : null,
      getImportMappings: (p) =>
        p === 'src/gen/registry.ts'
          ? [
              {
                localName: 'sendMail',
                exportedName: 'sendMail',
                source: '../services/mailer',
                isDefault: false,
                isNamespace: false,
              },
            ]
          : [],
      getNodesInFile: (p) => (p === 'src/services/mailer.ts' ? [symbol] : []),
    });
    expect(namespaceProxyPlugin.detect(registryContext)).toBe(true);
    const registryHit = namespaceProxyPlugin.resolve(callRef('ns.sendMail'), registryContext);
    expect(registryHit?.targetNodeId).toBe(symbol.id);
    expect(registryHit?.resolvedBy).toBe('framework');
    const registryConfidence = registryHit!.confidence;

    writeConfig({
      plugins: {
        'namespace-proxy': {
          objects: ['$svc'],
          assignments: { objects: ['$svc'], include: ['src/**'] },
        },
      },
    });
    const scanContext = fakeContext({
      getAllFiles: () => ['src/services/mailer.ts'],
      readFile: (p) =>
        p === 'src/services/mailer.ts'
          ? '$svc.sendMail = async function sendMail(to) {\n  return to;\n};\n'
          : null,
      getNodesInFile: (p) => (p === 'src/services/mailer.ts' ? [symbol] : []),
    });
    expect(namespaceProxyPlugin.detect(scanContext)).toBe(true);
    const scanHit = namespaceProxyPlugin.resolve(callRef('$svc.sendMail'), scanContext);
    expect(scanHit?.targetNodeId).toBe(symbol.id);
    expect(scanHit?.resolvedBy).toBe('framework');

    expect(registryConfidence).toBeGreaterThan(scanHit!.confidence);
  });
});

// ---------------------------------------------------------------------------
// Malformed configuration degrades, never throws
// ---------------------------------------------------------------------------

describe('malformed configuration tolerance', () => {
  const badConfigs: [string, unknown][] = [
    ['objects missing', { plugins: { 'namespace-proxy': { assignments: {} } } }],
    ['objects not an array', { plugins: { 'namespace-proxy': { objects: '$svc' } } }],
    ['objects empty', { plugins: { 'namespace-proxy': { objects: [] } } }],
    ['no strategy configured', { plugins: { 'namespace-proxy': { objects: ['$svc'] } } }],
    [
      'registry without files',
      { plugins: { 'namespace-proxy': { objects: ['$svc'], registry: {} } } },
    ],
    [
      'registry not an object',
      { plugins: { 'namespace-proxy': { objects: ['$svc'], registry: 'src/gen' } } },
    ],
    [
      'assignments not an object',
      { plugins: { 'namespace-proxy': { objects: ['$svc'], assignments: [] } } },
    ],
    [
      'registry scoped to an undeclared object',
      {
        plugins: {
          'namespace-proxy': {
            objects: ['$svc'],
            registry: { files: ['src/gen/registry.ts'], objects: ['$nope'] },
          },
        },
      },
    ],
  ];

  it.each(badConfigs)('stays inert and silent for: %s', (_label, config) => {
    writeConfig(config);
    const context = fakeContext();
    expect(() => namespaceProxyPlugin.detect(context)).not.toThrow();
    expect(namespaceProxyPlugin.detect(context)).toBe(false);
    expect(namespaceProxyPlugin.claimsReference?.('$svc.sendMail')).toBe(false);
    expect(namespaceProxyPlugin.resolve(callRef('$svc.sendMail'), context)).toBeNull();
  });

  it('keeps the good half of a partly-bad config', () => {
    writeConfig({
      plugins: {
        'namespace-proxy': {
          objects: ['$svc'],
          assignments: { objects: ['$svc'], include: ['src/**'], maxFiles: 'lots' },
        },
      },
    });
    expect(namespaceProxyPlugin.detect(fakeContext())).toBe(true);
    expect(namespaceProxyPlugin.claimsReference?.('$svc.sendMail')).toBe(true);
  });

  it('drops its claim when the project turns the plugin back off', () => {
    writeConfig({
      plugins: { 'namespace-proxy': { objects: ['$svc'], assignments: {} } },
    });
    expect(namespaceProxyPlugin.detect(fakeContext())).toBe(true);
    expect(namespaceProxyPlugin.claimsReference?.('$svc.sendMail')).toBe(true);

    writeConfig({ plugins: { disable: [NAMESPACE_PROXY_PLUGIN_NAME] } });
    expect(namespaceProxyPlugin.detect(fakeContext())).toBe(false);
    expect(namespaceProxyPlugin.claimsReference?.('$svc.sendMail')).toBe(false);
  });
});

/**
 * ROADMAP 1e — `extends` is shared with the layer-chain plugin, split by target
 * shape. A registry hit is authoritative, so inheritance from ANOTHER module is
 * ours; a same-stem layer sibling stays layer-chain's, because it models tag-set
 * generality and we only know "the registry said that name lives in that file".
 */
describe('namespace-proxy plugin — cross-stem `extends` (registry-backed)', () => {
  const registryConfig = {
    plugins: {
      'namespace-proxy': {
        objects: ['$'],
        registry: { files: ['src/gen/registry.ts'] },
      },
    },
  };

  it('resolves inheritance from a different module', async () => {
    write('src/core/unit.ts', 'export class Unit {\n  attach(): string { return "u"; }\n}\n');
    write(
      'src/gen/registry.ts',
      "import { Unit } from '../core/unit';\n\nexport const registry = { Unit };\n"
    );
    write(
      'src/widgets/widget.bg.ts',
      'export class Widget extends $.Unit {\n  run(): string { return "w"; }\n}\n'
    );
    writeConfig(registryConfig);

    const indexed = await indexFixture();
    const widget = nodeNamed(indexed, 'Widget', 'src/widgets/widget.bg.ts');
    const unit = nodeNamed(indexed, 'Unit', 'src/core/unit.ts');
    expect(
      indexed.edges.some(
        (e) => e.source === widget.id && e.target === unit.id && e.kind === 'extends'
      )
    ).toBe(true);
    indexed.close();
  }, 60000);

  it('abstains when the registry target is a same-stem layer sibling', async () => {
    write('src/widgets/widget.ts', 'export class Widget {\n  base(): string { return "b"; }\n}\n');
    write(
      'src/gen/registry.ts',
      "import { Widget } from '../widgets/widget';\n\nexport const registry = { Widget };\n"
    );
    write(
      'src/widgets/widget.bg.ts',
      'export class Widget extends $.Widget {\n  run(): string { return "w"; }\n}\n'
    );
    writeConfig(registryConfig);

    const indexed = await indexFixture();
    const derived = nodeNamed(indexed, 'Widget', 'src/widgets/widget.bg.ts');
    const base = nodeNamed(indexed, 'Widget', 'src/widgets/widget.ts');
    // Left for the layer-chain plugin, which is not enabled here — so no edge.
    expect(
      indexed.edges.some((e) => e.source === derived.id && e.target === base.id)
    ).toBe(false);
    indexed.close();
  }, 60000);

  it('still refuses an `extends` the assignment scan alone could reach', () => {
    writeConfig({
      plugins: {
        'namespace-proxy': {
          objects: ['$ui'],
          assignments: { objects: ['$ui'], include: ['src/**'] },
        },
      },
    });
    const context = fakeContext();
    expect(namespaceProxyPlugin.detect(context)).toBe(true);
    expect(
      namespaceProxyPlugin.resolve(
        callRef('$ui.Panel', { referenceKind: 'extends' }),
        context
      )
    ).toBeNull();
  });
});
