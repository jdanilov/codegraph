/**
 * `FrameworkExtractionResult.reattributeFileScopeRefs` — moving a file's
 * FILE-SCOPE references onto nodes a resolver minted for a construct core
 * doesn't extract.
 *
 * Reference attribution is a stack walked during extraction, with the file node
 * as its floor. A construct core doesn't open a frame for — an object literal
 * whose members are the module's real API — leaves every call inside it
 * attributed to the FILE. A resolver that mints nodes for that construct runs
 * after the walk and can't join the stack, so this flag is how it asks for the
 * attribution to be corrected.
 *
 * The two properties that matter here: the flag is OPT-IN (default off must be
 * byte-identical to before it existed), and refs are MOVED rather than copied
 * (so no edge is duplicated and the reference count is conserved).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { initGrammars, loadGrammarsForLanguages } from '../src/extraction/grammars';
import { extractFromSource } from '../src/extraction/tree-sitter';
import { registerFrameworkResolver } from '../src/resolution/frameworks';
import type { FrameworkResolver } from '../src/resolution/types';
import type { Node } from '../src/types';

const FILE = 'src/mod.js';

/** A module whose real API lives in an object literal core doesn't extract. */
const SOURCE = [
  "const { helper } = deps",           // 1 — file scope, outside the span
  '',                                   // 2
  'ns.api = {',                         // 3  ← span starts
  '  init () {',                        // 4
  '    helper.setup()',                 // 5  ← inside
  '  },',                               // 6
  '  run () {',                         // 7
  '    helper.go()',                    // 8  ← inside
  '  },',                               // 9
  '}',                                  // 10 ← span ends
  '',                                   // 11
  'helper.teardown()',                  // 12 ← file scope, after the span
  '',
].join('\n');

/** Node covering lines 3-10 — the object literal a plugin would mint. */
function spanNode(): Node {
  return {
    id: 'method:test-api-span',
    kind: 'method',
    name: 'api',
    qualifiedName: 'ns.api',
    filePath: FILE,
    language: 'javascript',
    startLine: 3,
    endLine: 10,
    startColumn: 0,
    endColumn: 1,
    updatedAt: Date.now(),
  } as Node;
}

function makeResolver(optIn: boolean): FrameworkResolver {
  return {
    name: 'test-reattribution',
    detect: () => true,
    resolve: () => null,
    extract: () => ({
      nodes: [spanNode()],
      references: [],
      ...(optIn ? { reattributeFileScopeRefs: true } : {}),
    }),
  };
}

function run(optIn: boolean) {
  registerFrameworkResolver(makeResolver(optIn));
  return extractFromSource(FILE, SOURCE, 'javascript', ['test-reattribution']);
}

describe('reattributeFileScopeRefs', () => {
  beforeAll(async () => {
    await initGrammars();
    await loadGrammarsForLanguages(['javascript']);
  });

  // No unregister needed: registerFrameworkResolver replaces by name, and the
  // extraction path only consults resolvers whose name the caller passes in.

  it('leaves attribution untouched when the resolver does not opt in', () => {
    const result = run(false);
    const inSpan = result.unresolvedReferences.filter((r) => r.line >= 3 && r.line <= 10);
    expect(inSpan.length).toBeGreaterThan(0);
    // Default behavior: everything still hangs off the file node.
    for (const ref of inSpan) {
      expect(ref.fromNodeId).toBe(`file:${FILE}`);
    }
  });

  it('moves refs inside the span onto the minted node when opted in', () => {
    const result = run(true);
    const inSpan = result.unresolvedReferences.filter((r) => r.line >= 3 && r.line <= 10);
    expect(inSpan.length).toBeGreaterThan(0);
    for (const ref of inSpan) {
      expect(ref.fromNodeId).toBe('method:test-api-span');
    }
  });

  it('leaves refs outside the span on the file node', () => {
    const result = run(true);
    const outside = result.unresolvedReferences.filter((r) => r.line < 3 || r.line > 10);
    for (const ref of outside) {
      expect(ref.fromNodeId).toBe(`file:${FILE}`);
    }
  });

  it('conserves the reference count — refs are moved, never copied', () => {
    const before = run(false).unresolvedReferences.length;
    const after = run(true).unresolvedReferences.length;
    expect(after).toBe(before);
  });

  it('attributes to the INNERMOST span when spans nest', () => {
    const outer = { ...spanNode(), id: 'method:outer', startLine: 3, endLine: 10 };
    const inner = { ...spanNode(), id: 'method:inner', startLine: 7, endLine: 9 };
    registerFrameworkResolver({
      name: 'test-reattribution',
      detect: () => true,
      resolve: () => null,
      // Outer first, so a naive first-match implementation would pick it.
      extract: () => ({ nodes: [outer, inner], references: [], reattributeFileScopeRefs: true }),
    });
    const result = extractFromSource(FILE, SOURCE, 'javascript', ['test-reattribution']);

    const atLine8 = result.unresolvedReferences.filter((r) => r.line === 8);
    expect(atLine8.length).toBeGreaterThan(0);
    for (const ref of atLine8) expect(ref.fromNodeId).toBe('method:inner');

    const atLine5 = result.unresolvedReferences.filter((r) => r.line === 5);
    expect(atLine5.length).toBeGreaterThan(0);
    for (const ref of atLine5) expect(ref.fromNodeId).toBe('method:outer');
  });
});
