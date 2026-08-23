/**
 * Config-selected resolver plugins — the `plugins` section of `codegraph.json`.
 *
 * Three layers under test:
 *   1. Loader: parse/validate/cache the `plugins` section, mirroring the
 *      `exclude` / `includeIgnored` loaders.
 *   2. Helper: `isPluginEnabled` / `getPluginOptions`, the per-plugin cached
 *      accessors every plugin gates itself on (callable from worker threads and
 *      from the reference-resolution hot path).
 *   3. Registry: `detectFrameworks` / `getAllFrameworkResolvers` honor the
 *      `disable` list, and an enabled plugin shows up among the detected
 *      frameworks.
 *
 * The headline invariant: a project with NO `plugins` key behaves exactly as it
 * did before plugins existed — no plugin detected, no built-in dropped. Every
 * malformed-config path degrades with a warning instead of throwing.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  clearProjectConfigCache,
  loadExcludePatterns,
  loadExtensionOverrides,
  loadPluginsConfig,
} from '../src/project-config';
import {
  clearPluginConfigCache,
  getDisabledResolverNames,
  getPluginOptions,
  isPluginEnabled,
} from '../src/resolution/plugins/plugin-config';
import {
  NOOP_PLUGIN_NAME,
  PLUGIN_RESOLVERS,
  getNoopPluginLabel,
  noopPlugin,
} from '../src/resolution/plugins';
import { detectFrameworks, getAllFrameworkResolvers } from '../src/resolution/frameworks';
import type { ResolutionContext } from '../src/resolution/types';

let dir: string;

const writeConfig = (obj: unknown) =>
  fs.writeFileSync(
    path.join(dir, 'codegraph.json'),
    typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2)
  );

/**
 * Minimal context whose project root is the temp dir, so plugin `detect()` and
 * the registry read the config we just wrote. Built-in detection is driven by
 * the `files` / `contents` we hand it, exactly as the resolver sees in prod.
 */
function makeContext(
  files: string[] = [],
  contents: Record<string, string> = {}
): ResolutionContext {
  return {
    getNodesInFile: () => [],
    getNodesByName: () => [],
    getNodesByQualifiedName: () => [],
    getNodesByKind: () => [],
    getNodesByLowerName: () => [],
    getImportMappings: () => [],
    fileExists: (p) => files.includes(p) || p in contents,
    readFile: (p) => contents[p] ?? null,
    getProjectRoot: () => dir,
    getAllFiles: () => files,
  };
}

/** A context that detects Express — a stable built-in to switch off. */
function expressContext(): ResolutionContext {
  return makeContext(['package.json', 'src/app.js'], {
    'package.json': JSON.stringify({ dependencies: { express: '^4.18.0' } }),
  });
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-plugins-'));
  clearProjectConfigCache();
  clearPluginConfigCache();
});

afterEach(() => {
  clearProjectConfigCache();
  clearPluginConfigCache();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('plugins config loader (codegraph.json)', () => {
  it('is empty when there is no codegraph.json (the zero-config default)', () => {
    const cfg = loadPluginsConfig(dir);
    expect(cfg.disabled.size).toBe(0);
    expect(cfg.enabled.size).toBe(0);
    expect(cfg.options).toEqual({});
  });

  it('is empty when codegraph.json carries no plugins key', () => {
    writeConfig({ exclude: ['static/'] });
    const cfg = loadPluginsConfig(dir);
    expect(cfg.disabled.size).toBe(0);
    expect(cfg.enabled.size).toBe(0);
  });

  it('reads the disable list', () => {
    writeConfig({ plugins: { disable: ['express', '  vue  '] } });
    expect([...loadPluginsConfig(dir).disabled].sort()).toEqual(['express', 'vue']);
  });

  it('treats a plugin entry as opt-in and keeps its options', () => {
    writeConfig({ plugins: { 'sample-plugin': { objects: ['a'], depth: 2 } } });
    const cfg = loadPluginsConfig(dir);
    expect(cfg.enabled.has('sample-plugin')).toBe(true);
    expect(cfg.options['sample-plugin']).toEqual({ objects: ['a'], depth: 2 });
  });

  it('accepts a bare boolean toggle in both directions', () => {
    writeConfig({ plugins: { on: true, off: false } });
    const cfg = loadPluginsConfig(dir);
    expect(cfg.enabled.has('on')).toBe(true);
    expect(cfg.options['on']).toEqual({});
    expect(cfg.enabled.has('off')).toBe(false);
    expect(cfg.disabled.has('off')).toBe(true);
  });

  it('honors an explicit "enabled": false inside an options object', () => {
    writeConfig({ plugins: { thing: { enabled: false, depth: 3 } } });
    const cfg = loadPluginsConfig(dir);
    expect(cfg.enabled.has('thing')).toBe(false);
    expect(cfg.disabled.has('thing')).toBe(true);
    expect(cfg.options['thing']).toBeUndefined();
  });

  it('lets disable win over an options entry for the same name', () => {
    writeConfig({ plugins: { disable: ['thing'], thing: { depth: 3 } } });
    const cfg = loadPluginsConfig(dir);
    expect(cfg.enabled.has('thing')).toBe(false);
    expect(cfg.disabled.has('thing')).toBe(true);
    expect(cfg.options['thing']).toBeUndefined();
  });

  it('coexists with the other config keys in one file (shared single parse)', () => {
    writeConfig({
      extensions: { '.foo': 'typescript' },
      exclude: ['static/'],
      plugins: { disable: ['react'] },
    });
    expect(loadExtensionOverrides(dir)).toEqual({ '.foo': 'typescript' });
    expect(loadExcludePatterns(dir)).toEqual(['static/']);
    expect(loadPluginsConfig(dir).disabled.has('react')).toBe(true);
  });

  it('picks up a rewritten config after the cache is cleared', () => {
    writeConfig({ plugins: { thing: true } });
    expect(loadPluginsConfig(dir).enabled.has('thing')).toBe(true);
    writeConfig({ plugins: { other: true } });
    clearProjectConfigCache();
    const cfg = loadPluginsConfig(dir);
    expect(cfg.enabled.has('thing')).toBe(false);
    expect(cfg.enabled.has('other')).toBe(true);
  });
});

describe('plugins config loader — malformed input degrades, never throws', () => {
  const expectEmpty = () => {
    const cfg = loadPluginsConfig(dir);
    expect(cfg.disabled.size).toBe(0);
    expect(cfg.enabled.size).toBe(0);
  };

  it('ignores malformed JSON', () => {
    writeConfig('{ plugins: not valid json ');
    expect(() => loadPluginsConfig(dir)).not.toThrow();
    expectEmpty();
  });

  it('ignores a non-object plugins value', () => {
    writeConfig({ plugins: 'noop' });
    expectEmpty();
  });

  it('ignores an array plugins value', () => {
    writeConfig({ plugins: ['noop'] });
    expectEmpty();
  });

  it('ignores a non-array disable value but keeps sibling entries', () => {
    writeConfig({ plugins: { disable: 'express', thing: true } });
    const cfg = loadPluginsConfig(dir);
    expect(cfg.disabled.size).toBe(0);
    expect(cfg.enabled.has('thing')).toBe(true);
  });

  it('drops non-string / blank disable entries', () => {
    writeConfig({ plugins: { disable: ['express', '', 42, null, '  '] } });
    expect([...loadPluginsConfig(dir).disabled]).toEqual(['express']);
  });

  it('drops a plugin entry whose value is neither object nor boolean', () => {
    writeConfig({ plugins: { bad: 'yes', good: true } });
    const cfg = loadPluginsConfig(dir);
    expect(cfg.enabled.has('bad')).toBe(false);
    expect(cfg.enabled.has('good')).toBe(true);
  });

  it('never lets malformed config break framework detection', () => {
    writeConfig({ plugins: 42 });
    expect(() => detectFrameworks(expressContext())).not.toThrow();
    expect(detectFrameworks(expressContext()).some((f) => f.name === 'express')).toBe(true);
  });
});

describe('plugin-config helper', () => {
  it('reports a plugin off with no config at all', () => {
    expect(isPluginEnabled(dir, NOOP_PLUGIN_NAME)).toBe(false);
    expect(getPluginOptions(dir, NOOP_PLUGIN_NAME)).toEqual({});
  });

  it('reports a plugin on and returns its typed options', () => {
    writeConfig({ plugins: { [NOOP_PLUGIN_NAME]: { label: 'layer chain' } } });
    expect(isPluginEnabled(dir, NOOP_PLUGIN_NAME)).toBe(true);
    expect(getPluginOptions<{ label?: string }>(dir, NOOP_PLUGIN_NAME).label).toBe('layer chain');
    expect(getNoopPluginLabel(dir)).toBe('layer chain');
  });

  it('validates options per plugin: a wrong-typed value falls back, never throws', () => {
    writeConfig({ plugins: { [NOOP_PLUGIN_NAME]: { label: 42 } } });
    expect(isPluginEnabled(dir, NOOP_PLUGIN_NAME)).toBe(true);
    expect(getNoopPluginLabel(dir)).toBeUndefined();
  });

  it('returns a frozen options object (callers must not mutate shared state)', () => {
    writeConfig({ plugins: { [NOOP_PLUGIN_NAME]: { label: 'x' } } });
    const opts = getPluginOptions(dir, NOOP_PLUGIN_NAME);
    expect(Object.isFrozen(opts)).toBe(true);
  });

  it('caches per (projectRoot, plugin) — no filesystem access on a hit', () => {
    writeConfig({ plugins: { [NOOP_PLUGIN_NAME]: { label: 'cached' } } });
    expect(isPluginEnabled(dir, NOOP_PLUGIN_NAME)).toBe(true);

    // Deleting the config would flip the answer on any re-`stat`; a hot-path
    // lookup must not touch the filesystem at all, so the memo still answers.
    fs.rmSync(path.join(dir, 'codegraph.json'));
    for (let i = 0; i < 50; i++) {
      expect(isPluginEnabled(dir, NOOP_PLUGIN_NAME)).toBe(true);
      expect(getNoopPluginLabel(dir)).toBe('cached');
    }

    // ...and the memo is not permanent: an explicit clear re-reads.
    clearProjectConfigCache();
    expect(isPluginEnabled(dir, NOOP_PLUGIN_NAME)).toBe(false);
  });

  it('invalidates its cache through clearProjectConfigCache()', () => {
    expect(isPluginEnabled(dir, NOOP_PLUGIN_NAME)).toBe(false);
    writeConfig({ plugins: { [NOOP_PLUGIN_NAME]: { label: 'later' } } });
    clearProjectConfigCache();
    expect(isPluginEnabled(dir, NOOP_PLUGIN_NAME)).toBe(true);
    expect(getNoopPluginLabel(dir)).toBe('later');
  });

  it('keeps two project roots independent in one process', () => {
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-plugins-other-'));
    try {
      writeConfig({ plugins: { [NOOP_PLUGIN_NAME]: { label: 'here' } } });
      expect(isPluginEnabled(dir, NOOP_PLUGIN_NAME)).toBe(true);
      expect(isPluginEnabled(other, NOOP_PLUGIN_NAME)).toBe(false);
      expect(getNoopPluginLabel(other)).toBeUndefined();
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });

  it('exposes the disable list to the registry', () => {
    writeConfig({ plugins: { disable: ['express'] } });
    expect(getDisabledResolverNames(dir).has('express')).toBe(true);
    expect(getDisabledResolverNames(dir).has('react')).toBe(false);
  });
});

describe('framework registry — plugin wiring', () => {
  it('registers every in-tree plugin exactly once, with a unique name', () => {
    const all = getAllFrameworkResolvers();
    const names = all.map((r) => r.name);
    expect(new Set(names).size).toBe(names.length);
    for (const plugin of PLUGIN_RESOLVERS) {
      expect(names.filter((n) => n === plugin.name)).toHaveLength(1);
    }
    expect(names).toContain(NOOP_PLUGIN_NAME);
  });

  it('is a no-op with no config: no plugin detected, no built-in dropped', () => {
    const detected = detectFrameworks(expressContext()).map((r) => r.name);
    expect(detected).toContain('express');
    expect(detected).not.toContain(NOOP_PLUGIN_NAME);
    for (const plugin of PLUGIN_RESOLVERS) {
      expect(detected).not.toContain(plugin.name);
    }
  });

  it('is a no-op with a codegraph.json that has no plugins key', () => {
    writeConfig({ exclude: ['static/'] });
    const detected = detectFrameworks(expressContext()).map((r) => r.name);
    expect(detected).toContain('express');
    expect(detected).not.toContain(NOOP_PLUGIN_NAME);
  });

  it('returns the identical registry array when no project root is given', () => {
    expect(getAllFrameworkResolvers()).toBe(getAllFrameworkResolvers());
  });

  it('enabling a plugin makes it appear among the detected frameworks', () => {
    writeConfig({ plugins: { [NOOP_PLUGIN_NAME]: {} } });
    const detected = detectFrameworks(makeContext()).map((r) => r.name);
    expect(detected).toContain(NOOP_PLUGIN_NAME);
  });

  it('an enabled plugin still resolves nothing (it is a no-op by design)', () => {
    writeConfig({ plugins: { [NOOP_PLUGIN_NAME]: true } });
    const context = makeContext();
    expect(noopPlugin.detect(context)).toBe(true);
    expect(
      noopPlugin.resolve(
        {
          fromNodeId: 'n1',
          referenceName: 'anything',
          referenceKind: 'calls',
          line: 1,
          column: 0,
          filePath: 'src/a.ts',
          language: 'typescript',
        },
        context
      )
    ).toBeNull();
  });

  it('disabling a plugin by name beats its own opt-in entry', () => {
    writeConfig({ plugins: { disable: [NOOP_PLUGIN_NAME], [NOOP_PLUGIN_NAME]: {} } });
    const detected = detectFrameworks(makeContext()).map((r) => r.name);
    expect(detected).not.toContain(NOOP_PLUGIN_NAME);
  });

  it('disabling a built-in removes it from detectFrameworks', () => {
    const before = detectFrameworks(expressContext()).map((r) => r.name);
    expect(before).toContain('express');

    writeConfig({ plugins: { disable: ['express'] } });
    clearProjectConfigCache();
    const after = detectFrameworks(expressContext()).map((r) => r.name);
    expect(after).not.toContain('express');
  });

  it('disabling one built-in leaves every other resolver alone', () => {
    writeConfig({ plugins: { disable: ['express'] } });
    const all = getAllFrameworkResolvers(dir).map((r) => r.name);
    const unfiltered = getAllFrameworkResolvers().map((r) => r.name);
    expect(all).not.toContain('express');
    expect(all).toEqual(unfiltered.filter((n) => n !== 'express'));
  });

  it('ignores an unknown name in the disable list', () => {
    writeConfig({ plugins: { disable: ['not-a-real-resolver'] } });
    const detected = detectFrameworks(expressContext()).map((r) => r.name);
    expect(detected).toContain('express');
  });
});
