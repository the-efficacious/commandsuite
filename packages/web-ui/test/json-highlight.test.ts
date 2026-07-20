/**
 * Unit tests for the JSON syntax highlighter used by the activity and
 * trace viewers. Asserts token classification, the non-JSON passthrough
 * (returns null so command output / prose renders plain), lossless
 * round-tripping, and HTML-escaping of untrusted string content.
 */

import { describe, expect, it } from 'vitest';
import { highlightJson } from '../src/lib/json-highlight.js';

/** HTML-escape the way the highlighter does, for round-trip assertions. */
function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

describe('highlightJson', () => {
  it('colors keys, string values, numbers, and literals distinctly', () => {
    const html = highlightJson(
      JSON.stringify({ name: 'sink', retries: 3, ok: true, prev: null }, null, 2),
    );
    expect(html).not.toBeNull();
    expect(html).toContain('<span class="jk">&quot;name&quot;</span>');
    expect(html).toContain('<span class="js">&quot;sink&quot;</span>');
    expect(html).toContain('<span class="jn">3</span>');
    expect(html).toContain('<span class="jb">true</span>');
    expect(html).toContain('<span class="jb">null</span>');
    expect(html).toContain('<span class="jp">'); // braces / colons / commas
  });

  it('returns null for non-JSON text so command output and prose pass through', () => {
    expect(highlightJson('Tests  9 passed (9)')).toBeNull();
    expect(highlightJson('Applied 1 edit to activity-uploader.ts')).toBeNull();
    expect(highlightJson('')).toBeNull();
    expect(highlightJson('   \n  ')).toBeNull();
    // A JSON scalar (not an object/array) is left alone too.
    expect(highlightJson('"just a quoted string"')).toBeNull();
    expect(highlightJson('42')).toBeNull();
  });

  it('returns null for malformed JSON so partial text is never mangled', () => {
    expect(highlightJson('{ "a": ')).toBeNull();
    expect(highlightJson('{ oops }')).toBeNull();
    expect(highlightJson('{ "a": 1,, }')).toBeNull();
  });

  it('HTML-escapes untrusted string content (no injection through the pre)', () => {
    const html = highlightJson(JSON.stringify({ cmd: '<script>alert(1)</script>' }, null, 2));
    expect(html).not.toBeNull();
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    // …and the escaped payload is wrapped as a string value, not raw.
    expect(html).toContain('<span class="js">');
  });

  it('distinguishes a string value from a key', () => {
    const html = highlightJson(JSON.stringify({ k: 'v' }, null, 2));
    expect(html).toContain('<span class="jk">&quot;k&quot;</span>');
    expect(html).toContain('<span class="js">&quot;v&quot;</span>');
    expect(html).not.toContain('<span class="jk">&quot;v&quot;</span>');
  });

  it('highlights arrays and nested structures', () => {
    const html = highlightJson(
      JSON.stringify({ paths: ['a.ts', 'b.ts'], nested: { n: 2 } }, null, 2),
    );
    expect(html).toContain('<span class="jk">&quot;paths&quot;</span>');
    expect(html).toContain('<span class="js">&quot;a.ts&quot;</span>');
    expect(html).toContain('<span class="jk">&quot;nested&quot;</span>');
    expect(html).toContain('<span class="jn">2</span>');
  });

  it('handles negative, decimal, and exponent numbers', () => {
    const html = highlightJson(JSON.stringify({ exit: -1, ratio: 0.5, big: 1.2e9 }, null, 2));
    expect(html).toContain('<span class="jn">-1</span>');
    expect(html).toContain('<span class="jn">0.5</span>');
    expect(html).toContain('<span class="jn">1200000000</span>');
  });

  it('is lossless — stripping the spans returns the escaped original', () => {
    const input = JSON.stringify(
      { command: 'echo "hi"', exitCode: 0, ok: true, tags: ['x', 'y'] },
      null,
      2,
    );
    const html = highlightJson(input);
    expect(html).not.toBeNull();
    const stripped = (html as string).replace(/<[^>]+>/g, '');
    expect(stripped).toBe(esc(input));
  });
});
