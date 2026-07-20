/**
 * Tests for the file-preview renderer dispatch.
 *
 * The dispatch is the part most likely to silently regress as new
 * MIME types or extensions get added — these tests pin the cases
 * we actively rely on (image/pdf/media native rendering, markdown
 * by both MIME and extension, code by extension across common
 * languages, plain-text fallback, oversized cap, unsupported
 * fallback).
 */

import { describe, expect, it } from 'vitest';
import { SIZE_CAPS, selectRenderer } from '../src/lib/file-preview.js';

function file(
  name: string,
  mimeType: string,
  size = 100,
): {
  path: string;
  name: string;
  size: number;
  mimeType: string;
} {
  return { path: `/alice/uploads/${name}`, name, size, mimeType };
}

describe('selectRenderer', () => {
  it('dispatches images by MIME prefix', () => {
    expect(selectRenderer(file('photo.png', 'image/png'))).toEqual({ kind: 'image' });
    expect(selectRenderer(file('photo.webp', 'image/webp'))).toEqual({ kind: 'image' });
  });

  it('dispatches PDFs by exact MIME', () => {
    expect(selectRenderer(file('spec.pdf', 'application/pdf'))).toEqual({ kind: 'pdf' });
  });

  it('dispatches audio + video by MIME prefix', () => {
    expect(selectRenderer(file('clip.mp3', 'audio/mpeg'))).toEqual({ kind: 'audio' });
    expect(selectRenderer(file('clip.mp4', 'video/mp4'))).toEqual({ kind: 'video' });
  });

  it('dispatches markdown by MIME or extension', () => {
    expect(selectRenderer(file('readme.md', 'text/markdown'))).toEqual({ kind: 'markdown' });
    // Uploaders frequently set .md files as text/plain — extension wins.
    expect(selectRenderer(file('readme.md', 'text/plain'))).toEqual({ kind: 'markdown' });
    expect(selectRenderer(file('notes.markdown', 'application/octet-stream'))).toEqual({
      kind: 'markdown',
    });
  });

  it('dispatches code by extension across common languages', () => {
    const cases: Array<[string, string]> = [
      ['app.ts', 'typescript'],
      ['app.tsx', 'typescript'],
      ['main.py', 'python'],
      ['main.go', 'go'],
      ['main.rs', 'rust'],
      ['build.sh', 'bash'],
      ['data.json', 'json'],
      ['config.yaml', 'yaml'],
      ['Dockerfile', 'dockerfile'],
      ['style.css', 'css'],
      ['query.sql', 'sql'],
      ['view.svg', 'xml'],
    ];
    for (const [name, language] of cases) {
      expect(selectRenderer(file(name, 'application/octet-stream'))).toEqual({
        kind: 'code',
        language,
      });
    }
  });

  it('falls back to plain text for text MIMEs without a language match', () => {
    expect(selectRenderer(file('changes.log', 'text/plain'))).toEqual({ kind: 'text' });
    expect(selectRenderer(file('manifest.json', 'application/json'))).toEqual({
      kind: 'code',
      language: 'json',
    });
    // text/* with an unknown extension → plain text.
    expect(selectRenderer(file('release-notes', 'text/plain'))).toEqual({ kind: 'text' });
  });

  it('returns oversized for files past the per-kind cap', () => {
    // Image cap is 25MB; render a 30MB png as oversized.
    expect(selectRenderer(file('photo.png', 'image/png', 30 * 1024 * 1024))).toEqual({
      kind: 'oversized',
    });
    // Code cap is 1MB; a 2MB .ts is oversized.
    expect(selectRenderer(file('giant.ts', 'application/octet-stream', 2 * 1024 * 1024))).toEqual({
      kind: 'oversized',
    });
    // But a code file under the cap is still code.
    expect(
      selectRenderer(file('small.ts', 'application/octet-stream', SIZE_CAPS.code - 1)),
    ).toEqual({ kind: 'code', language: 'typescript' });
  });

  it('returns unsupported for arbitrary binary types', () => {
    expect(selectRenderer(file('archive.zip', 'application/zip'))).toEqual({
      kind: 'unsupported',
    });
    expect(selectRenderer(file('binary', 'application/octet-stream'))).toEqual({
      kind: 'unsupported',
    });
  });
});
