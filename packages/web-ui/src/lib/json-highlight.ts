/**
 * Syntax-highlights JSON — pretty-printed tool payloads and exchange
 * bodies — for the activity/trace viewers, where tool inputs and results
 * render as preformatted monospace. Mirrors `channel-highlight`: the
 * caller drops the returned HTML into a <pre> via
 * dangerouslySetInnerHTML, and every span of content is HTML-escaped
 * first.
 *
 * Returns null when the text isn't a JSON object or array — a raw command
 * output string, a diff, prose, an error line — so the caller falls back
 * to the uncolored <pre>. Only fully-parseable JSON is highlighted, so
 * partial or non-JSON text is never mangled or mis-tokenized.
 *
 * Token classes (`.jk`/`.js`/`.jn`/`.jb`/`.jp`) resolve to brand tokens
 * in brand.css (steel/ember/glacier/brick/muted), so both light and dark
 * themes track automatically.
 */

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// One token per match. The string alternative comes FIRST so digits or
// the words true/false/null inside a quoted value are consumed as part
// of the string rather than re-tokenized. A string that is immediately
// trailed by `:` is an object key (the colon is captured in group 2).
const JSON_TOKEN =
  /("(?:\\.|[^"\\])*")(\s*:)?|(true|false|null)|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|([{}[\],:])/g;

export function highlightJson(text: string): string | null {
  const trimmed = text.trim();
  // Only touch actual JSON objects/arrays. Tool results are often a raw
  // string (command output, a unified diff, a stack trace) that must
  // pass through verbatim.
  if (trimmed.length === 0 || (trimmed[0] !== '{' && trimmed[0] !== '[')) return null;
  try {
    JSON.parse(trimmed);
  } catch {
    return null;
  }

  let result = '';
  let lastIndex = 0;
  for (const m of text.matchAll(JSON_TOKEN)) {
    const idx = m.index ?? 0;
    // Whitespace / indentation between tokens — escaped, uncolored.
    result += escapeHtml(text.slice(lastIndex, idx));

    if (m[1] !== undefined) {
      if (m[2] !== undefined) {
        // Quoted string trailed by a colon → object key.
        result += `<span class="jk">${escapeHtml(m[1])}</span>`;
        result += `<span class="jp">${escapeHtml(m[2])}</span>`;
      } else {
        result += `<span class="js">${escapeHtml(m[1])}</span>`;
      }
    } else if (m[3] !== undefined) {
      result += `<span class="jb">${m[3]}</span>`;
    } else if (m[4] !== undefined) {
      result += `<span class="jn">${m[4]}</span>`;
    } else if (m[5] !== undefined) {
      result += `<span class="jp">${escapeHtml(m[5])}</span>`;
    }

    lastIndex = idx + m[0].length;
  }
  result += escapeHtml(text.slice(lastIndex));
  return result;
}
