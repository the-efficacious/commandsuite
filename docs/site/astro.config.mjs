import cloudflare from '@astrojs/cloudflare';
import { unified } from '@astrojs/markdown-remark';
import mdx from '@astrojs/mdx';
import { helm } from '@the-efficacious/brand';
import { defineConfig } from 'astro/config';

/**
 * Shiki theme derived from the kit's code roles: the five --ef-code-*
 * colours plus the text tiers, resolved through the brand package so no
 * colour literal lives in this repo. Fences land on the deep surface —
 * inset wells under the article (docs.css draws the matching frame).
 *
 * Static builds bake these as hexes, so a `data-ef-theme` swap does not
 * re-resolve fences; the docs ship helm dark and that is fine. If the
 * site ever grows a theme toggle, this is the one place that needs work.
 */
function helmCodeTheme() {
  const c = helm.color;
  return {
    name: 'helm',
    type: 'dark',
    colors: {
      'editor.background': c.surfaceDeep,
      'editor.foreground': c.text,
    },
    tokenColors: [
      {
        scope: ['comment', 'punctuation.definition.comment'],
        settings: { foreground: c.codeComment, fontStyle: 'italic' },
      },
      {
        scope: ['string', 'string.quoted', 'punctuation.definition.string'],
        settings: { foreground: c.codeString },
      },
      {
        scope: ['constant.numeric', 'constant.language', 'constant.character', 'constant.other'],
        settings: { foreground: c.codeNumber },
      },
      {
        scope: ['keyword', 'storage.type', 'storage.modifier'],
        settings: { foreground: c.codeKeyword },
      },
      {
        scope: ['keyword.operator', 'punctuation', 'meta.brace'],
        settings: { foreground: c.codePunctuation },
      },
      {
        scope: ['entity.name.function', 'support.function'],
        settings: { foreground: c.text },
      },
      {
        scope: [
          'entity.name.type',
          'entity.name.class',
          'support.type',
          'support.class',
          'entity.name.tag',
        ],
        settings: { foreground: c.codeKeyword },
      },
      {
        scope: ['variable', 'variable.other', 'variable.parameter'],
        settings: { foreground: c.textSecondary },
      },
      {
        scope: ['entity.other.attribute-name'],
        settings: { foreground: c.textSecondary },
      },
      { scope: ['markup.heading'], settings: { foreground: c.text } },
      { scope: ['markup.bold'], settings: { fontStyle: 'bold' } },
      { scope: ['markup.italic'], settings: { fontStyle: 'italic' } },
    ],
  };
}

/**
 * The synced OSS docs still carry legacy `/docs/...` internal links from the
 * era when this site was mounted at agentc7.com/docs. The site is root-mounted
 * now, so strip the `/docs` prefix from internal links at build time.
 */
function rehypeStripDocsPrefix() {
  return (tree) => {
    const visit = (node) => {
      if (node.type === 'element' && node.tagName === 'a') {
        const href = node.properties?.href;
        if (typeof href === 'string') {
          if (href === '/docs' || href === '/docs/') {
            node.properties.href = '/';
          } else if (href.startsWith('/docs/')) {
            node.properties.href = href.slice('/docs'.length);
          }
        }
      }
      if (Array.isArray(node.children)) {
        node.children.forEach(visit);
      }
    };
    visit(tree);
  };
}

export default defineConfig({
  site: 'https://docs.commandsuite.io',
  output: 'static',
  adapter: cloudflare(),
  // The 2026-08 restructure moved the contributor-facing pages under dev/.
  // Old URLs stay alive.
  redirects: {
    '/architecture': '/dev/architecture',
    '/reference/rest-api': '/dev/rest-api',
    '/reference/mcp-tools': '/dev/mcp-tools',
    '/reference/ipc-protocol': '/dev/ipc-protocol',
    '/runners/conformance': '/dev/conformance',
    // The team-process rename (process_document → team_process) moved
    // the concept page with everything else that carried the old name.
    '/concepts/process-document': '/concepts/team-process',
  },
  integrations: [mdx()],
  markdown: {
    // Astro 7 defaults to the Sätteri processor and deprecates top-level
    // `rehypePlugins`. Sätteri's plugin model (mdast/hast) is not the unified
    // one this plugin is written against, so opt back into `unified()` rather
    // than port it — the link rewrite below is load-bearing for ~95 legacy
    // links and its semantics should not shift underneath it.
    processor: unified({ rehypePlugins: [rehypeStripDocsPrefix] }),
    shikiConfig: {
      theme: helmCodeTheme(),
      wrap: true,
    },
  },
  build: {
    format: 'directory',
  },
  devToolbar: {
    enabled: false,
  },
});
