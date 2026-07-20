/**
 * TextPreview — fetches a text-flavoured file via `fsRead` and
 * renders it in a scrollable `<pre>` block. Used for plain text,
 * `application/json`, `application/xml`, and as the safe fallback
 * for anything Markdown / Code want to fall back to.
 *
 * Size-capping happens upstream in `selectRenderer`; this component
 * trusts that anything reaching it is within budget. The fetch is
 * tied to the path so re-opening a different file unmounts and
 * remounts cleanly.
 */

import { useEffect, useState } from 'preact/hooks';
import { getClient } from '../../lib/client.js';
import type { PreviewableFile } from '../../lib/file-preview.js';

export interface TextPreviewProps {
  file: PreviewableFile;
}

interface State {
  status: 'loading' | 'ready' | 'error';
  text?: string;
  error?: string;
}

async function fetchText(path: string): Promise<string> {
  const blob = await getClient().fsRead(path);
  return blob.text();
}

export function TextPreview({ file }: TextPreviewProps) {
  const [state, setState] = useState<State>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    fetchText(file.path)
      .then((text) => {
        if (!cancelled) setState({ status: 'ready', text });
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
        Couldn't load preview: {state.error}
      </p>
    );
  }
  return (
    <pre style="margin:0;padding:16px;font-family:var(--f-mono);font-size:12.5px;line-height:1.55;white-space:pre-wrap;word-break:break-word;color:var(--ink);background:var(--paper)">
      {state.text}
    </pre>
  );
}
