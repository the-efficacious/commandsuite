/**
 * CodePreview — fetches a source file, syntax-highlights it via
 * `highlight.js`, and renders with line numbers + a copy-to-
 * clipboard button.
 *
 * `highlight.js/lib/common` is dynamic-imported so the bundle cost
 * (~30KB gzipped) is paid only when the operator opens their first
 * code preview.
 *
 * Auto-detect is deliberately disabled — we pin the language by
 * extension (resolved upstream in `selectRenderer`). hljs's auto
 * mode is regex-heavy and can be DoS'd by adversarial content; an
 * explicit grammar bound by extension keeps the parse linear.
 *
 * Files of unknown language fall through to the plain TextPreview
 * before reaching this component, so the language prop is always
 * a real grammar name here.
 */

import { useEffect, useState } from 'preact/hooks';
import { getClient } from '../../lib/client.js';
import type { PreviewableFile } from '../../lib/file-preview.js';
import { Copy } from '../icons/index.js';

export interface CodePreviewProps {
  file: PreviewableFile;
  /** highlight.js language id (e.g. `typescript`, `python`). */
  language: string;
}

interface State {
  status: 'loading' | 'ready' | 'error';
  raw?: string;
  /** Highlighted HTML — pre-escaped by hljs, safe to dangerouslySetInnerHTML. */
  html?: string;
  error?: string;
}

async function highlight(path: string, language: string): Promise<{ raw: string; html: string }> {
  const [{ default: hljs }, blob] = await Promise.all([
    // `lib/common` carries ~36 popular languages and is the right
    // sweet-spot bundle for a generic preview surface. Importing
    // `lib/core` and registering one language at a time would shave
    // a few KB but makes the supported-language list a code-edit
    // away from breaking a user's preview.
    import('highlight.js/lib/common'),
    getClient().fsRead(path),
  ]);
  const raw = await blob.text();
  // Fall back to plaintext if hljs doesn't recognize the language —
  // shouldn't happen given selectRenderer's allowlist, but defensive
  // is cheap.
  const known = hljs.getLanguage(language) !== undefined;
  const html = known
    ? hljs.highlight(raw, { language, ignoreIllegals: true }).value
    : escapeHtml(raw);
  return { raw, html };
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function CodePreview({ file, language }: CodePreviewProps) {
  const [state, setState] = useState<State>({ status: 'loading' });
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    highlight(file.path, language)
      .then(({ raw, html }) => {
        if (!cancelled) setState({ status: 'ready', raw, html });
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
  }, [file.path, language]);

  const onCopy = async () => {
    if (!state.raw) return;
    try {
      await navigator.clipboard.writeText(state.raw);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      /* user denied / no permission — silently no-op */
    }
  };

  if (state.status === 'loading') {
    return <p style="color:var(--muted);font-size:13px;padding:16px">Loading…</p>;
  }
  if (state.status === 'error') {
    return (
      <p role="alert" style="color:var(--err);font-size:13px;padding:16px">
        Couldn't render code: {state.error}
      </p>
    );
  }

  // Line numbers: split on \n, render a parallel <ol> aligned with
  // the highlighted code. Both panels share the same line height so
  // the gutter stays in lockstep with wrapping disabled.
  const lineCount = (state.raw ?? '').split('\n').length;
  const lineNumbers = Array.from({ length: lineCount }, (_, i) => i + 1).join('\n');

  return (
    <div
      class="code-preview"
      style="display:flex;flex-direction:column;height:100%;background:var(--paper)"
    >
      <div style="display:flex;align-items:center;justify-content:space-between;padding:8px 14px;border-bottom:1px solid var(--rule);background:var(--ice);flex-shrink:0">
        <span
          class="eyebrow"
          style="font-family:var(--f-mono);font-size:11px;letter-spacing:.06em;color:var(--muted);text-transform:uppercase"
        >
          {language}
        </span>
        <button
          type="button"
          onClick={() => void onCopy()}
          aria-label={copied ? 'Copied' : 'Copy to clipboard'}
          title={copied ? 'Copied' : 'Copy'}
          style="display:inline-flex;align-items:center;gap:6px;padding:4px 10px;background:transparent;border:1px solid var(--rule);border-radius:var(--r-xs);color:var(--graphite);font-family:var(--f-sans);font-size:11.5px;cursor:pointer"
        >
          <Copy size={11} aria-hidden="true" />
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <div style="flex:1;display:flex;overflow:auto;font-family:var(--f-mono);font-size:12.5px;line-height:1.5">
        <pre
          aria-hidden="true"
          style="flex-shrink:0;margin:0;padding:14px 10px 14px 14px;color:var(--muted);text-align:right;user-select:none;background:var(--ice);border-right:1px solid var(--rule);white-space:pre"
        >
          {lineNumbers}
        </pre>
        <pre
          class="hljs"
          style="flex:1;margin:0;padding:14px;color:var(--ink);background:var(--paper);overflow-x:auto;white-space:pre"
        >
          {/* biome-ignore lint/security/noDangerouslySetInnerHtml: highlight.js
              produces escaped HTML — every token is wrapped in <span class="hljs-…">
              with text nodes inside, no script execution path. The raw input is
              text-only (fetched via fsRead), and ignoreIllegals stops malformed
              input from desynchronizing the parser. */}
          <code dangerouslySetInnerHTML={{ __html: state.html ?? '' }} />
        </pre>
      </div>
    </div>
  );
}
