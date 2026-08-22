/**
 * Object-literal member extraction plugin — ROADMAP item 1i.
 *
 * The gap it closes: `$ns.controller = { async init () {…} }` is a statement-level
 * `assignment_expression`, so core's object-of-functions walker (which hangs off
 * the variable-DECLARATION path) never sees it. The file indexes to a file node
 * and nothing else, in JavaScript AND in TypeScript alike.
 *
 * Four layers under test:
 *   1. Config: the `objects` vocabulary plus every precision knob, and the
 *      warn-and-skip behavior each malformed value must get.
 *   2. Shape discipline: what the plugin refuses to touch. A data-only object, a
 *      computed target, a call-wrapped value and a non-configured namespace all
 *      have to emit NOTHING — a wrong node is worse than a missing one, because
 *      every edge later resolved onto it inherits the error.
 *   3. End-to-end: a real index over a real (synthetic) project, so the nodes are
 *      the ones an agent would actually be handed — with stable ids across a
 *      re-index, since a churning id means a churning edge on every sync.
 *   4. Composition: the emitted members are what `namespace-proxy` then aims a
 *      `$ns.controller.init` reference at.
 *
 * The headline invariant, asserted explicitly at the bottom: a project with no
 * `object-literal-members` config indexes EXACTLY as it did before the plugin
 * existed.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { CodeGraph } from '../src';
import { clearProjectConfigCache } from '../src/project-config';
import { clearPluginConfigCache } from '../src/resolution/plugins/plugin-config';
import {
  OBJECT_LITERAL_MEMBERS_PLUGIN_NAME,
  objectLiteralMembersPlugin,
  resetObjectLiteralMembersState,
} from '../src/resolution/plugins/object-literal-members';
import { clearNamespaceProxyCaches } from '../src/resolution/plugins/namespace-proxy';
import { detectFrameworks } from '../src/resolution/frameworks';
import { loadGrammarsForLanguages } from '../src/extraction/grammars';
import type { ResolutionContext } from '../src/resolution/types';

let dir: string;

const write = (rel: string, body: string): void => {
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body);
};

const writeConfig = (obj: unknown): void =>
  write('codegraph.json', typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2));

/** Minimal context rooted at the temp dir — enough for `detect()`. */
const makeContext = (): ResolutionContext =>
  ({
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
  }) as ResolutionContext;

/** Turn the plugin on for the temp project and hand `extract()` its root. */
const enable = (options: unknown): void => {
  writeConfig({ plugins: { [OBJECT_LITERAL_MEMBERS_PLUGIN_NAME]: options } });
  clearProjectConfigCache();
  clearPluginConfigCache();
  resetObjectLiteralMembersState();
  objectLiteralMembersPlugin.detect(makeContext());
};

const extract = (rel: string, source: string) =>
  objectLiteralMembersPlugin.extract!(rel, source);

const names = (rel: string, source: string): string[] =>
  extract(rel, source).nodes.map((n) => n.name).sort();

// `extract()` re-parses with the grammars the pipeline already has in memory.
// The unit-level cases here never boot a CodeGraph, so load them once up front.
beforeAll(async () => {
  await loadGrammarsForLanguages(['javascript', 'jsx', 'typescript', 'tsx']);
});

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-obj-members-'));
  clearProjectConfigCache();
  clearPluginConfigCache();
  resetObjectLiteralMembersState();
  clearNamespaceProxyCaches();
});

afterEach(() => {
  clearProjectConfigCache();
  clearPluginConfigCache();
  resetObjectLiteralMembersState();
  clearNamespaceProxyCaches();
  fs.rmSync(dir, { recursive: true, force: true });
});

const CONTROLLER_JS = `const helper = 1;

$ns.controller = {
  async init () {
    return helper;
  },
  refresh (count) {
    return count;
  },
  onDone: async (result) => result,
  timeout: 5000,
};

export function plain () {
  return 2;
}
`;

// ---------------------------------------------------------------------------
// detect() — config gating
// ---------------------------------------------------------------------------

describe('object-literal-members gating', () => {
  it('stays off with no codegraph.json, and extracts nothing', () => {
    expect(objectLiteralMembersPlugin.detect(makeContext())).toBe(false);
    expect(extract('src/a.js', CONTROLLER_JS).nodes).toHaveLength(0);
  });

  it('stays off when the project configures other plugins but not this one', () => {
    writeConfig({ plugins: { noop: { label: 'x' } } });
    expect(objectLiteralMembersPlugin.detect(makeContext())).toBe(false);
    expect(extract('src/a.js', CONTROLLER_JS).nodes).toHaveLength(0);
  });

  it('turns on with an `objects` list, and shows up among the detected frameworks', () => {
    writeConfig({ plugins: { [OBJECT_LITERAL_MEMBERS_PLUGIN_NAME]: { objects: ['$ns'] } } });
    expect(objectLiteralMembersPlugin.detect(makeContext())).toBe(true);
    expect(detectFrameworks(makeContext()).map((r) => r.name)).toContain(
      OBJECT_LITERAL_MEMBERS_PLUGIN_NAME
    );
  });

  it('stays off — and detaches a previously-recorded root — when switched back off', () => {
    enable({ objects: ['$ns'] });
    expect(extract('src/a.js', CONTROLLER_JS).nodes.length).toBeGreaterThan(0);

    writeConfig({ plugins: {} });
    clearProjectConfigCache();
    clearPluginConfigCache();
    expect(objectLiteralMembersPlugin.detect(makeContext())).toBe(false);
    expect(extract('src/a.js', CONTROLLER_JS).nodes).toHaveLength(0);
  });

  it('declares only the JS-family languages it can parse', () => {
    expect(objectLiteralMembersPlugin.languages).toEqual([
      'javascript',
      'jsx',
      'typescript',
      'tsx',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Config validation — warn and skip, never throw
// ---------------------------------------------------------------------------

describe('object-literal-members config validation', () => {
  const offCases: Array<[string, unknown]> = [
    ['no objects at all', {}],
    ['objects not an array', { objects: '$ns' }],
    ['objects empty', { objects: [] }],
    ['objects entries all unusable', { objects: ['$ns.', '', 'a b'] }],
    ['languages narrowed to nothing valid', { objects: ['$ns'], languages: ['cobol'] }],
    ['operators narrowed to nothing valid', { objects: ['$ns'], operators: ['+='] }],
  ];

  for (const [label, options] of offCases) {
    it(`stays off: ${label}`, () => {
      writeConfig({ plugins: { [OBJECT_LITERAL_MEMBERS_PLUGIN_NAME]: options } });
      expect(objectLiteralMembersPlugin.detect(makeContext())).toBe(false);
    });
  }

  it('tolerates malformed knob values by falling back to the defaults', () => {
    enable({
      objects: ['$ns'],
      topLevelOnly: 'yes',
      maxDepth: -3,
      maxMemberDepth: 'deep',
      emitContainer: 1,
      maxNodesPerFile: 0,
      include: 'src',
      languages: 'javascript',
      operators: '=',
    });
    // Defaults survived: container + three functions, data key ignored.
    expect(names('src/a.js', CONTROLLER_JS)).toEqual([
      'controller',
      'init',
      'onDone',
      'refresh',
    ]);
  });

  it('survives a codegraph.json that is not valid JSON', () => {
    writeConfig('{ "plugins": { ');
    expect(() => objectLiteralMembersPlugin.detect(makeContext())).not.toThrow();
    expect(objectLiteralMembersPlugin.detect(makeContext())).toBe(false);
  });

  it('resolves nothing — it mints symbols, it does not resolve references', () => {
    enable({ objects: ['$ns'] });
    const ref = {
      fromNodeId: 'x',
      referenceName: '$ns.controller.init',
      referenceKind: 'calls',
      line: 1,
      column: 0,
      filePath: 'src/a.js',
      language: 'javascript',
    } as never;
    expect(objectLiteralMembersPlugin.resolve(ref, makeContext())).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// What it emits
// ---------------------------------------------------------------------------

describe('object-literal-members extraction', () => {
  it('extracts every function-valued member, and skips the data ones', () => {
    enable({ objects: ['$ns'] });
    const { nodes } = extract('src/a.js', CONTROLLER_JS);
    expect(nodes.map((n) => `${n.kind}:${n.name}`)).toEqual([
      'variable:controller',
      'function:init',
      'function:refresh',
      'function:onDone',
    ]);
    expect(nodes.some((n) => n.name === 'timeout')).toBe(false);
  });

  it('extracts the identical file in TypeScript too — this was never a JS-only gap', () => {
    enable({ objects: ['$ns'] });
    const ts = CONTROLLER_JS.replace('refresh (count)', 'refresh (count: number)');
    expect(names('src/a.ts', ts)).toEqual(names('src/a.js', CONTROLLER_JS));
  });

  it('carries the qualified name the namespace reads as, plus span/async/signature', () => {
    enable({ objects: ['$ns'] });
    const { nodes } = extract('src/a.js', CONTROLLER_JS);
    const byName = new Map(nodes.map((n) => [n.name, n]));

    expect(byName.get('controller')!.qualifiedName).toBe('$ns.controller');
    expect(byName.get('init')!.qualifiedName).toBe('$ns.controller::init');
    expect(byName.get('onDone')!.qualifiedName).toBe('$ns.controller::onDone');

    expect(byName.get('init')!.isAsync).toBe(true);
    expect(byName.get('refresh')!.isAsync).toBeUndefined();
    expect(byName.get('refresh')!.signature).toBe('refresh(count)');
    expect(byName.get('onDone')!.signature).toBe('onDone(result)');

    // The container spans the whole assignment; each member spans its own body.
    const controller = byName.get('controller')!;
    expect(controller.startLine).toBe(3);
    expect(controller.endLine).toBe(12);
    const init = byName.get('init')!;
    expect(init.startLine).toBe(4);
    expect(init.endLine).toBe(6);
    expect(nodes.every((n) => n.filePath === 'src/a.js' && n.language === 'javascript')).toBe(true);
  });

  it('opts into file-scope re-attribution, and lets a project turn it off', () => {
    enable({ objects: ['$ns'] });
    expect(extract('src/a.js', CONTROLLER_JS).reattributeFileScopeRefs).toBe(true);

    enable({ objects: ['$ns'], reattributeReferences: false });
    expect(extract('src/a.js', CONTROLLER_JS).reattributeFileScopeRefs).toBe(false);
  });

  it('keeps the docstring written above a member', () => {
    enable({ objects: ['$ns'] });
    const { nodes } = extract(
      'src/a.js',
      `$ns.controller = {
  /** Boots the controller. */
  init () {},
};
`
    );
    expect(nodes.find((n) => n.name === 'init')!.docstring).toContain('Boots the controller');
  });

  it('accepts a dotted target, longest configured entry winning', () => {
    enable({ objects: ['module', 'module.exports'] });
    const { nodes } = extract(
      'src/a.js',
      `module.exports = { run () {} };
`
    );
    expect(nodes.map((n) => n.qualifiedName)).toEqual([
      'module.exports',
      'module.exports::run',
    ]);
  });

  it('reads the augmented operators, and honors a narrowed `operators` list', () => {
    enable({ objects: ['$ns'] });
    expect(names('src/a.js', `$ns.a ??= { run () {} };\n`)).toEqual(['a', 'run']);

    enable({ objects: ['$ns'], operators: ['='] });
    expect(names('src/a.js', `$ns.a ??= { run () {} };\n`)).toEqual([]);
    expect(names('src/a.js', `$ns.a = { run () {} };\n`)).toEqual(['a', 'run']);
  });
});

// ---------------------------------------------------------------------------
// Node-explosion guard + shape discipline
// ---------------------------------------------------------------------------

describe('object-literal-members abstains', () => {
  const cases: Array<[string, string]> = [
    ['a pure data/config object', `$ns.config = { a: 1, b: 2, c: 'three' };\n`],
    ['an empty object', `$ns.config = {};\n`],
    ['a namespace object that is not configured', `$other.controller = { run () {} };\n`],
    ['a computed target', `$ns[key] = { run () {} };\n`],
    ['a call-wrapped value', `$ns.controller = Object.freeze({ run () {} });\n`],
    ['a value that is not an object literal', `$ns.controller = makeController();\n`],
    ['a `this`-rooted target', `class A { m () { this.state = { run () {} }; } }\n`],
    ['a shorthand-only object', `$ns.controller = { init, refresh };\n`],
    ['a spread-only object', `$ns.controller = { ...base };\n`],
  ];

  for (const [label, source] of cases) {
    it(`emits nothing for ${label}`, () => {
      enable({ objects: ['$ns'] });
      expect(names('src/a.js', source)).toEqual([]);
    });
  }

  it('emits nothing for a data-only object even when a sibling assignment does emit', () => {
    enable({ objects: ['$ns'] });
    expect(
      names(
        'src/a.js',
        `$ns.config = { a: 1 };
$ns.controller = { run () {} };
`
      )
    ).toEqual(['controller', 'run']);
  });

  it('caps the nodes one file can contribute', () => {
    enable({ objects: ['$ns'], maxNodesPerFile: 3 });
    const body = Array.from({ length: 20 }, (_, i) => `  m${i} () {},`).join('\n');
    expect(extract('src/a.js', `$ns.controller = {\n${body}\n};\n`).nodes).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// Precision knobs
// ---------------------------------------------------------------------------

describe('object-literal-members knobs', () => {
  const NESTED = `$ns.controller = {
  init () {},
  ui: {
    open () {},
    theme: 'dark',
  },
};
`;

  it('descends only the assigned object by default', () => {
    enable({ objects: ['$ns'] });
    expect(names('src/a.js', NESTED)).toEqual(['controller', 'init']);
  });

  it('descends one nested level at maxDepth 2, qualifying through it', () => {
    enable({ objects: ['$ns'], maxDepth: 2 });
    const { nodes } = extract('src/a.js', NESTED);
    expect(nodes.map((n) => n.qualifiedName)).toEqual([
      '$ns.controller',
      '$ns.controller::init',
      '$ns.controller::ui',
      '$ns.controller::ui::open',
    ]);
  });

  const WRAPPED = `(function () {
  $ns.controller = { run () {} };
})();
`;

  it('ignores an assignment that is not a top-level statement by default', () => {
    enable({ objects: ['$ns'] });
    expect(names('src/a.js', WRAPPED)).toEqual([]);
  });

  it('finds a wrapped assignment with topLevelOnly false', () => {
    enable({ objects: ['$ns'], topLevelOnly: false });
    expect(names('src/a.js', WRAPPED)).toEqual(['controller', 'run']);
  });

  it('bounds how many member segments the target may carry', () => {
    enable({ objects: ['$ns'] });
    expect(names('src/a.js', `$ns.ui.panel = { open () {} };\n`)).toEqual(['open', 'panel']);
    expect(names('src/a.js', `$ns.a.b.c = { open () {} };\n`)).toEqual([]);

    enable({ objects: ['$ns'], maxMemberDepth: 3 });
    expect(names('src/a.js', `$ns.a.b.c = { open () {} };\n`)).toEqual(['c', 'open']);
  });

  it('drops the container node when emitContainer is false', () => {
    enable({ objects: ['$ns'], emitContainer: false });
    expect(names('src/a.js', `$ns.controller = { run () {} };\n`)).toEqual(['run']);
  });

  it('honors the include globs', () => {
    enable({ objects: ['$ns'], include: ['src/legacy/**'] });
    expect(names('src/legacy/a.js', `$ns.c = { run () {} };\n`)).toEqual(['c', 'run']);
    expect(names('src/modern/a.js', `$ns.c = { run () {} };\n`)).toEqual([]);
  });

  it('honors the language scope, and never touches a non-JS extension', () => {
    enable({ objects: ['$ns'], languages: ['javascript'] });
    const source = `$ns.c = { run () {} };\n`;
    expect(names('src/a.js', source)).toEqual(['c', 'run']);
    expect(names('src/a.ts', source)).toEqual([]);
    expect(names('src/a.py', source)).toEqual([]);
  });

  it('extracts from jsx and tsx as well', () => {
    enable({ objects: ['$ns'] });
    const source = `$ns.c = { render () { return <div />; } };\n`;
    expect(names('src/a.jsx', source)).toEqual(['c', 'render']);
    expect(names('src/a.tsx', source)).toEqual(['c', 'render']);
  });
});

// ---------------------------------------------------------------------------
// End-to-end over a real index
// ---------------------------------------------------------------------------

async function index(): Promise<{ cg: CodeGraph; rows: (sql: string) => any[] }> {
  const cg = await CodeGraph.init(dir, { silent: true });
  await cg.indexAll();
  const db = (cg as any).db.db;
  return { cg, rows: (sql: string) => db.prepare(sql).all() };
}

/** Re-open an already-initialized project and index it again. */
async function reindex(): Promise<{ cg: CodeGraph; rows: (sql: string) => any[] }> {
  const cg = await CodeGraph.open(dir, { silent: true });
  await cg.indexAll();
  const db = (cg as any).db.db;
  return { cg, rows: (sql: string) => db.prepare(sql).all() };
}

const NODE_SQL = `SELECT kind, name, qualified_name, file_path, start_line
                  FROM nodes WHERE kind != 'file' ORDER BY file_path, start_line, name`;

function writeProject(): void {
  write('src/controller.js', CONTROLLER_JS);
  write(
    'src/panel.js',
    `$ns.panel = {
  open () {
    return 1;
  },
};
`
  );
  write('src/data.js', `$ns.settings = { retries: 3, verbose: false };\n`);
}

describe('object-literal-members end to end', () => {
  it('indexes members that do not exist in the graph without the plugin', async () => {
    writeProject();

    // Baseline: no plugin config at all.
    const before = (await index()).rows(NODE_SQL);
    expect(before.map((r) => r.name)).toEqual(['helper', 'plain']);
    expect(before.some((r) => r.name === 'init')).toBe(false);
    fs.rmSync(path.join(dir, '.codegraph'), { recursive: true, force: true });

    writeConfig({ plugins: { [OBJECT_LITERAL_MEMBERS_PLUGIN_NAME]: { objects: ['$ns'] } } });
    clearProjectConfigCache();
    clearPluginConfigCache();
    resetObjectLiteralMembersState();

    const after = (await index()).rows(NODE_SQL);
    expect(after.map((r) => `${r.kind}:${r.name}`)).toEqual([
      'constant:helper',
      'variable:controller',
      'function:init',
      'function:refresh',
      'function:onDone',
      'function:plain',
      'variable:panel',
      'function:open',
    ]);
    // The data-only object contributed nothing — the explosion guard, live.
    expect(after.some((r) => r.file_path === 'src/data.js')).toBe(false);
    expect(after.find((r) => r.name === 'init')!.qualified_name).toBe('$ns.controller::init');
  });

  it('mints stable ids across a re-index, so a sync churns no edges', async () => {
    writeProject();
    writeConfig({ plugins: { [OBJECT_LITERAL_MEMBERS_PLUGIN_NAME]: { objects: ['$ns'] } } });
    clearProjectConfigCache();
    clearPluginConfigCache();
    resetObjectLiteralMembersState();

    const first = (await index()).rows(`SELECT id FROM nodes ORDER BY id`).map((r) => r.id);
    const second = (await reindex()).rows(`SELECT id FROM nodes ORDER BY id`).map((r) => r.id);
    expect(second).toEqual(first);
    expect(first.length).toBeGreaterThan(5);
  });

  it('gives a `$ns.controller.init()` call site a handler node to land on', async () => {
    write(
      'src/controller.js',
      `$ns.controller = {
  async init () {
    return 1;
  },
};
`
    );
    write(
      'src/boot.js',
      `export async function boot () {
  await $ns.controller.init();
}
`
    );
    writeConfig({
      plugins: {
        [OBJECT_LITERAL_MEMBERS_PLUGIN_NAME]: { objects: ['$ns'] },
        'namespace-proxy': {
          objects: ['$ns'],
          assignments: { objects: ['$ns'], topLevelOnly: true },
        },
      },
    });
    clearProjectConfigCache();
    clearPluginConfigCache();
    resetObjectLiteralMembersState();
    clearNamespaceProxyCaches();

    const { rows } = await index();
    // Without the plugin there is no `init` node anywhere, so this call site has
    // nothing to resolve to and the flow stops at the file.
    const edges = rows(`
      SELECT s.name src, t.name tgt, t.kind tgt_kind, t.file_path tgt_file
      FROM edges e JOIN nodes s ON s.id = e.source JOIN nodes t ON t.id = e.target
      WHERE e.kind = 'calls' ORDER BY src, tgt`);
    expect(edges).toEqual([
      { src: 'boot', tgt: 'init', tgt_kind: 'function', tgt_file: 'src/controller.js' },
    ]);
    // And the container the namespace resolves through is a symbol of its own.
    expect(
      rows(`SELECT kind, qualified_name q FROM nodes WHERE name = 'controller'`)
    ).toEqual([{ kind: 'variable', q: '$ns.controller' }]);
  });

  it('re-attributes a member\'s calls from the file node onto the member', async () => {
    write(
      'src/controller.js',
      `function helper () {
  return 1;
}

$ns.controller = {
  init () {
    return helper();
  },
};
`
    );
    writeConfig({ plugins: { [OBJECT_LITERAL_MEMBERS_PLUGIN_NAME]: { objects: ['$ns'] } } });
    clearProjectConfigCache();
    clearPluginConfigCache();
    resetObjectLiteralMembersState();

    const { rows } = await index();
    expect(
      rows(`SELECT s.kind s_kind, s.name src, t.name tgt
            FROM edges e JOIN nodes s ON s.id = e.source JOIN nodes t ON t.id = e.target
            WHERE e.kind = 'calls'`)
    ).toEqual([{ s_kind: 'function', src: 'init', tgt: 'helper' }]);
  });

  it('leaves the call on the file node when re-attribution is switched off', async () => {
    write(
      'src/controller.js',
      `function helper () {
  return 1;
}

$ns.controller = {
  init () {
    return helper();
  },
};
`
    );
    writeConfig({
      plugins: {
        [OBJECT_LITERAL_MEMBERS_PLUGIN_NAME]: { objects: ['$ns'], reattributeReferences: false },
      },
    });
    clearProjectConfigCache();
    clearPluginConfigCache();
    resetObjectLiteralMembersState();

    const { rows } = await index();
    expect(
      rows(`SELECT s.kind s_kind, s.name src, t.name tgt
            FROM edges e JOIN nodes s ON s.id = e.source JOIN nodes t ON t.id = e.target
            WHERE e.kind = 'calls'`)
    ).toEqual([{ s_kind: 'file', src: 'controller.js', tgt: 'helper' }]);
  });

  it('a project with no plugin config indexes byte-identically to before', async () => {
    writeProject();
    const withoutKey = (await index()).rows(NODE_SQL);
    fs.rmSync(path.join(dir, '.codegraph'), { recursive: true, force: true });

    // An unrelated plugins block must be just as inert.
    writeConfig({ plugins: { disable: [] } });
    clearProjectConfigCache();
    clearPluginConfigCache();
    resetObjectLiteralMembersState();
    const withOtherKeys = (await index()).rows(NODE_SQL);

    expect(withOtherKeys).toEqual(withoutKey);
    expect(withoutKey.map((r) => r.name)).toEqual(['helper', 'plain']);
  });
});

// ---------------------------------------------------------------------------
// Call-wrapper unwrapping (ROADMAP item 1k)
// ---------------------------------------------------------------------------

describe('object-literal-members wrappers', () => {
  /** A component defined the factory way, with a getter, a method and JSX. */
  const COMPONENT_JSX = `const { $ns, $ui, bus } = app;

$ns.UpsellSnack = $ui.component('UpsellSnack', {

  get show () {
    return true;
  },

  render () {
    return <div onClick={ this._onActivate }/>;
  },

  async _onActivate () {
    await bus.send('billing.update');
  },
});
`;

  it('descends into the object literal of a configured wrapper call', () => {
    enable({ objects: ['$ns'], wrappers: ['$ui.component'] });
    expect(names('src/snack.jsx', COMPONENT_JSX)).toEqual([
      'UpsellSnack',
      '_onActivate',
      'render',
      'show',
    ]);
  });

  it('gives a wrapper-produced container kind `component`, direct literals stay `variable`', () => {
    enable({ objects: ['$ns'], wrappers: ['$ui.component'] });
    const viaWrapper = extract('src/snack.jsx', COMPONENT_JSX).nodes;
    expect(viaWrapper.find((n) => n.name === 'UpsellSnack')!.kind).toBe('component');
    expect(viaWrapper.find((n) => n.name === 'render')!.kind).toBe('function');

    const direct = extract('src/plain.js', `$ns.controller = { run () {} };\n`).nodes;
    expect(direct.find((n) => n.name === 'controller')!.kind).toBe('variable');
  });

  it('keeps the container name and qualified name from the assignment target', () => {
    enable({ objects: ['$ns'], wrappers: ['$ui.component'] });
    const nodes = extract('src/snack.jsx', COMPONENT_JSX).nodes;
    const container = nodes.find((n) => n.kind === 'component')!;
    expect(container.name).toBe('UpsellSnack');
    expect(container.qualifiedName).toBe('$ns.UpsellSnack');
    expect(nodes.find((n) => n.name === '_onActivate')!.qualifiedName).toBe('$ns.UpsellSnack::_onActivate');
  });

  it('does NOT unwrap a callee that is not configured', () => {
    enable({ objects: ['$ns'], wrappers: ['$ui.component'] });
    expect(names('src/a.js', `$ns.X = other.factory('X', { run () {} });\n`)).toEqual([]);
    // Prefix / suffix of a configured wrapper is not a match either.
    expect(names('src/b.js', `$ns.X = my.$ui.component('X', { run () {} });\n`)).toEqual([]);
  });

  it('abstains when the wrapper call has no object-literal argument', () => {
    enable({ objects: ['$ns'], wrappers: ['$ui.component'] });
    expect(names('src/a.js', `$ns.X = $ui.component('X', makeSpec());\n`)).toEqual([]);
    expect(names('src/b.js', `$ns.X = $ui.component('X');\n`)).toEqual([]);
  });

  it('uses the LAST object-literal argument when several are present', () => {
    enable({ objects: ['$ns'], wrappers: ['$ui.component'] });
    const got = names('src/a.js', `$ns.X = $ui.component({ first () {} }, { second () {} });\n`);
    expect(got).toEqual(['X', 'second']);
  });

  it('still refuses non-wrapper calls when wrappers are configured', () => {
    enable({ objects: ['$ns'], wrappers: ['$ui.component'] });
    expect(names('src/a.js', `$ns.X = Object.freeze({ run () {} });\n`)).toEqual([]);
  });

  it('warns and skips a malformed wrappers value without losing the plugin', () => {
    enable({ objects: ['$ns'], wrappers: 'not-an-array' });
    // Plugin still works, just without unwrapping.
    expect(names('src/a.js', `$ns.controller = { run () {} };\n`)).toEqual(['controller', 'run']);
    expect(names('src/b.js', `$ns.X = $ui.component('X', { run () {} });\n`)).toEqual([]);
  });

  it("member bodies are covered by the members' spans, so re-attribution reaches them", async () => {
    // End-to-end through extractFromSource: the bus.send ref inside
    // _onActivate must land on the member node, not the file node.
    const { extractFromSource } = await import('../src/extraction/tree-sitter');
    enable({ objects: ['$ns'], wrappers: ['$ui.component'] });
    const result = extractFromSource('src/snack.jsx', COMPONENT_JSX, 'jsx', [OBJECT_LITERAL_MEMBERS_PLUGIN_NAME]);

    const member = result.nodes.find((n) => n.name === '_onActivate');
    expect(member).toBeDefined();
    const busRefs = result.unresolvedReferences.filter((r) => r.referenceName === 'bus.send' || r.referenceName === 'send');
    expect(busRefs.length).toBeGreaterThan(0);
    for (const ref of busRefs) {
      expect(ref.fromNodeId).toBe(member!.id);
    }
  });
});
