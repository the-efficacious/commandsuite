/**
 * File-preview state and dispatch logic.
 *
 * The preview modal is a single global affordance — only one preview
 * is ever open at a time, and any component (a message attachment
 * chip, a file row in the FilesPanel) can request a preview by
 * setting `currentPreview`. The `<FilePreviewModal />` lives at the
 * shell level and renders whenever the signal is non-null.
 *
 * Renderer selection runs MIME-first, then falls back to extension
 * matching for code files (where uploaders frequently set
 * `application/octet-stream` or `text/plain` regardless of the
 * actual language). Each kind has its own size cap; over the cap,
 * the modal shows a "too large to preview" card with a download
 * button instead of trying to render.
 */

import { signal } from '@preact/signals';

/**
 * Metadata-only handle on a previewable file. We accept either an
 * `Attachment` (from a message) or any equivalent shape (from the
 * FilesPanel) — the modal only needs `path`, `name`, `size`,
 * `mimeType`.
 */
export interface PreviewableFile {
  path: string;
  name: string;
  size: number;
  mimeType: string;
}

/** Renderer kinds — each one has its own component in the modal. */
export type RendererKind =
  | 'image'
  | 'pdf'
  | 'audio'
  | 'video'
  | 'markdown'
  | 'code'
  | 'text'
  | 'oversized'
  | 'unsupported';

export interface RendererSelection {
  kind: RendererKind;
  /**
   * Highlighting language for the Code renderer (matches a
   * highlight.js language id). Always present iff `kind === 'code'`.
   */
  language?: string;
}

/**
 * Per-renderer size caps. Above the cap we render the "oversized"
 * fallback (metadata + download link) instead of attempting to load
 * the bytes. PDFs and media stream lazily in the browser, so their
 * caps are mostly a guard against accidentally embedding a 5GB file.
 * Text-flavoured kinds eagerly fetch into a JS string, so the cap
 * is a hard memory ceiling.
 */
export const SIZE_CAPS: Record<RendererKind, number> = {
  image: 25 * 1024 * 1024,
  pdf: 25 * 1024 * 1024,
  audio: 100 * 1024 * 1024,
  video: 200 * 1024 * 1024,
  markdown: 1 * 1024 * 1024,
  code: 1 * 1024 * 1024,
  text: 1 * 1024 * 1024,
  oversized: Number.POSITIVE_INFINITY,
  unsupported: Number.POSITIVE_INFINITY,
};

/**
 * Extension → highlight.js language id. The set is intentionally
 * tight: only languages we expect agents and operators to actually
 * paste/upload. Adding a new entry is cheap (highlight.js's "common"
 * bundle ships with most popular languages built in).
 *
 * HTML/SVG appear here intentionally so they render as
 * **syntax-highlighted source code, not as live HTML**. That closes
 * the door on the riskiest preview category by reframing it.
 */
const CODE_EXTENSION_LANGUAGES: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  py: 'python',
  rb: 'ruby',
  go: 'go',
  rs: 'rust',
  java: 'java',
  kt: 'kotlin',
  swift: 'swift',
  c: 'c',
  h: 'c',
  cpp: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  php: 'php',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  fish: 'shell',
  json: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'ini',
  ini: 'ini',
  xml: 'xml',
  html: 'xml',
  htm: 'xml',
  svg: 'xml',
  css: 'css',
  scss: 'scss',
  less: 'less',
  sql: 'sql',
  proto: 'protobuf',
  graphql: 'graphql',
  gql: 'graphql',
  diff: 'diff',
  patch: 'diff',
  dockerfile: 'dockerfile',
  tf: 'hcl',
  hcl: 'hcl',
  lua: 'lua',
};

function extensionOf(name: string): string {
  // Special-case `Dockerfile` (no extension, content type is the name).
  if (name === 'Dockerfile' || name.endsWith('.Dockerfile')) return 'dockerfile';
  const dot = name.lastIndexOf('.');
  if (dot === -1) return '';
  return name.slice(dot + 1).toLowerCase();
}

/**
 * Select the right renderer for a file. MIME-first dispatch covers
 * the cases where browsers handle the bytes natively (image, pdf,
 * media). Text-flavoured MIMEs and `application/json` fall through
 * to either the Code renderer (when the extension maps to a known
 * language) or the plain Text renderer.
 *
 * Files above the renderer's size cap return the `oversized` kind
 * so the modal can show a polite metadata + download fallback
 * without fetching bytes that wouldn't fit in memory.
 */
export function selectRenderer(file: PreviewableFile): RendererSelection {
  const mime = (file.mimeType ?? '').toLowerCase();
  const ext = extensionOf(file.name);

  // Native-render paths first.
  if (mime.startsWith('image/')) {
    return capped({ kind: 'image' }, file.size);
  }
  if (mime === 'application/pdf') {
    return capped({ kind: 'pdf' }, file.size);
  }
  if (mime.startsWith('audio/')) {
    return capped({ kind: 'audio' }, file.size);
  }
  if (mime.startsWith('video/')) {
    return capped({ kind: 'video' }, file.size);
  }

  // Markdown — by MIME OR by extension (uploaders inconsistently
  // tag .md as text/plain).
  if (
    mime === 'text/markdown' ||
    mime === 'text/x-markdown' ||
    ext === 'md' ||
    ext === 'markdown'
  ) {
    return capped({ kind: 'markdown' }, file.size);
  }

  // Code — extension drives both the dispatch and the highlight
  // grammar. Trumps the plain text renderer below.
  const lang = CODE_EXTENSION_LANGUAGES[ext];
  if (lang) {
    return capped({ kind: 'code', language: lang }, file.size);
  }

  // Plain text catch-all.
  if (mime.startsWith('text/') || mime === 'application/json' || mime === 'application/xml') {
    return capped({ kind: 'text' }, file.size);
  }

  return { kind: 'unsupported' };
}

function capped(sel: RendererSelection, size: number): RendererSelection {
  if (size > SIZE_CAPS[sel.kind]) return { kind: 'oversized' };
  return sel;
}

// ─── Modal-open state ─────────────────────────────────────────────

/**
 * The currently-open preview, or null when the modal is closed.
 * Setting non-null opens the modal; setting null closes it. A single
 * global signal works because only one preview is ever open at once
 * (the modal is full-screen).
 */
export const currentPreview = signal<PreviewableFile | null>(null);

export function openPreview(file: PreviewableFile): void {
  currentPreview.value = file;
}

export function closePreview(): void {
  currentPreview.value = null;
}

/** Test-only reset. */
export function __resetPreviewForTests(): void {
  currentPreview.value = null;
}
