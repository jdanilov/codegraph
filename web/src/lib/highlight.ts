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
