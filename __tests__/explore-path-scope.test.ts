/**
 * `codegraph_explore`'s optional `path` argument: a project-relative directory
 * or glob that scopes the whole answer to one subtree.
 *
 * The three things worth pinning:
 *
 *  1. **Scoping is real** — candidate files, the symbols that rank, the emitted
 *     source and the flow endpoints all come from inside the scope, and a
 *     same-named symbol in a sibling package no longer competes.
 *  2. **Omitting `path` changes nothing** — the unscoped answer is the same
 *     answer as before the argument existed.
 *  3. **A bad scope is GUIDANCE, never `isError`.** One `isError: true`
 *     response teaches an agent to abandon codegraph for the rest of the
 *     session, so an outside/typo'd/empty scope answers success-shaped with
 *     how to spell it (the `NotIndexedError` precedent in `tools.ts`).
 *
 * The fixture is a two-package monorepo where BOTH packages define a
 * `formatUser` called from their own `renderProfile` — the shape scoping
 * exists for.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import CodeGraph from '../src/index';
import { ToolHandler, tools } from '../src/mcp/tools';
import { parseExploreScope } from '../src/mcp/explore-scope';

const API_FILE = 'packages/api/src/profile.ts';
const WEB_FILE = 'packages/web/src/profile.ts';

let dir: string;
let cg: CodeGraph;

function write(rel: string, body: string): void {
  const full = path.join(dir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body);
}

async function explore(args: Record<string, unknown>) {
  return new ToolHandler(cg).execute('codegraph_explore', args);
}

async function exploreText(args: Record<string, unknown>): Promise<string> {
  return (await explore(args)).content?.[0]?.text ?? '';
}

/** The response renders a source section for `file`. */
const hasSection = (response: string, file: string): boolean =>
  response.includes('**`' + file + '`');

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-explore-scope-'));

  write(
    API_FILE,
    [
      'export interface ApiUser { id: string; email: string }',
      '',
      'export function formatUser(user: ApiUser): string {',
      '  return `${user.id} <${user.email}>`;',
      '}',
      '',
      'export function renderProfile(user: ApiUser): string {',
      '  return `api-profile: ${formatUser(user)}`;',
      '}',
      '',
    ].join('\n')
  );

  write(
    WEB_FILE,
    [
      'export interface WebUser { name: string; avatar: string }',
      '',
      'export function formatUser(user: WebUser): string {',
      '  return `${user.name}`;',
      '}',
      '',
      'export function renderProfile(user: WebUser): string {',
      '  return `<span>${formatUser(user)}</span>`;',
      '}',
      '',
    ].join('\n')
  );

  cg = CodeGraph.initSync(dir);
  await cg.indexAll();
}, 180_000);

afterAll(() => {
  cg?.destroy();
  if (dir && fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('fixture shape', () => {
  it('both packages define the same two symbols', () => {
    expect(cg.getNodesInFile(API_FILE).map((n) => n.name)).toContain('formatUser');
    expect(cg.getNodesInFile(WEB_FILE).map((n) => n.name)).toContain('formatUser');
  });
});

describe('scoped vs unscoped results', () => {
  it('an unscoped query can surface both packages', async () => {
    const out = await exploreText({ query: 'renderProfile formatUser' });
    expect(hasSection(out, API_FILE)).toBe(true);
    expect(hasSection(out, WEB_FILE)).toBe(true);
  });

  it('a directory scope emits only files under it', async () => {
    const out = await exploreText({ query: 'renderProfile formatUser', path: 'packages/api' });
    expect(hasSection(out, API_FILE)).toBe(true);
    expect(hasSection(out, WEB_FILE)).toBe(false);
    expect(out).not.toContain('packages/web');
  });

  it('the other scope selects the other package — same query, other answer', async () => {
    const out = await exploreText({ query: 'renderProfile formatUser', path: 'packages/web' });
    expect(hasSection(out, WEB_FILE)).toBe(true);
    expect(hasSection(out, API_FILE)).toBe(false);
    expect(out).not.toContain('packages/api');
  });

  it('a glob scope works like a directory scope', async () => {
    const out = await exploreText({ query: 'renderProfile formatUser', path: 'packages/api/**' });
    expect(hasSection(out, API_FILE)).toBe(true);
    expect(hasSection(out, WEB_FILE)).toBe(false);
  });

  it('an absolute path inside the project is accepted', async () => {
    const out = await exploreText({
      query: 'renderProfile formatUser',
      path: path.join(dir, 'packages', 'api'),
    });
    expect(hasSection(out, API_FILE)).toBe(true);
    expect(hasSection(out, WEB_FILE)).toBe(false);
  });

  it('an empty scope is the whole project, not a refusal', async () => {
    const scoped = await exploreText({ query: 'renderProfile formatUser', path: '' });
    const unscoped = await exploreText({ query: 'renderProfile formatUser' });
    expect(scoped).toBe(unscoped);
  });
});

describe('an unusable scope answers with guidance, never isError', () => {
  const bad = [
    ['outside the project', '../../etc'],
    ['absolute and outside the project', '/etc'],
    ['a directory that is not indexed', 'packages/does-not-exist'],
    ['not a string', 42],
  ] as const;

  for (const [label, value] of bad) {
    it(`${label} → success-shaped guidance`, async () => {
      const res = await explore({ query: 'renderProfile formatUser', path: value });
      expect(res.isError).toBeFalsy();
      const text = res.content?.[0]?.text ?? '';
      expect(text).toContain('`path` is a PROJECT-RELATIVE directory');
      expect(text).toContain('omit `path` to search the whole project');
    });
  }

  it('the guidance names the project\'s own top-level directories', async () => {
    const text = await exploreText({ query: 'renderProfile', path: 'nope' });
    expect(text).toContain('`packages`');
  });
});

describe('inputSchema exposure', () => {
  it('codegraph_explore advertises an optional string `path`', () => {
    const explore = tools.find((t) => t.name === 'codegraph_explore');
    expect(explore).toBeDefined();
    const prop = explore!.inputSchema.properties.path as { type?: string; description?: string };
    expect(prop).toBeDefined();
    expect(prop.type).toBe('string');
    expect(prop.description).toMatch(/project-relative/i);
    // Optional: only `query` is required.
    expect(explore!.inputSchema.required).toEqual(['query']);
  });
});

describe('parseExploreScope (unit)', () => {
  const files = ['packages/api/src/a.ts', 'packages/web/src/b.ts', 'README.md'];
  const root = path.resolve('/tmp/project');

  it('normalizes a trailing slash, `./` and backslashes', () => {
    for (const spelling of ['packages/api/', './packages/api', 'packages\\api']) {
      const parsed = parseExploreScope(spelling, root, files);
      expect(parsed.ok).toBe(true);
      if (parsed.ok) {
        expect(parsed.scope.pattern).toBe('packages/api');
        expect(parsed.scope.matches('packages/api/src/a.ts')).toBe(true);
        expect(parsed.scope.matches('packages/web/src/b.ts')).toBe(false);
      }
    }
  });

  it('a prefix never matches a sibling that merely starts with the same letters', () => {
    const parsed = parseExploreScope('packages/api', root, ['packages/api-v2/x.ts', ...files]);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.scope.matches('packages/api-v2/x.ts')).toBe(false);
  });

  it('names a single file as a scope of one', () => {
    const parsed = parseExploreScope('README.md', root, files);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.scope.matches('README.md')).toBe(true);
      expect(parsed.scope.matches('packages/api/src/a.ts')).toBe(false);
    }
  });

  it('refuses a scope that climbs out of the project', () => {
    expect(parseExploreScope('../secrets', root, files).ok).toBe(false);
    expect(parseExploreScope('packages/../../secrets', root, files).ok).toBe(false);
  });
});
