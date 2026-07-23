/**
 * FilePreviewModal — single global preview surface, mounted at the
 * shell level. Reads `currentPreview` from `lib/file-preview.ts`;
 * any component that wants to open a preview just calls
 * `openPreview(file)` and the modal materializes here.
 *
 * Inline-handles the cheap native renderers (image / pdf / audio /
 * video) since they're a single tag each and there's no benefit to
 * code-splitting them. Text/Markdown/Code are pulled in via `lazy()`
 * + `Suspense` so the bundle cost only lands when an operator
 * actually opens that kind of file.
 *
 * The modal frame reuses `RouteModal` for backdrop / close / Escape
 * handling so we get the same dismissal UX as everything else in
 * the shell (Account, Team Settings, etc.).
 */

import { FS_PATHS } from 'csuite-sdk/protocol';
import { lazy, Suspense } from 'preact/compat';
import { useMemo } from 'preact/hooks';
import {
  closePreview,
  currentPreview,
  type PreviewableFile,
  type RendererSelection,
  SIZE_CAPS,
  selectRenderer,
} from '../lib/file-preview.js';
import { Download } from './icons/index.js';
import { TextPreview } from './preview/TextPreview.js';
import { RouteModal } from './RouteModal.js';

// Lazy chunks — only fetched when the operator opens a preview of
// the matching kind. The Markdown chunk pulls `marked` + `dompurify`
// (~30KB gz); the Code chunk pulls `highlight.js/lib/common`
// (~30KB gz). Each chunk loads exactly once per session.
const MarkdownPreviewLazy = lazy(() =>
  import('./preview/MarkdownPreview.js').then((m) => ({ default: m.MarkdownPreview })),
);
const CodePreviewLazy = lazy(() =>
  import('./preview/CodePreview.js').then((m) => ({ default: m.CodePreview })),
);

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function FilePreviewModal() {
  const file = currentPreview.value;
  if (file === null) return null;
  return <PreviewModalInner file={file} />;
}

function PreviewModalInner({ file }: { file: PreviewableFile }) {
  // Recompute selection when the file changes. Cheap; memoized so
  // re-renders from unrelated signals don't re-key the inner
  // components.
  const selection = useMemo(() => selectRenderer(file), [file.path, file.mimeType, file.size]);

  return (
    <RouteModal onClose={closePreview} ariaLabel={`Preview ${file.name}`} size="xl">
      <div style="display:flex;flex-direction:column;height:calc(100vh - 4rem)">
        <header style="display:flex;align-items:flex-start;gap:12px;padding:14px 50px 14px 18px;border-bottom:1px solid var(--rule);flex-shrink:0">
          <div style="flex:1;min-width:0">
            <h2
              class="font-display"
              style="margin:0;font-size:15px;font-weight:700;letter-spacing:-0.01em;color:var(--ink);overflow:hidden;text-overflow:ellipsis;white-space:nowrap"
            >
              {file.name}
            </h2>
            <p style="margin:2px 0 0;font-family:var(--f-mono);font-size:11px;color:var(--muted)">
              {file.mimeType || 'unknown'} · {formatSize(file.size)}
            </p>
          </div>
          <a
            href={FS_PATHS.read(file.path)}
            download={file.name}
            class="btn"
            title={`Download ${file.name}`}
            style="display:inline-flex;align-items:center;gap:6px;font-size:12px;flex-shrink:0;margin-right:8px"
          >
            <Download size={12} aria-hidden="true" />
            Download
          </a>
        </header>
        <div style="flex:1;min-height:0;overflow:auto">
          <PreviewBody file={file} selection={selection} />
        </div>
      </div>
    </RouteModal>
  );
}

function PreviewBody({ file, selection }: { file: PreviewableFile; selection: RendererSelection }) {
  switch (selection.kind) {
    case 'image':
      return (
        <div style="display:flex;align-items:center;justify-content:center;padding:16px;background:var(--ice);min-height:100%">
          <img
            src={FS_PATHS.read(file.path)}
            alt={file.name}
            style="max-width:100%;max-height:calc(100vh - 12rem);object-fit:contain;border:1px solid var(--rule);background:var(--paper)"
          />
        </div>
      );
    case 'pdf':
      return (
        <iframe
          src={FS_PATHS.read(file.path)}
          title={file.name}
          style="display:block;width:100%;height:100%;border:0;background:var(--paper)"
        />
      );
    case 'audio':
      return (
        <div style="display:flex;align-items:center;justify-content:center;padding:32px">
          {/* biome-ignore lint/a11y/useMediaCaption: user-uploaded audio has
              no canonical caption track; we surface filename in the chrome. */}
          <audio controls src={FS_PATHS.read(file.path)} style="width:100%;max-width:520px" />
        </div>
      );
    case 'video':
      return (
        <div style="display:flex;align-items:center;justify-content:center;padding:16px;background:#000;min-height:100%">
          {/* biome-ignore lint/a11y/useMediaCaption: same as audio — uploads have no captions. */}
          <video
            controls
            src={FS_PATHS.read(file.path)}
            style="max-width:100%;max-height:calc(100vh - 10rem)"
          />
        </div>
      );
    case 'text':
      return <TextPreview file={file} />;
    case 'markdown':
      return (
        <Suspense fallback={<p style="color:var(--muted);font-size:13px;padding:16px">Loading…</p>}>
          <MarkdownPreviewLazy file={file} />
        </Suspense>
      );
    case 'code':
      return (
        <Suspense fallback={<p style="color:var(--muted);font-size:13px;padding:16px">Loading…</p>}>
          <CodePreviewLazy file={file} language={selection.language ?? 'plaintext'} />
        </Suspense>
      );
    case 'oversized':
      return (
        <FallbackCard
          file={file}
          message={`This file is too large to preview (over ${formatSize(SIZE_CAPS.text)} for text-style files, larger caps apply per type). Use the Download button above to save it locally.`}
        />
      );
    // 'unsupported' falls through to the default fallback card.
    default:
      return (
        <FallbackCard
          file={file}
          message="No preview is available for this file type. Use the Download button above to open it locally."
        />
      );
  }
}

function FallbackCard({ file, message }: { file: PreviewableFile; message: string }) {
  return (
    <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;padding:48px 24px;gap:12px;text-align:center;color:var(--muted);font-size:13px;line-height:1.5">
      <p style="margin:0">{message}</p>
      <p style="margin:0;font-family:var(--f-mono);font-size:11px;color:var(--muted)">
        {file.mimeType || 'unknown type'} · {formatSize(file.size)}
      </p>
    </div>
  );
}
