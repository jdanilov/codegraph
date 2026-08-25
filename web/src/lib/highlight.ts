/**
 * Syntax highlighting for the source view.
 *
 * highlight.js is loaded **lazily**, in its own chunk: the canvas is the thing
 * that has to paint fast, and the highlighter is only needed once a user opens
 * a node panel. Nothing here is imported at module scope for that reason.
 *
 * `lib/common` (≈37 languages) is deliberate over the full bundle (190+): it is
 * a fraction of the bytes and covers every language codegraph indexes today,
 * with `highlightAuto` as the fallback for anything it doesn't know.
 */
type Engine = typeof import('highlight.js/lib/common').default;

let enginePromise: Promise<Engine | null> | null = null;

/** Load (once) and return the highlighter, or null if the chunk fails to load. */
export function loadHighlighter(): Promise<Engine | null> {
  enginePromise ??= import('highlight.js/lib/common')
    .then((module) => {
      const engine = module.default;
      engine.configure({ ignoreUnescapedHTML: true });
      return engine;
    })
    .catch(() => null);
  return enginePromise;
}

/** File extension → highlight.js language id. Unknown extensions auto-detect. */
const BY_EXTENSION: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  py: 'python',
  pyi: 'python',
  rb: 'ruby',
  go: 'go',
  rs: 'rust',
  java: 'java',
  kt: 'kotlin',
  kts: 'kotlin',
  swift: 'swift',
  cs: 'csharp',
  c: 'c',
  h: 'c',
  cc: 'cpp',
  cpp: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  php: 'php',
  pl: 'perl',
  lua: 'lua',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  sql: 'sql',
  json: 'json',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'ini',
  ini: 'ini',
  md: 'markdown',
  css: 'css',
  scss: 'scss',
  less: 'less',
  html: 'xml',
  xml: 'xml',
  vue: 'xml',
  svelte: 'xml',
  dart: 'dart',
  scala: 'scala',
  ex: 'elixir',
  exs: 'elixir',
  r: 'r',
};

/** Best-guess highlight.js language for a project-relative path. */
export function languageForFile(file: string): string | undefined {
  const extension = file.slice(file.lastIndexOf('.') + 1).toLowerCase();
  return BY_EXTENSION[extension];
}

/**
 * Highlight `code` as HTML with an already-loaded engine.
 *
 * Returns null when there is no engine yet, or when the language is unknown
 * *and* auto-detection isn't confident — the caller then renders escaped plain
 * text, which is the correct degraded state rather than a wrong colouring.
 */
export function highlightWith(engine: Engine | null, code: string, file: string): string | null {
  if (!engine || !code) return null;
  const language = languageForFile(file);
  try {
    if (language && engine.getLanguage(language)) {
      return engine.highlight(code, { language, ignoreIllegals: true }).value;
    }
    const auto = engine.highlightAuto(code);
    return auto.relevance > 4 ? auto.value : null;
  } catch {
    return null;
  }
}

/** Escape text for the `dangerouslySetInnerHTML` path used when highlighting is off. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Split highlight.js output into one HTML string PER SOURCE LINE.
 *
 * A bubble lays its body out as one grid row per logical line, so that a long
 * line can WRAP inside its own row and the gutter number beside it still points
 * at the line it belongs to. That needs the highlighted HTML split at every
 * newline — and highlight.js emits spans that freely cross newlines (a block
 * comment, a template literal, a multi-line string are all one span), so a
 * naive `split('\n')` produces rows with unbalanced tags: the browser closes
 * them at the row boundary and every following row loses its colour.
 *
 * The fix is the standard one: carry the open-span STACK across the break.
 * At each newline every open span is closed, the line is emitted, and the same
 * stack is re-opened verbatim at the start of the next one. The result is
 * per-line HTML that is individually balanced and, concatenated with newlines
 * between the rows, renders exactly the text the highlighter was given.
 *
 * Tag-shape-agnostic on purpose: anything that is not `</…>` and does not
 * self-close pushes, `</…>` pops. hljs only ever emits `<span>`, but a build
 * that emitted something else would degrade to "one extra wrapper re-opened"
 * rather than to broken markup.
 *
 * Pure and total. Text outside tags is copied through untouched — it is
 * already escaped by the highlighter, and re-escaping it would double every
 * entity in the body.
 */
export function splitHighlightedLines(html: string): string[] {
  const lines: string[] = [];
  const open: string[] = [];
  let current = '';
  let index = 0;

  /** Close every open span, emit the row, and re-open the same stack. */
  const breakLine = (): void => {
    for (let i = 0; i < open.length; i++) current += '</span>';
    lines.push(current);
    current = open.join('');
  };

  /** Copy a run of text, breaking the row at every newline inside it. */
  const text = (run: string): void => {
    let start = 0;
    for (;;) {
      const at = run.indexOf('\n', start);
      if (at < 0) {
        current += run.slice(start);
        return;
      }
      current += run.slice(start, at);
      breakLine();
      start = at + 1;
    }
  };

  while (index < html.length) {
    const next = html.indexOf('<', index);
    if (next < 0) {
      text(html.slice(index));
      break;
    }
    if (next > index) text(html.slice(index, next));
    const close = html.indexOf('>', next);
    if (close < 0) {
      // A `<` with no `>` after it is not a tag — it is text the highlighter
      // would have escaped — so it is copied rather than swallowing the rest.
      text(html.slice(next));
      break;
    }
    const tag = html.slice(next, close + 1);
    current += tag;
    if (tag.startsWith('</')) open.pop();
    else if (!tag.endsWith('/>')) open.push(tag);
    index = close + 1;
  }
  lines.push(current);
  return lines;
}
