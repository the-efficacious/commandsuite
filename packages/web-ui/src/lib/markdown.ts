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
 *      These are inbound traffic envelopes, not prose. They are lifted
 *      out before parsing and restored afterwards, so no markdown rule
 *      can reach inside one and the parser cannot restructure the tag.
 *
 * SANITIZATION ORDER. `marked` runs first, `DOMPurify` second, and the
 * channel spans are injected *after* sanitization. That last step is
 * safe for the same reason it always was: the span HTML is constructed
 * here from HTML-escaped pieces, carries a fixed set of classes, and
 * has no attributes, URLs or event handlers that could execute.
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

/**
 * Base for the placeholder that stands in for a lifted channel
 * envelope. U+E000 is Private Use Area: inert to markdown, and it
 * survives `DOMPurify` because it is plain text.
 *
 * It is NOT a character that cannot occur in a message body. An
 * earlier version of this file asserted that it was, and the assertion
 * was false — a body containing the literal placeholder text has that
 * text replaced by envelope markup on restore, so a captured message
 * quoting one is silently rewritten. Any *fixed* sentinel has that
 * defect; the sentinel must be chosen against the input.
 */
const SENTINEL_BASE = '';

/**
 * Return a sentinel that does not occur in `body`, by repeating the
 * base until it is absent. Terminates because `body` is finite: each
 * repetition is strictly longer, and no string contains a substring
 * longer than itself.
 *
 * Checking the *original* body is what makes the guarantee hold. The
 * text that reaches `marked` is the body minus the envelopes plus the
 * placeholders, and the restored envelope markup is built from escaped
 * pieces of that same body — so if the sentinel is absent from the
 * original, it is absent from every intermediate form, and no token
 * can be forged by input.
 */
function sentinelFor(body: string): string {
  let sentinel = SENTINEL_BASE;
  while (body.includes(sentinel)) sentinel += SENTINEL_BASE;
  return sentinel;
}

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

export function renderMessageMarkdown(body: string): string {
  // Lift channel envelopes out before parsing. Markdown inside one is
  // not markdown — it is payload — and a fenced block or table marker
  // in a captured message must not restructure the envelope around it.
  const sentinel = sentinelFor(body);
  const envelopes: string[] = [];
  const withPlaceholders = body.replace(
    CHANNEL_TAG,
    (_match, tag: string, attrs: string, inner: string) => {
      envelopes.push(renderChannelTag(tag, attrs, inner));
      return `\n\n${sentinel}${envelopes.length - 1}${sentinel}\n\n`;
    },
  );

  const parsed = md.parse(withPlaceholders, { async: false });
  const safe = DOMPurify.sanitize(parsed);

  // Restore. The `<p>`-wrapped form goes first: an envelope on its own
  // line becomes a paragraph, and a `<div class="ch-body">` inside a
  // `<p>` is invalid nesting that browsers silently restructure.
  let restored = safe;
  envelopes.forEach((html, i) => {
    const token = `${sentinel}${i}${sentinel}`;
    restored = restored.split(`<p>${token}</p>`).join(html).split(token).join(html);
  });
  return restored;
}
