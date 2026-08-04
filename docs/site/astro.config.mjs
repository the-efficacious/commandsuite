import cloudflare from '@astrojs/cloudflare';
import { unified } from '@astrojs/markdown-remark';
import mdx from '@astrojs/mdx';
import { defineConfig } from 'astro/config';

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
      theme: 'github-dark',
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
