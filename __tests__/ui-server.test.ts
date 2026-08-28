/**
 * Visualizer server (`codegraph ui`) — route contract tests.
 *
 * Covers the shapes `docs/design/visualizer.md` fixes: `contains` never appears
 * in `edges` (it is the `parent` backbone), `dataVersion` drives the graph
 * ETag, un-indexed roots answer without erroring, later-phase endpoints answer
 * the contract's shape (explore/ask/changes included), and no served path
 * escapes the project root.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';

import CodeGraph from '../src/index';
import { startUiServer, type UiServer } from '../src/ui-server';
import { collectChanges, MAX_HUNK_LINES } from '../src/ui-server/changes';
import { mergeSettings, settingsView } from '../src/ui-server/settings';
import { normalizeSymbolBag } from '../src/ui-server/ask';

let projectRoot: string;
let emptyRoot: string;
let gitRoot: string;
let server: UiServer;
let emptyServer: UiServer;
let gitServer: UiServer;

/** `mode=diff` needs a real git; skip those cases on a machine without one. */
const hasGit = (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

async function getJson(base: string, route: string, init?: RequestInit): Promise<{ status: number; body: any; headers: Headers }> {
  const response = await fetch(`${base}${route}`, init);
  const text = await response.text();
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: response.status, body, headers: response.headers };
}

beforeAll(async () => {
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-ui-'));
  fs.mkdirSync(path.join(projectRoot, 'src'), { recursive: true });
  fs.writeFileSync(
    path.join(projectRoot, 'src', 'alpha.ts'),
    'export function alpha(): number {\n  return beta() + 1;\n}\n\nexport function beta(): number {\n  return 41;\n}\n'
  );

  const graph = await CodeGraph.init(projectRoot, { index: false });
  await graph.indexAll();
  graph.destroy();

  emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-ui-empty-'));

  // A git-backed fixture for `mode=diff`: one committed file with uncommitted
  // edits near the top and untouched lines further down, plus an untracked one.
  gitRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-ui-git-'));
  if (hasGit) {
    fs.mkdirSync(path.join(gitRoot, 'src'), { recursive: true });
    const committed = ['export function tracked(): number {', '  return 1;', '}', ''];
    for (let line = 4; line < 60; line++) committed.push(`// filler ${line}`);
    fs.writeFileSync(path.join(gitRoot, 'src', 'tracked.ts'), committed.join('\n') + '\n');
    const git = (...args: string[]): void => {
      execFileSync('git', args, { cwd: gitRoot, stdio: 'ignore' });
    };
    git('init', '-q');
    git('config', 'user.email', 'test@example.invalid');
    git('config', 'user.name', 'Test');
    git('config', 'commit.gpgsign', 'false');
    git('add', '-A');
    git('-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'initial');

    const edited = [...committed];
    edited[1] = '  return 2;';
    edited.splice(2, 0, '  // a new line');
    fs.writeFileSync(path.join(gitRoot, 'src', 'tracked.ts'), edited.join('\n') + '\n');
    fs.writeFileSync(path.join(gitRoot, 'src', 'fresh.ts'), 'export const fresh = 1;\nexport const other = 2;\n');
  }

  server = await startUiServer({ projectRoot, port: 0 });
  emptyServer = await startUiServer({ projectRoot: emptyRoot, port: 0 });
  gitServer = await startUiServer({ projectRoot: gitRoot, port: 0 });
}, 120_000);

afterAll(async () => {
  await server?.close();
  await emptyServer?.close();
  await gitServer?.close();
  for (const dir of [projectRoot, emptyRoot, gitRoot]) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
});

describe('GET /api/status', () => {
  it('reports an indexed project', async () => {
    const { status, body } = await getJson(server.url, '/api/status');
    expect(status).toBe(200);
    expect(body.indexed).toBe(true);
    expect(body.root).toBe(projectRoot);
    expect(body.nodeCount).toBeGreaterThan(0);
    expect(typeof body.dataVersion).toBe('number');
  });

  it('reports an un-indexed root without erroring', async () => {
    const { status, body } = await getJson(emptyServer.url, '/api/status');
    expect(status).toBe(200);
    expect(body.indexed).toBe(false);
    expect(body.nodeCount).toBe(0);
  });
});

describe('GET /api/graph', () => {
  it('expresses contains through parent, never as an edge', async () => {
    const { status, body } = await getJson(server.url, '/api/graph');
    expect(status).toBe(200);
    expect(body.nodes.length).toBeGreaterThan(0);
    expect(body.edges.some((edge: { kind: string }) => edge.kind === 'contains')).toBe(false);

    const file = body.nodes.find((node: { kind: string }) => node.kind === 'file');
    expect(file.parent).toMatch(/^dir:/);

    const alpha = body.nodes.find((node: { name: string }) => node.name === 'alpha');
    expect(alpha.parent).toBe(file.id);
  });

  it('rolls file counts and LoC up the directory tree', async () => {
    const { body } = await getJson(server.url, '/api/graph');
    const root = body.dirs.find((dir: { path: string }) => dir.path === '');
    expect(root.parent).toBeNull();
    expect(root.fileCount).toBeGreaterThan(0);
    expect(root.loc).toBeGreaterThan(0);
  });

  it('answers 304 for a matching ETag, and never across projects', async () => {
    const first = await fetch(`${server.url}/api/graph`);
    const etag = first.headers.get('etag');
    expect(etag).toBeTruthy();
    await first.text();

    const second = await fetch(`${server.url}/api/graph`, {
      headers: { 'If-None-Match': etag as string },
    });
    expect(second.status).toBe(304);

    const stale = await fetch(`${server.url}/api/graph`, {
      headers: { 'If-None-Match': 'W/"v999999"' },
    });
    expect(stale.status).toBe(200);
    await stale.text();

    // Two roots, same loopback origin, same URL, and both start their version
    // counter at 1 — so a version-only ETag would let a browser holding this
    // project's graph revalidate it against the other one and take a 304,
    // redrawing the previous project on a server that has never served it.
    const other = await fetch(`${emptyServer.url}/api/graph`);
    const otherEtag = other.headers.get('etag');
    await other.text();
    expect(otherEtag).not.toBe(etag);

    const crossed = await fetch(`${emptyServer.url}/api/graph`, {
      headers: { 'If-None-Match': etag as string },
    });
    expect(crossed.status).toBe(200);
    const crossedBody = JSON.parse(await crossed.text()) as { root: string };
    expect(crossedBody.root).toBe(emptyServer.projectRoot);
  });

  it('serves an empty payload for an un-indexed root', async () => {
    const { status, body } = await getJson(emptyServer.url, '/api/graph');
    expect(status).toBe(200);
    expect(body.indexed).toBe(false);
    expect(body.nodes).toEqual([]);
  });
});

describe('GET /api/search and /api/node/:id', () => {
  it('finds a symbol and returns its body plus edges', async () => {
    const { body: hits } = await getJson(server.url, '/api/search?q=alpha');
    expect(hits.length).toBeGreaterThan(0);
    const hit = hits.find((entry: { name: string }) => entry.name === 'alpha');
    expect(hit).toBeTruthy();

    const { status, body } = await getJson(server.url, `/api/node/${encodeURIComponent(hit.id)}`);
    expect(status).toBe(200);
    expect(body.node.name).toBe('alpha');
    expect(body.source.content).toContain('function alpha');
    expect(body.outgoing.some((edge: { kind: string }) => edge.kind === 'calls')).toBe(true);
  });

  it('404s an unknown node id', async () => {
    const { status, body } = await getJson(server.url, '/api/node/does-not-exist');
    expect(status).toBe(404);
    expect(body.error.code).toBe('not_found');
  });
});

describe('GET /api/source', () => {
  it('returns the requested span', async () => {
    const { status, body } = await getJson(server.url, '/api/source?file=src/alpha.ts&start=1&end=2');
    expect(status).toBe(200);
    expect(body.mode).toBe('full');
    expect(body.startLine).toBe(1);
    expect(body.endLine).toBe(2);
    expect(body.content.split('\n')).toHaveLength(2);
  });

  it('refuses a path that escapes the project root', async () => {
    const { status, body } = await getJson(server.url, '/api/source?file=../../etc/hosts');
    expect(status).toBe(403);
    expect(body.error.code).toBe('forbidden');
  });

  it('409s diff mode on a root that is not a git work tree', async () => {
    const { status, body } = await getJson(server.url, '/api/source?file=src/alpha.ts&mode=diff');
    expect(status).toBe(409);
    expect(body.error.code).toBe('conflict');
    // The 409 still carries the diff shape, so a client has one parse path.
    expect(body.git).toBe(false);
    expect(body.hunks).toEqual([]);
  });
});

describe('GET /api/source?mode=diff', () => {
  it.runIf(hasGit)('returns hunks overlapping the span for a modified file', async () => {
    const { status, body } = await getJson(gitServer.url, '/api/source?file=src/tracked.ts&start=1&end=6&mode=diff');
    expect(status).toBe(200);
    expect(body.mode).toBe('diff');
    expect(body.git).toBe(true);
    expect(body.status).toBe('modified');
    expect(body.hunks.length).toBeGreaterThan(0);
    const kinds = body.hunks.flatMap((hunk: any) => hunk.lines.map((line: any) => line.type));
    expect(kinds).toContain('add');
    expect(kinds).toContain('del');
    const hunk = body.hunks[0];
    expect(typeof hunk.oldStart).toBe('number');
    expect(typeof hunk.newLines).toBe('number');
  });

  it.runIf(hasGit)('reports the whole span as added for an untracked file', async () => {
    const { status, body } = await getJson(gitServer.url, '/api/source?file=src/fresh.ts&start=1&end=3&mode=diff');
    expect(status).toBe(200);
    expect(body.status).toBe('untracked');
    expect(body.hunks).toHaveLength(1);
    expect(body.hunks[0].oldLines).toBe(0);
    expect(body.hunks[0].lines.every((line: any) => line.type === 'add')).toBe(true);
  });

  it.runIf(hasGit)('returns no hunks for a span that nothing touched', async () => {
    const { status, body } = await getJson(
      gitServer.url,
      '/api/source?file=src/tracked.ts&start=40&end=60&mode=diff'
    );
    expect(status).toBe(200);
    expect(body.hunks).toEqual([]);
    expect(body.hunksOutsideSpan).toBeGreaterThan(0);
  });

  it.runIf(hasGit)('returns every hunk when no span is given', async () => {
    const { status, body } = await getJson(gitServer.url, '/api/source?file=src/tracked.ts&mode=diff');
    expect(status).toBe(200);
    expect(body.hunks.length).toBeGreaterThan(0);
    expect(body.hunksOutsideSpan).toBe(0);
  });

  it.runIf(hasGit)('refuses a path that escapes the project root', async () => {
    const { status } = await getJson(gitServer.url, '/api/source?file=../../etc/hosts&mode=diff');
    expect(status).toBe(403);
  });
});

describe('cards and settings', () => {
  it('round-trips cards through .codegraph/ui/cards.json', async () => {
    const cards = [{ id: 'card-1', question: 'how does alpha reach beta?', createdAt: 1 }];
    const put = await getJson(server.url, '/api/cards', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cards),
    });
    expect(put.status).toBe(200);

    const { body } = await getJson(server.url, '/api/cards');
    expect(body).toEqual(cards);
    expect(fs.existsSync(path.join(projectRoot, '.codegraph', 'ui', 'cards.json'))).toBe(true);
  });

  it('rejects a malformed cards body', async () => {
    const { status } = await getJson(server.url, '/api/cards', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nope: true }),
    });
    expect(status).toBe(400);
  });

  it('masks the API key when reading settings back', () => {
    const view = settingsView({ anthropicApiKey: 'secret-key-abcd', editorCommand: 'code -g {file}:{line}' });
    expect(view.anthropicApiKey).not.toContain('secret');
    expect(view.anthropicApiKey?.endsWith('abcd')).toBe(true);
    expect(view.anthropicApiKeySet).toBe(true);
  });

  it('keeps the stored key when the masked value is submitted back', () => {
    const merged = mergeSettings({ anthropicApiKey: 'real-key' }, { anthropicApiKey: '••••••••-key' });
    expect(merged.anthropicApiKey).toBe('real-key');
    expect(mergeSettings({ anthropicApiKey: 'real-key' }, { anthropicApiKey: null }).anthropicApiKey).toBeUndefined();
  });
});

describe('POST /api/explore', () => {
  it('answers with the structured shape the contract fixes', async () => {
    const { status, body } = await getJson(server.url, '/api/explore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'alpha beta' }),
    });
    expect(status).toBe(200);
    expect(Array.isArray(body.nodeIds)).toBe(true);
    expect(Array.isArray(body.edgeRefs)).toBe(true);
    expect(Array.isArray(body.flow)).toBe(true);
    expect(typeof body.summary).toBe('string');
    expect(body.nodeIds.length).toBeGreaterThan(0);
  });

  it('resolves every returned id against /api/graph', async () => {
    const graph = await getJson(server.url, '/api/graph');
    const known = new Set<string>([
      ...graph.body.nodes.map((node: any) => node.id),
      ...graph.body.dirs.map((dir: any) => dir.id),
    ]);
    const { body } = await getJson(server.url, '/api/explore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'alpha beta' }),
    });
    for (const id of body.nodeIds) expect(known.has(id)).toBe(true);
    for (const edge of body.edgeRefs) {
      expect(known.has(edge.source)).toBe(true);
      expect(known.has(edge.target)).toBe(true);
    }
  });

  it('rejects an empty query', async () => {
    const { status } = await getJson(server.url, '/api/explore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: '   ' }),
    });
    expect(status).toBe(400);
  });

  // The optional `path` is the same subtree scope the MCP tool takes, so the
  // Ask box can narrow an answer to one folder.
  it('passes an optional `path` scope through to explore', async () => {
    const { status, body } = await getJson(server.url, '/api/explore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'alpha beta', path: 'src' }),
    });
    expect(status).toBe(200);
    expect(body.nodeIds.length).toBeGreaterThan(0);
  });

  it('answers an unusable `path` with guidance, not an error status', async () => {
    const { status, body } = await getJson(server.url, '/api/explore', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'alpha beta', path: 'no-such-folder' }),
    });
    expect(status).toBe(200);
    expect(body.nodeIds).toEqual([]);
    expect(body.summary).toContain('path');
  });
});

describe('POST /api/ask', () => {
  it('501s with the contract shape when no API key is configured', async () => {
    // The key lives in the user's home dir; only assert the no-key branch when
    // this machine genuinely has none (same guard as the /api/open test).
    const settings = await getJson(server.url, '/api/settings');
    if (settings.body.anthropicApiKeySet) return;
    const { status, body } = await getJson(server.url, '/api/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: 'what calls alpha?' }),
    });
    expect(status).toBe(501);
    expect(body.error.code).toBe('not_implemented');
    expect(body.nodeIds).toEqual([]);
    expect(body.flow).toEqual([]);
    expect(body.symbolBag).toBe('');
  });
});

describe('ask — symbol-bag normalization', () => {
  it('keeps identifier-shaped tokens, punctuation stripped', () => {
    // A stray label word costs one of the 16 slots and resolves to nothing —
    // harmless; what matters is that punctuation never reaches the tokenizer.
    expect(normalizeSymbolBag('handleRequest, ItemStore.add; `persistItem`.'))
      .toBe('handleRequest ItemStore.add persistItem');
  });

  it('is idempotent about duplicates and casing collisions', () => {
    expect(normalizeSymbolBag('alpha alpha ALPHA beta')).toBe('alpha beta');
  });

  it('survives a model that answered with prose instead of names', () => {
    expect(normalizeSymbolBag('I am sorry, I cannot help with that!')).not.toContain(',');
  });

  it('caps the bag so one answer can never flood the query', () => {
    const many = Array.from({ length: 40 }, (_, i) => `symbol${i}`).join(' ');
    expect(normalizeSymbolBag(many).split(' ')).toHaveLength(16);
  });
});

describe('GET /api/changes', () => {
  it.runIf(hasGit)('reports every uncommitted status with hunks', async () => {
    const { status, body } = await getJson(gitServer.url, '/api/changes');
    expect(status).toBe(200);
    expect(body.git).toBe(true);
    const byPath = new Map<string, any>(body.changedFiles.map((file: any) => [file.path, file]));
    expect(byPath.get('src/tracked.ts')?.status).toBe('modified');
    expect(byPath.get('src/fresh.ts')?.status).toBe('untracked');
    expect(body.hunks.length).toBeGreaterThan(0);
    expect(body.hunks.every((hunk: any) => typeof hunk.file === 'string')).toBe(true);
    expect(Array.isArray(body.impactedNodeIds)).toBe(true);
  });

  it.runIf(hasGit)('reports per-file added/removed line counts', async () => {
    const { body } = await getJson(gitServer.url, '/api/changes');
    const byPath = new Map<string, any>(body.changedFiles.map((file: any) => [file.path, file]));
    // tracked.ts: one line rewritten (1 add + 1 del) plus one line inserted.
    expect(byPath.get('src/tracked.ts')).toMatchObject({ addedLines: 2, removedLines: 1 });
    // fresh.ts is untracked, so the whole two-line file is "added".
    expect(byPath.get('src/fresh.ts')).toMatchObject({ addedLines: 2, removedLines: 0 });
  });

  it.runIf(hasGit)('counts every line even when the hunk payload is capped', () => {
    // The canvas draws a proportion from these two numbers, so they describe
    // the FILE, not the prefix of it that survived MAX_HUNK_LINES.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-ui-bigdiff-'));
    try {
      const lines = MAX_HUNK_LINES + 500;
      execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'ignore' });
      fs.writeFileSync(
        path.join(root, 'huge.txt'),
        Array.from({ length: lines }, (_, i) => `line ${i}`).join('\n') + '\n'
      );
      const outcome = collectChanges(root, null);
      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      const file = outcome.payload.changedFiles.find((entry) => entry.path === 'huge.txt');
      expect(file?.addedLines).toBe(lines);
      expect(file?.removedLines).toBe(0);
      // …and the payload itself did drop the hunk, which is what makes the
      // count above worth asserting.
      expect(outcome.payload.truncated).toBe(true);
      expect(outcome.payload.hunks).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('409s with the full shape outside a git work tree', async () => {
    const { status, body } = await getJson(server.url, '/api/changes');
    expect(status).toBe(409);
    expect(body.error.code).toBe('conflict');
    expect(body.git).toBe(false);
    expect(body.changedNodes).toEqual([]);
    expect(body.impactedNodeIds).toEqual([]);
    expect(body.hunks).toEqual([]);
  });
});

describe('editor jump', () => {
  it('409s /api/open when no editor command is configured', async () => {
    // The stored template lives in the user's home dir; only assert the
    // no-editor branch when this machine genuinely has none configured.
    const configured = fs.existsSync(path.join(os.homedir(), '.codegraph', 'ui.json'));
    if (configured) return;
    const { status, body } = await getJson(server.url, '/api/open', {
      method: 'POST',
      body: JSON.stringify({ file: 'src/alpha.ts', line: 1 }),
    });
    expect(status).toBe(409);
    expect(body.error.code).toBe('conflict');
  });
});
