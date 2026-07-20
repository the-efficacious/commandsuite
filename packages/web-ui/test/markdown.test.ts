import { describe, expect, it } from 'vitest';
import { renderInlineMarkdown } from '../src/lib/markdown.js';

describe('renderInlineMarkdown', () => {
  it('escapes HTML metacharacters', () => {
    expect(renderInlineMarkdown('<script>alert(1)</script>')).toBe(
      '&lt;script&gt;alert(1)&lt;/script&gt;',
    );
  });

  it('renders bold', () => {
    expect(renderInlineMarkdown('this is **important**')).toBe(
      'this is <strong>important</strong>',
    );
  });

  it('renders italic', () => {
    expect(renderInlineMarkdown('a *subtle* hint')).toBe('a <em>subtle</em> hint');
  });

  it('renders inline code', () => {
    expect(renderInlineMarkdown('use `foo()` instead')).toBe('use <code>foo()</code> instead');
  });

  it('does not format inside code spans', () => {
    expect(renderInlineMarkdown('`**not bold**`')).toBe('<code>**not bold**</code>');
  });

  it('preserves newlines as <br>', () => {
    expect(renderInlineMarkdown('line one\nline two')).toBe('line one<br>line two');
  });

  it('sanitizes then formats — no HTML injection via bold markers', () => {
    expect(renderInlineMarkdown('**<b>x</b>**')).toBe('<strong>&lt;b&gt;x&lt;/b&gt;</strong>');
  });

  it('renders channel tags with syntax coloring', () => {
    const input = '<channel source="csuite" from="scout">hello</channel>';
    const result = renderInlineMarkdown(input);
    expect(result).toContain('class="channel-tag"');
    expect(result).toContain('class="ch-name">channel</span>');
    expect(result).toContain('class="ch-attr">source</span>');
    expect(result).toContain('class="ch-val">&quot;csuite&quot;</span>');
    expect(result).toContain('class="ch-body">hello</div>');
    expect(result).not.toContain('&lt;channel');
  });

  it('renders realistic multiline channel tags with many attributes', () => {
    const input =
      '<channel source="csuite" msg_id="13881ea1" level="info" ts="04/15/26 17:47:58 UTC" ts_ms="1776275278880" thread="dm" from="przy" target="test-agent-1">\nread you loud and clear! Thank you!\n</channel>';
    const result = renderInlineMarkdown(input);
    expect(result).toContain('class="channel-tag"');
    expect(result).toContain('class="ch-attr">source</span>');
    expect(result).toContain('class="ch-attr">from</span>');
    expect(result).toContain('class="ch-val">&quot;przy&quot;</span>');
    expect(result).toContain('class="ch-body">');
    expect(result).toContain('read you loud and clear');
  });

  it('leaves non-channel HTML tags escaped', () => {
    const input = '<div>not a channel</div>';
    const result = renderInlineMarkdown(input);
    expect(result).toContain('&lt;div&gt;');
    expect(result).not.toContain('channel-tag');
  });
});
