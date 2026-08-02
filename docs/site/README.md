# docs/site

The plumbing behind **[docs.commandsuite.io](https://docs.commandsuite.io)** — an
Astro site deployed to Cloudflare Workers.

**The docs content does not live here.** It is the `docs/` tree one directory up,
versioned with the product. This directory is presentation only: layout,
navigation, styling, and deployment.

- **Fix or improve the docs?** → edit `docs/*.mdx`.
- **Fix the docs *site*** (layout, nav, styling)? → edit here.

Either way it is one PR against this repo, and CI builds the site for both.

## How it works

`src/content.config.ts` points its content collection at `..` — the sibling
`docs/` tree — excluding `site/`. There is no sync step and no generated copy of
the content; Astro reads the same files you edit. Only `*.mdx` is picked up, so
plain `*.md` under `docs/` (internal notes such as `docs/audit/`, which have no
frontmatter) is not published.

Deploys run from `.github/workflows/docs-deploy.yml` at the repo root: pushes to
`main` touching `docs/**` deploy, pull requests touching `docs/**` build only.

## Not part of the monorepo workspace

This app is deliberately outside the root pnpm workspace so the
Astro/Cloudflare toolchain stays out of the monorepo install, the turbo graph,
and the release pipeline. `pnpm-workspace.yaml` here is what enforces it — pnpm
searches upward for the nearest one, and without it a `pnpm install` in this
directory installs the monorepo instead, skips this package, and exits 0.

Practically: run `pnpm` commands from **this directory**, not the repo root.
Root `pnpm install` / `build` / `test` do not touch the site, and `pnpm lint` at
the root excludes it (see `biome.json`).

## Dev

```bash
cd docs/site
pnpm install
pnpm dev        # astro dev on :4322, reading ../ for content
pnpm build      # production build
pnpm typecheck  # astro check
pnpm deploy     # build + wrangler deploy (needs Cloudflare auth)
```

### Two things that will bite you

**Deploy must be pointed at the generated config.** The Cloudflare Vite plugin
writes a resolved config to `dist/client/wrangler.json` during the build, and
only that copy has `assets.directory` pointing at the built client directory.
`wrangler deploy` without `-c dist/client/wrangler.json` uploads the wrong
directory. The root `wrangler.jsonc` is the *source* config and deliberately
omits `directory` for this reason.

**`sharp` is pinned by an override.** Astro 7.1.6 depends on sharp 0.34.5, which
carries the libvips advisories in
[GHSA-f88m-g3jw-g9cj](https://github.com/advisories/GHSA-f88m-g3jw-g9cj), patched
in 0.35.0. Astro is already latest, so `pnpm.overrides` is the only lever. It is
safe here — the adapter does image work through the Cloudflare `IMAGES` binding,
the docs are text-only MDX, and miniflare already resolved 0.35.x. Drop the
override once Astro ships a patched range.

**TypeScript is held at 6.x**, not 7. `astro check` runs on the Volar/TypeScript
programmatic API, which TypeScript's native 7.x compiler does not ship yet.

## License

Apache-2.0, same as the rest of the repo.
