/**
 * One icon per thing the UI can list.
 *
 * Phase F gave the ⌘P results (and every other list of nodes) a per-type glyph,
 * because a flat list of names reads as an undifferentiated wall: the icon is
 * what lets the eye skip straight past the images and configs to the code file
 * it wants. Two lookups, one table each:
 *
 *  - **files** by extension — a `.ts` is code, a `.png` is an image, a `.json`
 *    is config, a `.md` is prose;
 *  - **nodes** by graph kind — a class is not a function is not a route.
 *
 * The mapping lives HERE and nowhere else: the palette, the node panel and the
 * card lists all read it, so a file type can never wear two different icons in
 * two different lists. Icons are lucide's, the only frontend dependency this
 * pass added.
 */
import {
  Binary,
  Blocks,
  Box,
  Braces,
  Brackets,
  Component,
  Database,
  FileCode,
  FileCog,
  FileImage,
  FileJson,
  FileLock,
  FileSpreadsheet,
  FileTerminal,
  FileText,
  FileType,
  Folder,
  Globe,
  Hash,
  Package,
  Palette,
  Route,
  ScrollText,
  Type,
  Variable,
  type LucideIcon,
} from 'lucide-react';

import { DIRECTORY_KIND } from '@/graph/model';

export type { LucideIcon };

/** Extension (no dot, lower-case) → icon. Anything unlisted falls back. */
const EXTENSION_ICONS: Record<string, LucideIcon> = {
  // code
  ts: FileCode,
  tsx: FileCode,
  js: FileCode,
  jsx: FileCode,
  mjs: FileCode,
  cjs: FileCode,
  py: FileCode,
  rb: FileCode,
  go: FileCode,
  rs: FileCode,
  java: FileCode,
  kt: FileCode,
  swift: FileCode,
  c: FileCode,
  h: FileCode,
  cc: FileCode,
  cpp: FileCode,
  hpp: FileCode,
  cs: FileCode,
  php: FileCode,
  dart: FileCode,
  scala: FileCode,
  ex: FileCode,
  exs: FileCode,
  lua: FileCode,
  pas: FileCode,
  pp: FileCode,
  vue: FileCode,
  svelte: FileCode,
  // markup / styling
  html: Globe,
  htm: Globe,
  liquid: Globe,
  css: Palette,
  scss: Palette,
  sass: Palette,
  less: Palette,
  // data / config
  json: FileJson,
  jsonc: FileJson,
  yaml: FileCog,
  yml: FileCog,
  toml: FileCog,
  ini: FileCog,
  env: FileCog,
  conf: FileCog,
  xml: FileCog,
  lock: FileLock,
  sql: Database,
  db: Database,
  csv: FileSpreadsheet,
  tsv: FileSpreadsheet,
  // shell
  sh: FileTerminal,
  bash: FileTerminal,
  zsh: FileTerminal,
  ps1: FileTerminal,
  bat: FileTerminal,
  // prose
  md: ScrollText,
  mdx: ScrollText,
  txt: FileText,
  rst: FileText,
  // images / binary
  png: FileImage,
  jpg: FileImage,
  jpeg: FileImage,
  gif: FileImage,
  webp: FileImage,
  svg: FileImage,
  ico: FileImage,
  wasm: Binary,
  bin: Binary,
};

/** Whole file names that mean more than their extension does. */
const FILENAME_ICONS: Record<string, LucideIcon> = {
  'package.json': Package,
  'package-lock.json': FileLock,
  dockerfile: FileCog,
  makefile: FileTerminal,
  '.gitignore': FileCog,
};

/** NodeKind → icon (the graph's own vocabulary, see `src/types.ts`). */
const KIND_ICONS: Record<string, LucideIcon> = {
  [DIRECTORY_KIND]: Folder,
  module: Package,
  namespace: Package,
  class: Box,
  struct: Box,
  interface: Blocks,
  trait: Blocks,
  protocol: Blocks,
  function: Braces,
  method: Braces,
  property: Hash,
  field: Hash,
  variable: Variable,
  constant: Variable,
  enum: Brackets,
  enum_member: Brackets,
  type_alias: Type,
  union: Type,
  parameter: Variable,
  import: Package,
  export: Package,
  route: Route,
  component: Component,
};

/** Last extension of a path, lower-cased, without the dot. */
function extensionOf(filePath: string): string {
  const base = filePath.slice(filePath.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? '' : base.slice(dot + 1).toLowerCase();
}

/** Icon for a file path — by exact name first, then by extension. */
export function iconForFile(filePath: string): LucideIcon {
  const base = filePath.slice(filePath.lastIndexOf('/') + 1).toLowerCase();
  return FILENAME_ICONS[base] ?? EXTENSION_ICONS[extensionOf(base)] ?? FileText;
}

/**
 * Icon for a graph entry.
 *
 * A directory is a folder and a file is its type; everything else is a symbol,
 * which the node kind describes better than the file it lives in does.
 */
export function iconForNode(kind: string, filePath = ''): LucideIcon {
  if (kind === DIRECTORY_KIND) return Folder;
  if (kind === 'file') return iconForFile(filePath);
  return KIND_ICONS[kind] ?? FileType;
}
