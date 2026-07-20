/**
 * Tiny inline-markdown renderer for message bodies.
 *
 * Supports three inline formats commonly used in agent chatter:
 *   - `**bold**` → <strong>
 *   - `*italic*` → <em>
 *   - `` `code` `` → <code>
 *
 * Everything else is rendered as plain text with HTML escaped. Line
 * breaks in the source string become `<br>` so multi-line messages
 * render naturally.
 *
 * We return a sanitized HTML string for use with Preact's
 * `dangerouslySetInnerHTML`. The sanitization is "escape all HTML
 * metacharacters *before* injecting the formatting markers," which
 * is safe because the formatting markers themselves only produce
 * known-safe tags (no attributes, no URLs).
 *
 * Deliberately does NOT support:
 *   - links (URLs need their own safe-URL check)
 *   - code blocks (multi-line fenced — v1 ships inline only)
 *   - lists / headings / blockquotes
 *   - HTML passthrough
 *
 * Phase 5 is a skeleton; full markdown can come later without
 * changing the render interface.
 */

/**
 * Escape HTML metacharacters. Has to run BEFORE any formatting
 * markers are inserted so we don't double-escape the generated
 * `<strong>`/`<em>`/`<code>` tags.
 */
function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function renderInlineMarkdown(body: string): string {
  const escaped = escapeHtml(body);

  // Pull out code spans before doing bold/italic, or `**x**` inside
  // backticks would get formatted. We swap them for non-markdown
  // placeholders, run the other passes, then restore the literal
  // contents wrapped in <code>. Placeholder uses a Private Use Area
  // codepoint (U+E000) as a sentinel that can't appear in escaped
  // HTML and doesn't trigger the control-char lint rule.
  const SENTINEL = '\uE000';
  const codeSpans: string[] = [];
  const withPlaceholders = escaped.replace(/`([^`]+?)`/g, (_match, inner: string) => {
    codeSpans.push(inner);
    return `${SENTINEL}${codeSpans.length - 1}${SENTINEL}`;
  });

  // Bold before italic so `***bold italic***` degrades to bold (users
  // rarely nest the two, and nesting would need a real AST).
  const boldReplaced = withPlaceholders.replace(/\*\*([^*]+?)\*\*/g, '<strong>$1</strong>');

  const italicReplaced = boldReplaced.replace(/(^|[^*])\*([^*\s][^*]*?)\*(?!\*)/g, '$1<em>$2</em>');

  // Restore code spans as literal <code> wrappers — contents are
  // already HTML-escaped so they render verbatim.
  const restorePattern = new RegExp(`${SENTINEL}(\\d+)${SENTINEL}`, 'g');
  const codeRestored = italicReplaced.replace(restorePattern, (_match, idx: string) => {
    const contents = codeSpans[Number(idx)] ?? '';
    return `<code>${contents}</code>`;
  });

  // XML tags — render escaped <tag ...>body</tag> pairs with syntax
  // coloring (brackets, tag name, attributes, body).
  const channelRendered = renderXmlTags(codeRestored);

  // Newlines → <br>. We do this last so inline markers across lines
  // still match (rare but possible).
  return channelRendered.replace(/\n/g, '<br>');
}

/**
 * Detect escaped XML tags and render them as styled blocks.
 * Input is already HTML-escaped, so we match `&lt;tag ...&gt;`.
 */
function renderXmlTags(html: string): string {
  return html.replace(
    /&lt;([a-zA-Z][\w.-]*)(\s[\s\S]*?)&gt;([\s\S]*?)&lt;\/\1&gt;/g,
    (_match, tagName: string, attrs: string, body: string) => {
      const coloredAttrs = attrs.replace(
        /([\w.-]+)=(&quot;[\s\S]*?&quot;|&amp;quot;[\s\S]*?&amp;quot;|&#39;[\s\S]*?&#39;|\S+)/g,
        '<span class="ch-attr">$1</span>=<span class="ch-val">$2</span>',
      );
      return (
        '<span class="channel-tag">' +
        '<span class="ch-bracket">&lt;</span>' +
        '<span class="ch-name">' +
        tagName +
        '</span>' +
        coloredAttrs +
        '<span class="ch-bracket">&gt;</span>' +
        '<div class="ch-body">' +
        body +
        '</div>' +
        '<span class="ch-bracket">&lt;/</span>' +
        '<span class="ch-name">' +
        tagName +
        '</span>' +
        '<span class="ch-bracket">&gt;</span>' +
        '</span>'
      );
    },
  );
}
