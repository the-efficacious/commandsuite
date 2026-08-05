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

  it('keeps markdown inside a channel envelope as payload, not markup', () => {
    // An envelope carrying markdown-shaped text must not have that text
    // restructure the envelope around it.
    const out = renderMessageMarkdown('<channel from="x">## not a heading\n- not a list</channel>');
    expect(out).toContain('class="channel-tag"');
    expect(out).not.toContain('<h2>');
    expect(out).not.toContain('<ul>');
    expect(out).toContain('## not a heading');
  });
});
