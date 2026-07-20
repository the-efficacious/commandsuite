/**
 * Render the attachments of a message.
 *
 *   Image files → inline thumbnail (click opens the preview modal),
 *                 capped at a sensible display size so a chat doesn't
 *                 become a fullscreen gallery.
 *   Everything else → click-to-preview chip with name, size, and a
 *                 small adjacent download icon. Clicking the chip
 *                 opens the global preview modal; clicking the
 *                 download icon hits `/fs/read/<path>` so the
 *                 browser handles the save.
 *
 * Download URLs hit `/fs/read/<path>` directly so the browser
 * handles the stream (including Content-Disposition, auth via the
 * session cookie, and caching). No SPA-side blob buffering.
 */

import { FS_PATHS } from 'csuite-sdk/protocol';
import type { Attachment } from 'csuite-sdk/types';
import { openPreview } from '../lib/file-preview.js';
import { Download } from './icons/index.js';

export interface MessageAttachmentsProps {
  attachments: Attachment[];
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function isImage(mimeType: string): boolean {
  return mimeType.startsWith('image/');
}

/** File-type glyph for non-image attachments. Pure ASCII to match brand. */
function fileGlyph(mimeType: string): string {
  if (mimeType === 'application/pdf') return '⧉';
  if (mimeType.startsWith('text/')) return '≡';
  if (mimeType.startsWith('audio/')) return '♪';
  if (mimeType.startsWith('video/')) return '▶';
  if (mimeType.startsWith('application/zip')) return '□';
  return '◆';
}

function ImageAttachment({ att }: { att: Attachment }) {
  return (
    <button
      type="button"
      onClick={() => openPreview(att)}
      title={`${att.name} · ${formatSize(att.size)} · click to preview`}
      style="display:inline-block;max-width:min(420px,100%);margin-top:6px;padding:0;border:1px solid var(--rule);border-radius:6px;overflow:hidden;line-height:0;background:transparent;cursor:pointer"
    >
      <img
        src={FS_PATHS.read(att.path)}
        alt={att.name}
        loading="lazy"
        style="display:block;max-width:100%;max-height:320px;width:auto;height:auto;object-fit:contain;background:var(--bg-alt)"
      />
    </button>
  );
}

function FileChip({ att }: { att: Attachment }) {
  return (
    <span style="display:inline-flex;gap:4px;align-items:stretch;margin-top:4px;max-width:360px">
      <button
        type="button"
        onClick={() => openPreview(att)}
        title={`Preview ${att.name}`}
        style="display:inline-flex;gap:8px;align-items:center;padding:8px 10px;background:var(--bg-alt);border:1px solid var(--rule);border-radius:6px;color:var(--ink);font-size:13px;flex:1;min-width:0;text-align:left;cursor:pointer"
      >
        <span
          aria-hidden="true"
          style="font-size:18px;line-height:1;flex-shrink:0;color:var(--steel)"
        >
          {fileGlyph(att.mimeType)}
        </span>
        <span style="flex:1;min-width:0;display:flex;flex-direction:column;gap:2px">
          <span style="font-weight:600;word-break:break-word">{att.name}</span>
          <span style="color:var(--muted);font-size:11px">{formatSize(att.size)}</span>
        </span>
      </button>
      <a
        href={FS_PATHS.read(att.path)}
        download={att.name}
        title={`Download ${att.name}`}
        aria-label={`Download ${att.name}`}
        style="display:inline-flex;align-items:center;justify-content:center;width:32px;background:var(--bg-alt);border:1px solid var(--rule);border-radius:6px;color:var(--graphite);text-decoration:none;flex-shrink:0"
      >
        <Download size={13} aria-hidden="true" />
      </a>
    </span>
  );
}

export function MessageAttachments({ attachments }: MessageAttachmentsProps) {
  if (!attachments || attachments.length === 0) return null;
  return (
    <div style="display:flex;flex-direction:column;gap:2px;margin-top:4px">
      {attachments.map((att) =>
        isImage(att.mimeType) ? (
          <ImageAttachment key={att.path} att={att} />
        ) : (
          <FileChip key={att.path} att={att} />
        ),
      )}
    </div>
  );
}
