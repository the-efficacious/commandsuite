/**
 * Highlights XML-like tags (`<tag ...>body</tag>`) inside plain text
 * for use in trace/activity viewers where message content is rendered
 * as preformatted text.
 *
 * Returns an HTML string safe for dangerouslySetInnerHTML — all
 * non-tag content is HTML-escaped first.
 */

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const TAG_RE = /<([a-zA-Z][\w.-]*)(\s[\s\S]*?)?>([\s\S]*?)<\/\1>/g;

export function highlightXmlTags(text: string): string | null {
  if (!text.includes('<')) return null;

  let hasMatch = false;
  let result = '';
  let lastIndex = 0;

  for (const match of text.matchAll(TAG_RE)) {
    hasMatch = true;
    const before = text.slice(lastIndex, match.index);
    result += escapeHtml(before);

    const tagName = match[1] ?? '';
    const attrs = match[2] ?? '';
    const body = match[3] ?? '';

    const coloredAttrs = escapeHtml(attrs).replace(
      /(\w[\w.-]*)=(&quot;[\s\S]*?&quot;|\S+)/g,
      '<span class="ch-attr">$1</span>=<span class="ch-val">$2</span>',
    );

    result +=
      '<span class="channel-tag">' +
      '<span class="ch-bracket">&lt;</span>' +
      '<span class="ch-name">' +
      escapeHtml(tagName) +
      '</span>' +
      coloredAttrs +
      '<span class="ch-bracket">&gt;</span>' +
      '<div class="ch-body">' +
      escapeHtml(body) +
      '</div>' +
      '<span class="ch-bracket">&lt;/</span>' +
      '<span class="ch-name">' +
      escapeHtml(tagName) +
      '</span>' +
      '<span class="ch-bracket">&gt;</span>' +
      '</span>';

    lastIndex = (match.index ?? 0) + match[0].length;
  }

  if (!hasMatch) return null;

  result += escapeHtml(text.slice(lastIndex));
  return result;
}
