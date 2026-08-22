/**
 * Event-bus plugin — string-keyed message buses declared in `codegraph.json`.
 *
 * Three layers under test:
 *   1. Config: the `objects`/`dispatch`/`subscribe` vocabulary (both the
 *      shorthand and the multi-bus long form), the precision knobs, and the
 *      warn-and-skip behavior every malformed value must get.
 *   2. Hooks: `detect` is config-gated and `claimsReference` only claims
 *      `<object>.<dispatchVerb>` — the names it will actually try to resolve.
 *   3. End-to-end: a real index over a real (synthetic) project, so the edges
 *      are the ones an agent would actually traverse.
 *   4. Receiver paths: the dotted expression a handler is written as. The last
 *      segment names the symbol; the ones in front of it are a path that must
 *      DISAMBIGUATE the lookup — including by forbidding tiers of it.
 *
 * The headline invariants, asserted explicitly at the bottom: a project with no
 * `event-bus` config indexes EXACTLY as it did before the plugin existed, and
 * the built-in event-emitter synthesizer is untouched whether the plugin is on
 * or off.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { CodeGraph } from '../src';
import { clearProjectConfigCache } from '../src/project-config';
import { clearPluginConfigCache } from '../src/resolution/plugins/plugin-config';
import {
  EVENT_BUS_PLUGIN_NAME,
  eventBusPlugin,
  resetEventBusPluginState,
} from '../src/resolution/plugins/event-bus';
import { detectFrameworks } from '../src/resolution/frameworks';
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

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-event-bus-'));
  clearProjectConfigCache();
  clearPluginConfigCache();
  resetEventBusPluginState();
});

afterEach(() => {
  clearProjectConfigCache();
  clearPluginConfigCache();
  resetEventBusPluginState();
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// detect() + claimsReference()
// ---------------------------------------------------------------------------

describe('event-bus plugin gating', () => {
  it('stays off with no codegraph.json, and claims nothing', () => {
    expect(eventBusPlugin.detect(makeContext())).toBe(false);
    expect(eventBusPlugin.claimsReference!('$bus.send')).toBe(false);
  });

  it('stays off when the project configures other plugins but not this one', () => {
    writeConfig({ plugins: { noop: { label: 'x' } } });
    expect(eventBusPlugin.detect(makeContext())).toBe(false);
    expect(eventBusPlugin.claimsReference!('$bus.send')).toBe(false);
  });

  it('turns on with a declared bus and shows up among the detected frameworks', () => {
    writeConfig({ plugins: { 'event-bus': { objects: ['$bus'] } } });
    expect(eventBusPlugin.detect(makeContext())).toBe(true);
    expect(detectFrameworks(makeContext()).map((r) => r.name)).toContain(EVENT_BUS_PLUGIN_NAME);
  });

  it('honors the disable list even with options present', () => {
    writeConfig({ plugins: { disable: [EVENT_BUS_PLUGIN_NAME], 'event-bus': { objects: ['$bus'] } } });
    expect(eventBusPlugin.detect(makeContext())).toBe(false);
    expect(detectFrameworks(makeContext()).map((r) => r.name)).not.toContain(EVENT_BUS_PLUGIN_NAME);
  });

  it('stays off — without throwing — when enabled but declaring no bus objects', () => {
    writeConfig({ plugins: { 'event-bus': true } });
    expect(eventBusPlugin.detect(makeContext())).toBe(false);
    expect(eventBusPlugin.claimsReference!('$bus.send')).toBe(false);
  });

  it('warn-and-skips malformed vocabularies instead of throwing', () => {
    writeConfig({
      plugins: {
        'event-bus': {
          objects: ['$bus', 42, 'not an identifier', '$ok'],
          dispatch: 'send',
          subscribe: ['on', ''],
          maxHandlersPerEvent: 'lots',
          buses: 'nope',
        },
      },
    });
    expect(() => eventBusPlugin.detect(makeContext())).not.toThrow();
    expect(eventBusPlugin.detect(makeContext())).toBe(true);
    // The two valid objects survive with the default verb vocabulary.
    expect(eventBusPlugin.claimsReference!('$bus.send')).toBe(true);
    expect(eventBusPlugin.claimsReference!('$ok.emit')).toBe(true);
    expect(eventBusPlugin.claimsReference!('$bus.on')).toBe(false);
  });

  it('claims only <object>.<dispatchVerb>, including through a receiver', () => {
    writeConfig({
      plugins: { 'event-bus': { objects: ['$bus'], dispatch: ['send'], subscribe: ['on'] } },
    });
    eventBusPlugin.detect(makeContext());
    expect(eventBusPlugin.claimsReference!('$bus.send')).toBe(true);
    expect(eventBusPlugin.claimsReference!('this.$bus.send')).toBe(true);
    // Subscribe verbs, undeclared objects and bare names are never claimed —
    // a claim opts a name past the resolver's pre-filter, so over-claiming
    // would push unrelated references into the fuzzy strategies.
    expect(eventBusPlugin.claimsReference!('$bus.on')).toBe(false);
    expect(eventBusPlugin.claimsReference!('$other.send')).toBe(false);
    expect(eventBusPlugin.claimsReference!('send')).toBe(false);
    expect(eventBusPlugin.claimsReference!('bus.send')).toBe(false);
  });

  it('claims each bus of a multi-bus long-form config with its own verbs', () => {
    writeConfig({
      plugins: {
        'event-bus': {
          buses: [
            { name: 'app', objects: ['$bus', 'appBus'], dispatch: ['send'], subscribe: ['on'] },
            { objects: ['$workerBus'], dispatch: ['post'], subscribe: ['handle'] },
          ],
        },
      },
    });
    expect(eventBusPlugin.detect(makeContext())).toBe(true);
    expect(eventBusPlugin.claimsReference!('$bus.send')).toBe(true);
    expect(eventBusPlugin.claimsReference!('appBus.send')).toBe(true);
    expect(eventBusPlugin.claimsReference!('$workerBus.post')).toBe(true);
    // Verb vocabularies do not leak between buses.
    expect(eventBusPlugin.claimsReference!('$workerBus.send')).toBe(false);
    expect(eventBusPlugin.claimsReference!('$bus.post')).toBe(false);
  });

  it('forgets a project once its config turns the plugin off again', () => {
    writeConfig({ plugins: { 'event-bus': { objects: ['$bus'] } } });
    expect(eventBusPlugin.detect(makeContext())).toBe(true);
    expect(eventBusPlugin.claimsReference!('$bus.send')).toBe(true);

    writeConfig({ extensions: {} });
    clearProjectConfigCache();
    clearPluginConfigCache();
    expect(eventBusPlugin.detect(makeContext())).toBe(false);
    expect(eventBusPlugin.claimsReference!('$bus.send')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// resolve() directly — the edge tag, and the line-read fallback
// ---------------------------------------------------------------------------

describe('event-bus plugin resolve()', () => {
  /**
   * A project whose SUBSCRIPTION lives in a scanned TypeScript file while the
   * DISPATCH lives in a file the scan skips (no comment stripper for its
   * language). That is the one shape the per-line read exists for.
   */
  function crossFileContext(): { context: ResolutionContext; handlerId: string } {
    const handlerId = 'node:onJobRun';
    const subscriptionFile = 'src/handlers.ts';
    const dispatchFile = 'templates/worker.tpl';
    const subscriptionSource = [
      'export function onJobRun(): void {}',
      '',
      'export function wire(): void {',
      "  $bus.on('job.run', onJobRun);",
      '}',
      '',
    ].join('\n');
    const dispatchLine = "  $bus.send('job.run', payload)";

    const node = (id: string, name: string, kind: string, filePath: string, startLine: number) =>
      ({
        id,
        kind,
        name,
        qualifiedName: `${filePath}::${name}`,
        filePath,
        language: 'typescript',
        startLine,
        endLine: startLine,
        startColumn: 0,
        endColumn: 0,
      }) as any;

    const handler = node(handlerId, 'onJobRun', 'function', subscriptionFile, 1);
    const nodesInFile: Record<string, any[]> = {
      [subscriptionFile]: [
        node('file:handlers', 'handlers.ts', 'file', subscriptionFile, 1),
        handler,
        node('node:wire', 'wire', 'function', subscriptionFile, 3),
      ],
    };

    const context = {
      getNodesInFile: (p: string) => nodesInFile[p] ?? [],
      getNodesByName: (n: string) => (n === 'onJobRun' ? [handler] : []),
      getNodesByQualifiedName: () => [],
      getNodesByKind: () => [],
      getNodesByLowerName: () => [],
      getImportMappings: () => [],
      fileExists: (p: string) => p === subscriptionFile || p === dispatchFile,
      readFile: (p: string) => (p === subscriptionFile ? subscriptionSource : null),
      getFileLines: (p: string) => (p === dispatchFile ? [dispatchLine] : null),
      getProjectRoot: () => dir,
      getAllFiles: () => [subscriptionFile, dispatchFile],
    } as unknown as ResolutionContext;

    return { context, handlerId };
  }

  const busRef = (over: Record<string, unknown> = {}) =>
    ({
      fromNodeId: 'node:caller',
      referenceName: '$bus.send',
      referenceKind: 'calls',
      line: 1,
      column: 2,
      filePath: 'templates/worker.tpl',
      language: 'typescript',
      ...over,
    }) as any;

  beforeEach(() => {
    writeConfig({
      plugins: { 'event-bus': { objects: ['$bus'], dispatch: ['send'], subscribe: ['on'] } },
    });
  });

  it('reads the event off the reference line when the file was not scanned', () => {
    const { context, handlerId } = crossFileContext();
    expect(eventBusPlugin.detect(context)).toBe(true);

    const resolved: any = eventBusPlugin.resolve(busRef(), context);
    expect(resolved).not.toBeNull();
    expect(resolved.targetNodeId).toBe(handlerId);
    expect(resolved.resolvedBy).toBe('framework');
    expect(resolved.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it('tags the edge as a heuristic bridge and names the wiring site', () => {
    const { context } = crossFileContext();
    eventBusPlugin.detect(context);

    const resolved: any = eventBusPlugin.resolve(busRef(), context);
    expect(resolved.edge).toEqual({
      provenance: 'heuristic',
      metadata: {
        synthesizedBy: 'event-bus',
        bus: '$bus',
        event: 'job.run',
        // The `$bus.on(...)` line an agent would otherwise have to grep for.
        registeredAt: 'src/handlers.ts:4',
      },
    });
  });

  it('resolves nothing for a non-call reference, an undeclared verb, or a dynamic key', () => {
    const { context } = crossFileContext();
    eventBusPlugin.detect(context);

    // Only a `calls` reference is a dispatch.
    expect(eventBusPlugin.resolve(busRef({ referenceKind: 'references' }), context)).toBeNull();
    // A verb the project did not declare as a dispatch verb.
    expect(eventBusPlugin.resolve(busRef({ referenceName: '$bus.on' }), context)).toBeNull();
    // A bus object the project did not declare.
    expect(eventBusPlugin.resolve(busRef({ referenceName: '$other.send' }), context)).toBeNull();
    // A line with no static string key.
    expect(eventBusPlugin.resolve(busRef({ line: 2 }), context)).toBeNull();
  });

  /**
   * A registering file that binds the handler name as a LOCAL `const` which
   * extraction produced no node for (a callback declared inside a function).
   * `local` decides whether that binding is present; the project-wide symbol
   * sharing the name lives in a different file either way.
   */
  function localBindingContext(local: boolean): {
    context: ResolutionContext;
    dispatchLine: number;
  } {
    const registrar = 'src/bridge.ts';
    const elsewhere = 'src/transport.ts';
    const lines = [
      'export function wire(): void {',
      ...(local ? ['  const relay = (value: string): void => { void value; };'] : []),
      "  $bus.on('job.run', relay);",
      '}',
      '',
      'export function fire(): void {',
      "  $bus.send('job.run');",
      '}',
      '',
    ];
    const dispatchLine = lines.findIndex((l) => l.includes('$bus.send')) + 1;
    const source = lines.join('\n');

    const node = (id: string, name: string, kind: string, filePath: string, startLine: number) =>
      ({
        id,
        kind,
        name,
        qualifiedName: name,
        filePath,
        language: 'typescript',
        startLine,
        endLine: startLine,
        startColumn: 0,
        endColumn: 0,
      }) as any;

    const far = node('node:relay', 'relay', 'function', elsewhere, 1);
    const nodesInFile: Record<string, any[]> = {
      [registrar]: [node('node:wire', 'wire', 'function', registrar, 1)],
      [elsewhere]: [far],
    };

    const context = {
      getNodesInFile: (p: string) => nodesInFile[p] ?? [],
      getNodesByName: (n: string) => (n === 'relay' ? [far] : []),
      getNodesByQualifiedName: () => [],
      getNodesByKind: () => [],
      getNodesByLowerName: () => [],
      getImportMappings: () => [],
      fileExists: (p: string) => p === registrar || p === elsewhere,
      readFile: (p: string) => (p === registrar ? source : null),
      getFileLines: () => null,
      getProjectRoot: () => dir,
      getAllFiles: () => [registrar, elsewhere],
    } as unknown as ResolutionContext;

    return { context, dispatchLine };
  }

  const localRef = (line: number) =>
    busRef({ filePath: 'src/bridge.ts', line, column: 2, fromNodeId: 'node:fire' });

  it('will not answer a locally-bound handler name with a project-wide symbol', () => {
    const { context, dispatchLine } = localBindingContext(true);
    expect(eventBusPlugin.detect(context)).toBe(true);
    // The subscription registered nothing, so the dispatch has nothing to pair.
    expect(eventBusPlugin.resolve(localRef(dispatchLine), context)).toBeNull();
  });

  it('still answers project-wide when the name is not bound locally', () => {
    const { context, dispatchLine } = localBindingContext(false);
    expect(eventBusPlugin.detect(context)).toBe(true);
    // Byte-for-byte the same file minus the local `const` — and now it pairs.
    const resolved: any = eventBusPlugin.resolve(localRef(dispatchLine), context);
    expect(resolved).not.toBeNull();
    expect(resolved.targetNodeId).toBe('node:relay');
  });

  it('resolves nothing at all for a project that never enabled it', () => {
    const { context } = crossFileContext();
    writeConfig({ extensions: {} });
    clearProjectConfigCache();
    clearPluginConfigCache();
    resetEventBusPluginState();

    expect(eventBusPlugin.detect(context)).toBe(false);
    expect(eventBusPlugin.resolve(busRef(), context)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// End-to-end over a real index
// ---------------------------------------------------------------------------

/** Bus edges are `calls` edges resolved by a framework from a `<obj>.<verb>` ref. */
const BUS_EDGE_SQL = `
  SELECT s.name src, t.name tgt, t.file_path tgt_file,
         json_extract(e.metadata,'$.refName') ref
  FROM edges e
  JOIN nodes s ON s.id = e.source
  JOIN nodes t ON t.id = e.target
  WHERE json_extract(e.metadata,'$.resolvedBy') = 'framework'
    AND json_extract(e.metadata,'$.refName') LIKE '$%'
  ORDER BY src, tgt`;

async function index(): Promise<{ cg: CodeGraph; rows: (sql: string) => any[] }> {
  const cg = await CodeGraph.init(dir, { silent: true });
  await cg.indexAll();
  const db = (cg as any).db.db;
  return { cg, rows: (sql: string) => db.prepare(sql).all() };
}

/** The synthetic project every end-to-end case indexes. */
function writeProject(): void {
  write(
    'src/orders.ts',
    `export class OrderService {
  async place(id: string): Promise<void> {
    await $bus.send('order.placed', id);
  }
  async cancel(id: string): Promise<void> {
    await $bus.send('order.cancelled', id);
  }
  async archive(id: string): Promise<void> {
    // Dynamic key — nothing static to pair, so nothing is emitted.
    const key = 'order.' + id;
    await $bus.send(key, id);
  }
}
`
  );
  write(
    'src/inbox.ts',
    `export function onOrderPlaced(id: string): void {
  record(id);
}

function record(id: string): void {
  void id;
}

export function subscribe(): void {
  $bus.on('order.placed', onOrderPlaced);
  // An anonymous handler has no node to point at — deliberately ignored.
  $bus.on('order.cancelled', (id: string) => record(id));
  // $bus.on('order.archived', onOrderPlaced);
}
`
  );
  write(
    'src/panel.ts',
    `export function onPanelReady(): void {
  void 0;
}

export function wire(): void {
  // A DIFFERENT bus using the SAME event key — must never cross-talk.
  $panelBus.on('order.placed', onPanelReady);
}

export function ping(): void {
  $panelBus.send('panel.ready');
}
`
  );
}

describe('event-bus plugin end-to-end', () => {
  it('links a dispatch to its subscriber and refuses every ambiguous shape', async () => {
    writeProject();
    writeConfig({
      plugins: {
        'event-bus': {
          buses: [
            { objects: ['$bus'], dispatch: ['send'], subscribe: ['on'] },
            { objects: ['$panelBus'], dispatch: ['send'], subscribe: ['on'] },
          ],
        },
      },
    });

    const { cg, rows } = await index();
    const edges = rows(BUS_EDGE_SQL);
    cg.close?.();

    // The one confident pairing: place() → onOrderPlaced, across files.
    expect(edges).toEqual([
      { src: 'place', tgt: 'onOrderPlaced', tgt_file: 'src/inbox.ts', ref: '$bus.send' },
    ]);
    // cancel() has only an anonymous handler; archive() dispatches a computed
    // key; the commented-out registration never existed.
    expect(edges.some((r: any) => r.src === 'cancel' || r.src === 'archive')).toBe(false);
    // Buses never cross-talk: $panelBus subscribes to the SAME key, and its own
    // 'panel.ready' dispatch has no subscriber at all.
    expect(edges.some((r: any) => r.tgt === 'onPanelReady')).toBe(false);
  });

  it('respects the per-bus event namespace when both buses use one key', async () => {
    writeProject();
    write(
      'src/panel-extra.ts',
      `import { ping } from './panel';

export function onPanelStart(): void {
  ping();
}

export function wirePanel(): void {
  $panelBus.on('panel.ready', onPanelStart);
}
`
    );
    writeConfig({
      plugins: {
        'event-bus': {
          objects: ['$bus', '$panelBus'],
          dispatch: ['send'],
          subscribe: ['on'],
        },
      },
    });

    const { cg, rows } = await index();
    const edges = rows(BUS_EDGE_SQL);
    cg.close?.();

    const pairs = edges.map((r: any) => `${r.src}>${r.tgt}`);
    expect(pairs).toContain('place>onOrderPlaced');
    expect(pairs).toContain('ping>onPanelStart');
    // $panelBus.on('order.placed', onPanelReady) must NOT catch $bus's dispatch.
    expect(pairs).not.toContain('place>onPanelReady');
  });

  it('reads a handler through a receiver and through .bind()', async () => {
    write(
      'src/controller.ts',
      `import { store } from './store';

export class Controller {
  register(): void {
    $bus.on('area.checked', this.onChecked.bind(this));
    $bus.on('area.listed', store.list, store);
  }

  onChecked(): void {
    void 0;
  }
}
`
    );
    write(
      'src/store.ts',
      `export const store = {
  list(): void {
    void 0;
  },
};
`
    );
    write(
      'src/caller.ts',
      `export function check(): void {
  $bus.send('area.checked');
}

export function list(): void {
  $bus.send('area.listed');
}
`
    );
    writeConfig({
      plugins: { 'event-bus': { objects: ['$bus'], dispatch: ['send'], subscribe: ['on'] } },
    });

    const { cg, rows } = await index();
    const edges = rows(BUS_EDGE_SQL);
    cg.close?.();

    const pairs = edges.map((r: any) => `${r.src}>${r.tgt}`);
    // `.bind(this)` — the dominant registration form in real bus code.
    expect(pairs).toContain('check>onChecked');
    // `store.list` — a receiver-reached handler resolved by its member name.
    expect(pairs).toContain('list>list');
  });

  it('skips an event whose handler fan-out exceeds the cap', async () => {
    write(
      'src/emitters.ts',
      `export function broadcast(): void {
  $bus.send('app.changed', 1);
}
`
    );
    const handlers = [1, 2, 3].map((n) => `export function onChanged${n}(): void { void ${n}; }`);
    write(
      'src/handlers.ts',
      `${handlers.join('\n')}

export function wireAll(): void {
${[1, 2, 3].map((n) => `  $bus.on('app.changed', onChanged${n});`).join('\n')}
}
`
    );
    writeConfig({
      plugins: {
        'event-bus': {
          objects: ['$bus'],
          dispatch: ['send'],
          subscribe: ['on'],
          maxHandlersPerEvent: 2,
        },
      },
    });

    const { cg, rows } = await index();
    const edges = rows(BUS_EDGE_SQL);
    cg.close?.();
    expect(edges).toEqual([]);
  });

  it('still pairs the same event once the cap allows its fan-out', async () => {
    write(
      'src/emitters.ts',
      `export function broadcast(): void {
  $bus.send('app.changed', 1);
}
`
    );
    write(
      'src/handlers.ts',
      `export function onChangedA(): void { void 0; }
export function onChangedB(): void { void 0; }

export function wireAll(): void {
  $bus.on('app.changed', onChangedA);
  $bus.on('app.changed', onChangedB);
}
`
    );
    writeConfig({
      plugins: {
        'event-bus': { objects: ['$bus'], dispatch: ['send'], subscribe: ['on'] },
      },
    });

    const { cg, rows } = await index();
    const edges = rows(BUS_EDGE_SQL);
    cg.close?.();
    // One reference resolves to one edge, chosen deterministically.
    expect(edges.length).toBe(1);
    expect(edges[0].src).toBe('broadcast');
    expect(['onChangedA', 'onChangedB']).toContain(edges[0].tgt);
  });
});

// ---------------------------------------------------------------------------
// Receiver paths — multi-segment handler chains
// ---------------------------------------------------------------------------

/**
 * A project where the SAME member name exists under two different owners, so
 * the receiver path is the only thing that can tell them apart:
 *
 *   src/toolbox/frame-tools.ts   frameTools  = { grabFrame, probeStream }
 *   src/legacy/legacy-tools.ts   legacyTools = { grabFrame, probeStream }
 *
 * A bare project-wide lookup on `grabFrame` sees two candidates and must
 * abstain; `…frameTools.grabFrame` names which one.
 */
function writeToolboxProject(): void {
  write(
    'src/toolbox/frame-tools.ts',
    `export const frameTools = {
  grabFrame(): void {
    void 0;
  },
  probeStream(): void {
    void 0;
  },
};
`
  );
  write(
    'src/legacy/legacy-tools.ts',
    `export const legacyTools = {
  grabFrame(): void {
    void 0;
  },
  probeStream(): void {
    void 0;
  },
};
`
  );
  write(
    'src/media/capture.ts',
    `export function capture(): void {
  $hub.send('media.grabFrame');
}

export function probe(): void {
  $hub.send('media.probeStream');
}
`
  );
}

const HUB_CONFIG = {
  plugins: { 'event-bus': { objects: ['$hub'], dispatch: ['send'], subscribe: ['on'] } },
};

describe('event-bus plugin receiver paths', () => {
  it('resolves a deep chain by its owner segment, and a this-prefixed one too', async () => {
    writeToolboxProject();
    write(
      'src/panels/preview-panel.ts',
      `export class PreviewPanel {
  root: any;

  register(): void {
    // this-prefixed deep chain — the leading \`this\` is skipped, \`frameTools\`
    // is what picks the right \`grabFrame\`.
    $hub.on('media.grabFrame', this.root.frameTools.grabFrame);
  }
}

export function registerProbe(workspace: any): void {
  // Deep chain with NO leading \`this\`.
  $hub.on('media.probeStream', workspace.tools.frameTools.probeStream);
}
`
    );
    writeConfig(HUB_CONFIG);

    const { cg, rows } = await index();
    const edges = rows(BUS_EDGE_SQL);
    const grabFrames = rows(
      `SELECT file_path FROM nodes WHERE name = 'grabFrame' AND kind IN ('function','method')`
    );
    cg.close?.();

    // The fixture is only meaningful if the bare name really is ambiguous —
    // otherwise the plain project-wide tier would answer and the receiver path
    // would be doing nothing.
    expect(grabFrames.length).toBe(2);

    const pairs = edges.map((r: any) => `${r.src}>${r.tgt}@${r.tgt_file}`);
    expect(pairs).toContain('capture>grabFrame@src/toolbox/frame-tools.ts');
    expect(pairs).toContain('probe>probeStream@src/toolbox/frame-tools.ts');
    // The same-named members of the OTHER owner are never touched.
    expect(pairs.some((p: string) => p.includes('legacy-tools'))).toBe(false);
  });

  it('abstains when the owner segment cannot single a candidate out', async () => {
    // Both owners are called `shared`, so `…shared.doTask` narrows to two.
    write(
      'src/one/shared-one.ts',
      `export const shared = {
  doTask(): void {
    void 0;
  },
};
`
    );
    write(
      'src/two/shared-two.ts',
      `export const shared = {
  doTask(): void {
    void 0;
  },
};
`
    );
    write(
      'src/wire.ts',
      `export class Wiring {
  root: any;

  register(): void {
    $hub.on('task.run', this.root.shared.doTask);
  }
}
`
    );
    write(
      'src/fire.ts',
      `export function fire(): void {
  $hub.send('task.run');
}
`
    );
    writeConfig(HUB_CONFIG);

    const { cg, rows } = await index();
    const edges = rows(BUS_EDGE_SQL);
    cg.close?.();
    expect(edges).toEqual([]);
  });

  it('abstains on a chain longer than the depth cap', async () => {
    writeToolboxProject();
    write(
      'src/panels/deep-panel.ts',
      `export class DeepPanel {
  root: any;

  register(): void {
    // 7 segments — past the default cap of 5, so the scanner never registers
    // it and certainly never guesses at a suffix of it.
    $hub.on('media.grabFrame', this.root.a.b.c.frameTools.grabFrame);
  }
}
`
    );
    writeConfig(HUB_CONFIG);

    const { cg, rows } = await index();
    const edges = rows(BUS_EDGE_SQL);
    cg.close?.();
    expect(edges).toEqual([]);
  });

  it('lets maxHandlerChainDepth widen the cap, and narrow it back to today', async () => {
    writeToolboxProject();
    write(
      'src/panels/preview-panel.ts',
      `export class PreviewPanel {
  root: any;

  register(): void {
    $hub.on('media.grabFrame', this.root.frameTools.grabFrame);
  }
}
`
    );

    // Depth 2 restores exactly the pre-chain coverage: `this.grabFrame` would
    // still work, this 4-segment expression no longer does.
    writeConfig({
      plugins: {
        'event-bus': {
          objects: ['$hub'],
          dispatch: ['send'],
          subscribe: ['on'],
          maxHandlerChainDepth: 2,
        },
      },
    });
    const narrow = await index();
    const narrowEdges = narrow.rows(BUS_EDGE_SQL);
    narrow.cg.close?.();
    expect(narrowEdges).toEqual([]);

    // The default (5) accepts it.
    fs.rmSync(path.join(dir, '.codegraph'), { recursive: true, force: true });
    writeConfig(HUB_CONFIG);
    clearProjectConfigCache();
    clearPluginConfigCache();
    resetEventBusPluginState();

    const wide = await index();
    const wideEdges = wide.rows(BUS_EDGE_SQL);
    wide.cg.close?.();
    expect(wideEdges.map((r: any) => `${r.src}>${r.tgt}`)).toEqual(['capture>grabFrame']);
  });

  it('still ignores an inline handler, however deep the expression around it', async () => {
    writeToolboxProject();
    write(
      'src/panels/inline-panel.ts',
      `export class InlinePanel {
  root: any;

  register(): void {
    $hub.on('media.grabFrame', () => this.root.frameTools.grabFrame());
    $hub.on('media.probeStream', async value => {
      await this.root.frameTools.probeStream(value);
    });
  }
}
`
    );
    writeConfig(HUB_CONFIG);

    const { cg, rows } = await index();
    const edges = rows(BUS_EDGE_SQL);
    cg.close?.();
    // An anonymous body has no node to point at — the chain INSIDE it is not a
    // registration, and must not be mistaken for one.
    expect(edges).toEqual([]);
  });

  it('keeps every previously-supported handler shape resolving', async () => {
    write(
      'src/store.ts',
      `export const store = {
  list(): void {
    void 0;
  },
};
`
    );
    write(
      'src/controller.ts',
      `import { store } from './store';

export function onPlain(): void {
  void 0;
}

export class Controller {
  register(): void {
    $hub.on('shape.plain', onPlain);
    $hub.on('shape.member', this.onMember);
    $hub.on('shape.bound', this.onBound.bind(this));
    $hub.on('shape.receiver', store.list, store);
    $hub.on('shape.inline', (value: string) => void value);
  }

  onMember(): void {
    void 0;
  }

  onBound(): void {
    void 0;
  }
}
`
    );
    write(
      'src/fire.ts',
      `export function fireAll(): void {
  $hub.send('shape.plain');
  $hub.send('shape.member');
  $hub.send('shape.bound');
  $hub.send('shape.receiver');
  $hub.send('shape.inline');
}
`
    );
    writeConfig(HUB_CONFIG);

    const { cg, rows } = await index();
    const edges = rows(BUS_EDGE_SQL);
    cg.close?.();

    const targets = edges.map((r: any) => r.tgt).sort();
    expect(targets).toEqual(['list', 'onBound', 'onMember', 'onPlain']);
    expect(edges.every((r: any) => r.src === 'fireAll')).toBe(true);
  });

  it('refuses to answer a this-member handler with an unrelated project-wide symbol', async () => {
    // `this.syncTasks` is a member of the registering object. A same-named
    // function in a different module is a coincidence, and pairing them would
    // fabricate a hop into the wrong file.
    write(
      'src/jobs/job-controller.ts',
      `export class JobController {
  register(): void {
    $hub.on('jobs.sync', this.syncTasks, this);
    $hub.on('jobs.flush', this.flushTasks.bind(this));
  }
}
`
    );
    write(
      'src/reporting/report-tools.ts',
      `export function syncTasks(): void {
  void 0;
}

export function flushTasks(): void {
  void 0;
}
`
    );
    write(
      'src/jobs/job-caller.ts',
      `export function runSync(): void {
  $hub.send('jobs.sync');
}

export function runFlush(): void {
  $hub.send('jobs.flush');
}
`
    );
    writeConfig(HUB_CONFIG);

    const { cg, rows } = await index();
    const edges = rows(BUS_EDGE_SQL);
    cg.close?.();
    expect(edges).toEqual([]);
  });

  it('resolves a this-member handler that really is in the registering file', async () => {
    // The same shape as above, but the member exists where `this` says it does.
    write(
      'src/jobs/job-controller.ts',
      `export class JobController {
  register(): void {
    $hub.on('jobs.sync', this.syncTasks, this);
  }

  syncTasks(): void {
    void 0;
  }
}
`
    );
    write(
      'src/jobs/job-caller.ts',
      `export function runSync(): void {
  $hub.send('jobs.sync');
}
`
    );
    writeConfig(HUB_CONFIG);

    const { cg, rows } = await index();
    const edges = rows(BUS_EDGE_SQL);
    cg.close?.();
    expect(edges.map((r: any) => `${r.src}>${r.tgt}`)).toEqual(['runSync>syncTasks']);
  });
});

// ---------------------------------------------------------------------------
// Non-interference — the two invariants that matter most
// ---------------------------------------------------------------------------

describe('event-bus plugin non-interference', () => {
  it('changes nothing about a project that does not configure it', async () => {
    writeProject();

    // Pass 1: no codegraph.json at all.
    const first = await index();
    const baselineEdges = first.rows(
      `SELECT s.name src, t.name tgt, e.kind, e.line, e.provenance, e.metadata
       FROM edges e JOIN nodes s ON s.id = e.source JOIN nodes t ON t.id = e.target
       ORDER BY src, tgt, e.kind, e.line`
    );
    const baselineNodes = first.rows('SELECT count(*) c FROM nodes')[0].c;
    first.cg.close?.();
    // The bus hop does not exist without the plugin. (The registration site
    // itself, `subscribe` → `onOrderPlaced`, is an ordinary function-as-value
    // reference upstream already resolves — that one must survive untouched.)
    expect(baselineEdges.some((r: any) => r.src === 'place' && r.tgt === 'onOrderPlaced')).toBe(
      false
    );
    expect(
      baselineEdges.some((r: any) => r.src === 'subscribe' && r.tgt === 'onOrderPlaced')
    ).toBe(true);

    // Pass 2: a codegraph.json that configures a DIFFERENT plugin. The
    // event-bus plugin must contribute nothing, byte for byte.
    fs.rmSync(path.join(dir, '.codegraph'), { recursive: true, force: true });
    writeConfig({ plugins: { noop: { label: 'unrelated' } } });
    clearProjectConfigCache();
    clearPluginConfigCache();

    const second = await index();
    const withOtherPlugin = second.rows(
      `SELECT s.name src, t.name tgt, e.kind, e.line, e.provenance, e.metadata
       FROM edges e JOIN nodes s ON s.id = e.source JOIN nodes t ON t.id = e.target
       WHERE s.file_path != 'codegraph.json' AND t.file_path != 'codegraph.json'
       ORDER BY src, tgt, e.kind, e.line`
    );
    second.cg.close?.();
    expect(withOtherPlugin).toEqual(baselineEdges);
    expect(baselineNodes).toBeGreaterThan(0);
  });

  it('leaves the built-in event-emitter synthesizer alone, and never doubles its edges', async () => {
    // `.emit(...)` paired with `.on(...)` is exactly what the built-in
    // synthesizer covers. Our plugin declares the same verbs on purpose.
    write(
      'src/emitter.ts',
      `class Feed {
  emit(_event: string, _payload?: unknown): void {}
  on(_event: string, _handler: unknown): void {}
}

export const feed = new Feed();

export function publish(): void {
  feed.emit('feed.updated');
}

export function onFeedUpdated(): void {
  void 0;
}

export function wireFeed(): void {
  feed.on('feed.updated', onFeedUpdated);
}
`
    );

    const synthSql = `
      SELECT s.name src, t.name tgt
      FROM edges e JOIN nodes s ON s.id = e.source JOIN nodes t ON t.id = e.target
      WHERE json_extract(e.metadata,'$.synthesizedBy') = 'event-emitter'
      ORDER BY src, tgt`;

    // Without the plugin: the built-in synthesizer's baseline.
    const before = await index();
    const builtinBaseline = before.rows(synthSql);
    before.cg.close?.();
    expect(builtinBaseline).toEqual([{ src: 'publish', tgt: 'onFeedUpdated' }]);

    // With the plugin on, declaring `feed` with the SAME emit/on verbs.
    fs.rmSync(path.join(dir, '.codegraph'), { recursive: true, force: true });
    writeConfig({
      plugins: { 'event-bus': { objects: ['feed'], dispatch: ['emit'], subscribe: ['on'] } },
    });
    clearProjectConfigCache();
    clearPluginConfigCache();
    resetEventBusPluginState();

    const after = await index();
    const builtinAfter = after.rows(synthSql);
    const busEdges = after.rows(
      `SELECT s.name src, t.name tgt FROM edges e
       JOIN nodes s ON s.id = e.source JOIN nodes t ON t.id = e.target
       WHERE json_extract(e.metadata,'$.resolvedBy') = 'framework'
         AND json_extract(e.metadata,'$.refName') = 'feed.emit'`
    );
    after.cg.close?.();

    // The built-in pass is byte-identical...
    expect(builtinAfter).toEqual(builtinBaseline);
    // ...and the plugin defers rather than emitting a second edge for the
    // same hop (`deferToBuiltinEmitter`, on by default).
    expect(busEdges).toEqual([]);
  });

  it('takes the pair over when deferToBuiltinEmitter is switched off', async () => {
    write(
      'src/emitter.ts',
      `class Feed {
  emit(_event: string, _payload?: unknown): void {}
  on(_event: string, _handler: unknown): void {}
}

export const feed = new Feed();

export function publish(): void {
  feed.emit('feed.updated');
}

export function onFeedUpdated(): void {
  void 0;
}

export function wireFeed(): void {
  feed.on('feed.updated', onFeedUpdated);
}
`
    );
    writeConfig({
      plugins: {
        'event-bus': {
          objects: ['feed'],
          dispatch: ['emit'],
          subscribe: ['on'],
          deferToBuiltinEmitter: false,
        },
      },
    });

    const { cg, rows } = await index();
    const busEdges = rows(
      `SELECT s.name src, t.name tgt FROM edges e
       JOIN nodes s ON s.id = e.source JOIN nodes t ON t.id = e.target
       WHERE json_extract(e.metadata,'$.resolvedBy') = 'framework'
         AND json_extract(e.metadata,'$.refName') = 'feed.emit'`
    );
    cg.close?.();
    expect(busEdges).toEqual([{ src: 'publish', tgt: 'onFeedUpdated' }]);
  });
});
