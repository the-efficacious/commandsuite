/**
 * Markdown renderer for message bodies.
 *
 * Agents emit Markdown natively — headings, lists, tables, fenced code
 * — so chat renders full GFM through `marked`, sanitized with
 * `DOMPurify`. This is the same pair the file-preview surface already
 * uses (`components/preview/MarkdownPreview.tsx`); chat previously had
 * a separate three-construct renderer, which meant the same document
 * rendered differently depending on which surface you opened it in.
 *
 * TWO PROPERTIES OF THE OLD RENDERER ARE DELIBERATELY KEPT. Both are
 * behavioural contracts rather than incidental, and `marked`'s defaults
 * break both:
 *
 *   1. **Raw HTML stays escaped.** `marked` passes HTML through by
 *      default, so `<div>x</div>` in a message would become a real div.
 *      In a product whose traffic is full of XML-shaped payloads, the
 *      author's literal text is what a reader needs to see. The `html`
 *      renderer override escapes every HTML token — it covers inline
 *      and block alike, verified against marked 18 rather than assumed
 *      from the block-level name.
 *
 *   2. **`<channel …>` blocks get syntax colouring, not markdown.**
 *      These are inbound traffic envelopes, not prose. They are how we
 *      read our own inbound traffic, so no markdown rule may reach
 *      inside one and the parser may not restructure the tag.
 *
 * HOW THE TWO ARE INTERLEAVED — AND WHY NOT WITH PLACEHOLDERS. The body
 * is cut into alternating prose segments and envelopes in one pass.
 * Each prose segment is parsed and sanitized on its own; each envelope
 * is rendered directly from escaped pieces; the results are
 * concatenated. Envelope text never enters the parser at all, which is
 * the property we need, and it is now structural rather than enforced.
 *
 * The obvious alternative — substitute a placeholder for each envelope,
 * parse the whole body, then swap the renderings back in — was tried
 * across three revisions of this file and is why the comments below are
 * emphatic. It failed twice on collision (any placeholder a reader can
 * also type is a placeholder that rewrites their message) and once on
 * cost. Measured at the last placeholder revision, a body of 1,000
 * U+E000 characters and 100 envelopes — 3,901 characters, a message a
 * person could paste — took 1,187.7 ms; 7,801 took 18,902 ms; 11,701
 * took 95,406 ms. Roughly O(n^4): the placeholder had to grow with the
 * longest run in the input, was inserted twice per envelope, and the
 * restore pass rescanned the whole document once per envelope.
 *
 * Segmenting has none of those terms. There is no token to collide
 * with, nothing to grow, and one pass over the input.
 *
 * SANITIZATION. Each prose segment goes through `marked` then
 * `DOMPurify`. Envelope markup bypasses `DOMPurify` deliberately: it is
 * built here from HTML-escaped pieces, carries a fixed set of classes,
 * and has no attributes, URLs or event handlers that could execute.
 *
 * ONE KNOWN BEHAVIOUR CHANGE. Prose segments are separate markdown
 * documents, so document-level state does not cross an envelope — a
 * reference-link definition on one side of an envelope will not resolve
 * on the other. Block constructs were already unable to span an
 * envelope under the placeholder scheme, so this is narrower than it
 * sounds, and it is the price of the property above being structural.
 */

import DOMPurify from 'dompurify';
import { Marked } from 'marked';

/**
 * Escape HTML metacharacters. Used for the escaped-HTML contract above
 * and for every piece of a channel tag before it is placed into markup.
 */
function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * A dedicated instance rather than the module-level `marked`, so this
 * renderer override cannot leak into any other consumer of the library
 * in this app — notably the file preview, which deliberately *does*
 * let HTML through and relies on DOMPurify to make that safe.
 */
const md = new Marked({ gfm: true, breaks: true });
md.use({
  renderer: {
    html(token) {
      return escapeHtml(token.raw);
    },
  },
});

/** `<tag attrs>body</tag>` on RAW input, before any escaping. */
const CHANNEL_TAG = /<([a-zA-Z][\w.-]*)(\s[\s\S]*?)>([\s\S]*?)<\/\1>/g;

/**
 * Render one `<tag …>body</tag>` as a coloured envelope. Every
 * interpolated piece is escaped here, which is what lets the result be
 * injected after sanitization.
 */
function renderChannelTag(tagName: string, attrs: string, body: string): string {
  const coloredAttrs = escapeHtml(attrs).replace(
    /([\w.-]+)=(&quot;[\s\S]*?&quot;|&#39;[\s\S]*?&#39;|\S+)/g,
    '<span class="ch-attr">$1</span>=<span class="ch-val">$2</span>',
  );
  const name = escapeHtml(tagName);
  return (
    '<span class="channel-tag">' +
    '<span class="ch-bracket">&lt;</span>' +
    `<span class="ch-name">${name}</span>` +
    coloredAttrs +
    '<span class="ch-bracket">&gt;</span>' +
    `<div class="ch-body">${escapeHtml(body)}</div>` +
    '<span class="ch-bracket">&lt;/</span>' +
    `<span class="ch-name">${name}</span>` +
    '<span class="ch-bracket">&gt;</span>' +
    '</span>'
  );
}

/**
 * Render one prose segment. Empty and whitespace-only segments produce
 * nothing rather than an empty paragraph — they are the gaps either
 * side of an envelope, not content.
 */
function renderProse(segment: string): string {
  if (segment.trim() === '') return '';
  return DOMPurify.sanitize(md.parse(segment, { async: false }));
}

export function renderMessageMarkdown(body: string): string {
  // `matchAll` requires the `g` flag and reads `lastIndex` to start
  // from. `CHANNEL_TAG` is module-level, so reset it rather than rely
  // on no other call site having left it advanced.
  CHANNEL_TAG.lastIndex = 0;

  let html = '';
  let cursor = 0;
  for (const match of body.matchAll(CHANNEL_TAG)) {
    const [raw, tag, attrs, inner] = match;
    html += renderProse(body.slice(cursor, match.index));
    html += renderChannelTag(tag as string, attrs as string, inner as string);
    cursor = match.index + raw.length;
  }
  html += renderProse(body.slice(cursor));
  return html;
}
