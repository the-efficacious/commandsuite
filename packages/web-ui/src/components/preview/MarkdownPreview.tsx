/**
 * MarkdownPreview — fetches a markdown file, parses with `marked`,
 * sanitizes with `DOMPurify`, then renders the resulting HTML.
 *
 * Both libs are dynamic-imported so the SPA bundle doesn't pay for
 * them until the operator opens their first markdown preview.
 *
 * Sanitization is non-negotiable: `marked` allows raw HTML in
 * markdown by default, which would let a malicious uploader smuggle
 * `<script>` tags. `DOMPurify` strips anything that could execute
 * (script, iframe, on* event handlers, javascript: URLs, etc.) and
 * leaves the rest intact.
 */

import { useEffect, useState } from 'preact/hooks';
import { getClient } from '../../lib/client.js';
import type { PreviewableFile } from '../../lib/file-preview.js';

export interface MarkdownPreviewProps {
  file: PreviewableFile;
}

interface State {
  status: 'loading' | 'ready' | 'error';
  html?: string;
  error?: string;
}

async function renderMarkdown(path: string): Promise<string> {
  const [{ marked }, dompurifyModule] = await Promise.all([import('marked'), import('dompurify')]);
  const dom = dompurifyModule.default;
  const blob = await getClient().fsRead(path);
  const text = await blob.text();
  // `marked.parse` is sync when given a string + no async tokenizers,
  // but the type is `string | Promise<string>`. Coerce via Promise.resolve.
  const rawHtml = await Promise.resolve(marked.parse(text, { gfm: true, breaks: false }));
  return dom.sanitize(rawHtml);
}

export function MarkdownPreview({ file }: MarkdownPreviewProps) {
  const [state, setState] = useState<State>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    renderMarkdown(file.path)
      .then((html) => {
        if (!cancelled) setState({ status: 'ready', html });
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setState({
            status: 'error',
            error: err instanceof Error ? err.message : String(err),
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [file.path]);

  if (state.status === 'loading') {
    return <p style="color:var(--muted);font-size:13px;padding:16px">Loading…</p>;
  }
  if (state.status === 'error') {
    return (
      <p role="alert" style="color:var(--err);font-size:13px;padding:16px">
        Couldn't render markdown: {state.error}
      </p>
    );
  }
  return (
    <div
      class="md-preview"
      style="padding:20px 24px;font-family:var(--f-sans);font-size:14px;line-height:1.65;color:var(--ink)"
      dangerouslySetInnerHTML={{ __html: state.html ?? '' }}
    />
  );
}
