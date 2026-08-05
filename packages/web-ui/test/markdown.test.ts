/**
 * @vitest-environment jsdom
 *
 * `renderMessageMarkdown` — full GFM for chat, with two contracts kept
 * from the renderer it replaced.
 *
 * WHY THIS FILE OVERRIDES THE PACKAGE'S happy-dom ENVIRONMENT.
 * `DOMPurify` does not work correctly under happy-dom, and it fails in
 * the direction that matters. Measured: `isSupported` reports `true`,
 * while `sanitize('<h2>x</h2>')` returns `'x'`, `'<ul><li>a</li></ul>'`
 * returns `'<li>a</li>'`, and — the dangerous one —
 * `'<p><a href="javascript:alert(1)">c</a></p>'` comes back with the
 * `javascript:` URL intact. It strips the outermost element and skips
 * attribute sanitization.
 *
 * happy-dom's own `innerHTML` parser is fine (`<h2>`, `<ul>`, `<table>`
 * and `<template>` all round-trip), so this is a DOMPurify/happy-dom
 * incompatibility rather than a parser bug, and binding
 * `DOMPurify(window)` explicitly does not change it.
 *
 * A sanitization test under happy-dom would therefore assert nothing
 * about production — and could pass while the control was disabled.
 *
 * The first group is inherited: every assertion below it existed
 * against the old three-construct renderer and must still hold. They
 * are the reason this is not a drop-in parser swap — `marked`'s
 * defaults break the last two.
 */

import { describe, expect, it } from 'vitest';
import { renderMessageMarkdown } from '../src/lib/markdown.js';

/**
 * U+E000. Not part of the renderer's contract any more — it is simply
 * a character a message may contain, and three rejected revisions of
 * this file gave it special meaning. Written by codepoint rather than
 * as a literal: a bare PUA character does not survive every editor,
 * shell heredoc or copy-paste, and a fixture that silently loses it
 * passes while testing nothing.
 */
const SENTINEL = String.fromCharCode(0xe000);

describe('renderMessageMarkdown — contracts kept from the previous renderer', () => {
  it('escapes HTML metacharacters', () => {
    expect(renderMessageMarkdown('<script>alert(1)</script>')).not.toContain('<script>');
    expect(renderMessageMarkdown('<script>alert(1)</script>')).toContain('&lt;script&gt;');
  });

  it('renders bold', () => {
    expect(renderMessageMarkdown('this is **important**')).toContain(
      'this is <strong>important</strong>',
    );
  });

  it('renders italic', () => {
    expect(renderMessageMarkdown('a *subtle* hint')).toContain('a <em>subtle</em> hint');
  });

  it('renders inline code', () => {
    expect(renderMessageMarkdown('use `foo()` instead')).toContain('<code>foo()</code>');
  });

  it('does not format inside code spans', () => {
    const out = renderMessageMarkdown('`**not bold**`');
    expect(out).toContain('<code>**not bold**</code>');
    expect(out).not.toContain('<strong>');
  });

  it('preserves single newlines as line breaks', () => {
    expect(renderMessageMarkdown('line one\nline two')).toContain('<br>');
  });

  it('does not let raw HTML through a bold marker', () => {
    const out = renderMessageMarkdown('**<b>x</b>**');
    expect(out).toContain('<strong>');
    expect(out).toContain('&lt;b&gt;x&lt;/b&gt;');
    expect(out).not.toContain('<b>x</b>');
  });

  it('leaves non-channel HTML tags escaped rather than rendering them', () => {
    // `marked` passes HTML through by default. In a product whose
    // traffic is XML-shaped, the author's literal text is what a reader
    // needs — so the html-token override must be doing its job.
    const out = renderMessageMarkdown('<div>not a channel</div>');
    expect(out).toContain('&lt;div&gt;');
    expect(out).not.toContain('<div>not a channel');
    expect(out).not.toContain('channel-tag');
  });

  it('renders channel tags with syntax coloring', () => {
    const out = renderMessageMarkdown('<channel source="csuite" from="scout">hello</channel>');
    expect(out).toContain('class="channel-tag"');
    expect(out).toContain('class="ch-name">channel</span>');
    expect(out).toContain('class="ch-attr">source</span>');
    expect(out).toContain('class="ch-val">&quot;csuite&quot;</span>');
    expect(out).toContain('class="ch-body">hello</div>');
    expect(out).not.toContain('&lt;channel');
  });

  it('renders realistic multiline channel tags with many attributes', () => {
    const input =
      '<channel source="csuite" msg_id="13881ea1" level="info" ts="04/15/26 17:47:58 UTC" ts_ms="1776275278880" thread="dm" from="przy" target="test-agent-1">\nread you loud and clear! Thank you!\n</channel>';
    const out = renderMessageMarkdown(input);
    expect(out).toContain('class="channel-tag"');
    expect(out).toContain('class="ch-attr">source</span>');
    expect(out).toContain('class="ch-attr">from</span>');
    expect(out).toContain('class="ch-val">&quot;przy&quot;</span>');
    expect(out).toContain('class="ch-body">');
    expect(out).toContain('read you loud and clear');
  });
});

describe('renderMessageMarkdown — the constructs agents actually emit', () => {
  it('renders headings', () => {
    expect(renderMessageMarkdown('## Findings')).toContain('<h2>Findings</h2>');
  });

  it('renders unordered lists', () => {
    const out = renderMessageMarkdown('- first\n- second');
    expect(out).toContain('<ul>');
    expect(out).toContain('<li>first</li>');
  });

  it('renders ordered lists', () => {
    const out = renderMessageMarkdown('1. first\n2. second');
    expect(out).toContain('<ol>');
  });

  it('renders blockquotes', () => {
    expect(renderMessageMarkdown('> quoted line')).toContain('<blockquote>');
  });

  it('renders fenced code blocks', () => {
    const out = renderMessageMarkdown('```\nconst x = 1;\n```');
    expect(out).toContain('<pre>');
    expect(out).toContain('const x = 1;');
  });

  it('renders GFM tables', () => {
    const out = renderMessageMarkdown('| a | b |\n|---|---|\n| 1 | 2 |');
    expect(out).toContain('<table>');
    expect(out).toContain('<th>a</th>');
    expect(out).toContain('<td>1</td>');
  });

  it('renders links', () => {
    const out = renderMessageMarkdown('[docs](https://example.com/x)');
    expect(out).toContain('<a href="https://example.com/x">docs</a>');
  });
});

describe('renderMessageMarkdown — sanitization', () => {
  it('strips a javascript: URL from a markdown link', () => {
    // The construct that did not exist before this change: links are
    // now rendered, so a malicious href is newly reachable and
    // DOMPurify is what closes it.
    const out = renderMessageMarkdown('[click](javascript:alert(1))');
    expect(out.toLowerCase()).not.toContain('javascript:');
  });

  it('leaves no event-handler attribute on any rendered element', () => {
    // Asserted by parsing rather than by substring: an `onerror` that
    // appears inside a percent-encoded URL is inert data, and a
    // `not.toContain('onerror')` check fails on that safe output while
    // telling you nothing about actual attributes. The property is
    // "no element carries an on* attribute", so test that.
    const out = renderMessageMarkdown(
      '![x](https://example.com/a.png"onerror="alert(1)) and <img src=x onerror=alert(1)>',
    );
    const host = document.createElement('div');
    host.innerHTML = out;
    const offenders: string[] = [];
    for (const el of Array.from(host.querySelectorAll('*'))) {
      for (const attr of Array.from(el.attributes)) {
        if (attr.name.toLowerCase().startsWith('on')) offenders.push(`${el.tagName}[${attr.name}]`);
      }
    }
    expect(offenders).toEqual([]);
  });

  // ── Message text must not be able to influence document structure ──
  //
  // Three revisions of this file substituted a placeholder for each
  // envelope, parsed the whole body, then swapped the renderings back
  // in. Rune rejected all three: twice for collision (any placeholder a
  // reader can also type is one that rewrites their message) and once
  // for cost. The renderer no longer uses placeholders — prose segments
  // and envelopes are spliced — so these now hold structurally rather
  // than by a chosen-token argument.
  //
  // They are kept, and kept named after the property rather than the
  // machinery, because the placeholder approach is the obvious one and
  // someone will reach for it again.

  it('does not rewrite message text that resembles internal markup', () => {
    // Rune's repro against fea80e0. U+E000 was the fixed placeholder,
    // and the source claimed it "cannot appear in real message text" —
    // false; it is legal in a JS string and in captured traffic. The
    // envelope was emitted twice and the author's own characters were
    // destroyed. Traffic silently rewritten is the severe half.
    const forged = `${SENTINEL}0${SENTINEL}`;
    const out = renderMessageMarkdown(`${forged}\n<channel from="x">payload</channel>`);
    expect(out.split('class="channel-tag"').length - 1).toBe(1);
    expect(out).toContain(SENTINEL);
  });

  it('is unaffected by how many repetitions of the marker a body contains', () => {
    // Killed the second placeholder revision, which escalated only once.
    const body =
      `${SENTINEL}0${SENTINEL} and ${SENTINEL.repeat(2)}0${SENTINEL.repeat(2)}\n` +
      '<channel from="x">payload</channel>';
    const out = renderMessageMarkdown(body);
    expect(out.split('class="channel-tag"').length - 1).toBe(1);
  });

  it('renders a long run of marker characters in linear time', () => {
    // Rune against 74f5416. That revision chose the marker by growing a
    // candidate and re-testing `body.includes(...)` — a correct absence
    // proof that terminated, and still froze the chat surface. It took
    // 29,945 ms here; splicing takes ~50 ms.
    //
    // Sized, not timed: the bad implementation blows the 5s default ~6x
    // and the good one sits ~90x under it, so the gap survives a slow
    // runner rather than being tuned to one machine.
    const body = `${SENTINEL.repeat(200_000)}\n<channel from="x">payload</channel>`;
    const out = renderMessageMarkdown(body);
    expect(out.split('class="channel-tag"').length - 1).toBe(1);
  });

  it('does not amplify across marker length and envelope count together', () => {
    // Rune against 1c05367, and the reason placeholders are gone. The
    // single-pass selector still produced a marker that GREW with the
    // longest run in the input, inserted it twice per envelope, and
    // rescanned the whole document once per envelope — roughly O(n^4)
    // across the two dimensions at once. Measured on that revision:
    //
    //     3,901 chars ->   1,187.7 ms
    //     7,801 chars ->  18,902.0 ms
    //    11,701 chars ->  95,405.8 ms
    //
    // The all-marker test above holds only one dimension and passed
    // that revision cleanly. This one moves both. Splicing renders this
    // input in ~2 ms; the last placeholder revision needs ~95s and dies
    // on the 5s timeout.
    const body = `${SENTINEL.repeat(3000)}\n${'<channel from="x">x</channel>'.repeat(300)}`;
    const out = renderMessageMarkdown(body);
    expect(out.split('class="channel-tag"').length - 1).toBe(300);
  });

  it('leaves marker characters intact in a body with no envelope at all', () => {
    // Regression guard, and honestly labelled as one: with nothing to
    // splice this passed every rejected revision too.
    const out = renderMessageMarkdown(`before ${SENTINEL}0${SENTINEL} after`);
    expect(out).toContain(`before ${SENTINEL}0${SENTINEL} after`);
    expect(out).not.toContain('channel-tag');
  });

  it('keeps markdown inside a channel envelope as payload, not markup', () => {
    // An envelope carrying markdown-shaped text must not have that text
    // restructure the envelope around it.
    const out = renderMessageMarkdown('<channel from="x">## not a heading\n- not a list</channel>');
    expect(out).toContain('class="channel-tag"');
    expect(out).not.toContain('<h2>');
    expect(out).not.toContain('<ul>');
    expect(out).toContain('## not a heading');
  });

  it('renders prose either side of an envelope as its own markdown', () => {
    const out = renderMessageMarkdown(
      '## Before\n\n<channel from="x">p</channel>\n\n- after one\n- after two',
    );
    expect(out).toContain('<h2>Before</h2>');
    expect(out).toContain('class="channel-tag"');
    expect(out).toContain('<li>after one</li>');
    expect(out.indexOf('<h2>')).toBeLessThan(out.indexOf('channel-tag'));
    expect(out.indexOf('channel-tag')).toBeLessThan(out.indexOf('<li>'));
  });
});

describe('renderMessageMarkdown — known limits, asserted so they stay deliberate', () => {
  it('does not resolve a reference link across an envelope', () => {
    // The one behaviour change from splicing rather than substituting.
    // Prose segments are separate markdown documents, so document-level
    // state does not cross an envelope. Block constructs already could
    // not span one, so this is narrow — but it is a real change and is
    // recorded here rather than left to be discovered.
    const across = renderMessageMarkdown(
      '[docs]\n\n<channel from="x">p</channel>\n\n[docs]: https://example.com/d',
    );
    expect(across).toContain('[docs]');
    expect(across).not.toContain('href="https://example.com/d"');

    // Within one segment it resolves, which is what makes the above a
    // property of the segment boundary and not of link handling.
    const within = renderMessageMarkdown('[docs]\n\n[docs]: https://example.com/d');
    expect(within).toContain('href="https://example.com/d"');
  });

  it('treats an attribute-free <channel> as text, not as an envelope', () => {
    // Pre-existing and unchanged by this PR: the lift pattern requires
    // whitespace-then-attributes, so a bare `<channel>` is escaped
    // prose. Real envelopes always carry attributes. Noted by Rune
    // while probing; asserted so a future regex change has to decide
    // about it on purpose.
    const out = renderMessageMarkdown('<channel>x</channel>');
    expect(out).toContain('&lt;channel&gt;');
    expect(out).not.toContain('channel-tag');
  });

  it('treats an unclosed envelope as text', () => {
    const out = renderMessageMarkdown('<channel from="a">never closed');
    expect(out).toContain('&lt;channel');
    expect(out).not.toContain('channel-tag');
  });
});
