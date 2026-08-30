# syntax=docker/dockerfile:1
# CommandSuite — broker + CLI in one image, built from this checkout.
#
# Two stages on one pinned base. The builder installs the workspace with
# the pinned pnpm, builds every package, then re-installs production-only
# for the `csuite` meta-package and its dependencies (drops the UI build
# tooling and test frameworks). The runtime copies that pruned tree, the
# bootstrap script, and nothing else — no sources, no tests, no secrets.
#
# This is the broker-only image: the production install passes
# --no-optional, which drops the agent binaries (the Claude Agent SDK is
# an optionalDependency of csuite-cli, ~263 MB) AND the optional vitest
# peer of csuite-core with its vite/esbuild/jsdom chain (~70 MB). Broker
# verbs all work without them; `csuite <runner> --doctor` reports the
# agent binary as absent by design. To build an image that can run a
# live agent in-container, drop the --no-optional flag below (docs:
# docs/deployment.mdx).
#
# Bases pinned by digest; bump deliberately. The builder needs the full
# node toolchain (corepack/pnpm); the runtime needs only node itself, so
# it uses Alpine's dynamically-linked nodejs package (~60 MB lighter
# than the node image) — safe here because the production tree carries
# zero native modules (pure JS + node builtins; node:sqlite proven under
# musl by scripts/compose-check.sh).
ARG NODE_IMAGE=node:22-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5
ARG RUNTIME_IMAGE=alpine:3.22@sha256:14358309a308569c32bdc37e2e0e9694be33a9d99e68afb0f5ff33cc1f695dce

# ---- builder ----------------------------------------------------------
FROM ${NODE_IMAGE} AS builder
ENV CI=true COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /src
# Manifests first so dependency installation caches across source edits.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc* ./
COPY apps/server/package.json apps/server/
COPY apps/web-host/package.json apps/web-host/
COPY packages/cli/package.json packages/cli/
COPY packages/core/package.json packages/core/
COPY packages/csuite/package.json packages/csuite/
COPY packages/sdk/package.json packages/sdk/
COPY packages/web-ui/package.json packages/web-ui/
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build
# Production-only for the meta-package and its dependency closure; the
# store is warm so this is offline and fast. The dev tree is REMOVED
# first: `pnpm install --prod` over an existing node_modules prunes the
# top-level links but leaves the dev-era .pnpm content behind (measured:
# a 639 MB layer where a fresh install is 78 MB). csuite-cli declares
# the broker as a peer dependency (it loads it lazily for
# `setup`/`serve`); the production install does not re-link that peer,
# so link it where a dev install puts it. Then drop what the runtime
# never reads.
RUN rm -rf node_modules packages/*/node_modules apps/*/node_modules \
 && pnpm install --prod --frozen-lockfile --offline --no-optional --filter "csuite..." \
 && ln -sfn ../../../apps/server packages/cli/node_modules/csuite-server \
 && rm -rf apps/web-host packages/web-ui docs scripts/test \
      packages/*/src packages/*/test apps/server/src apps/server/test \
      .turbo packages/*/.turbo apps/*/.turbo

# ---- runtime ----------------------------------------------------------
FROM ${RUNTIME_IMAGE}
# bash: entrypoint.sh and bootstrap.sh; curl: their health checks and
# the container healthcheck. Alpine's nodejs is 22.x (node:sqlite and
# the fetch surface exist); the tree has no native modules, so musl is
# equivalent to glibc here — compose-check proves it end to end.
RUN apk add --no-cache nodejs bash curl ca-certificates \
 && adduser -D node
WORKDIR /app
COPY --from=builder --chown=node:node /src/package.json /src/pnpm-workspace.yaml ./
COPY --from=builder --chown=node:node /src/node_modules ./node_modules
COPY --from=builder --chown=node:node /src/packages ./packages
COPY --from=builder --chown=node:node /src/apps/server ./apps/server
COPY --from=builder --chown=node:node /src/scripts ./scripts
COPY --chown=node:node docker/entrypoint.sh /app/docker/entrypoint.sh
# State (server dir, secrets 0600, runner workspace, auth store) lives on
# a volume owned by the unprivileged user.
# npm marks package bins executable at install time; a plain COPY does not.
RUN chmod +x /app/packages/csuite/bin/*.mjs /app/scripts/bootstrap.sh \
 && chown node:node /app \
 && mkdir -p /var/lib/csuite && chown node:node /var/lib/csuite
ENV NODE_ENV=production \
    PATH=/app/packages/csuite/node_modules/.bin:$PATH \
    HOME=/home/node \
    CSUITE_BOOTSTRAP_DIR=/var/lib/csuite \
    CSUITE_AUTH_CONFIG_PATH=/var/lib/csuite/auth.json \
    CSUITE_PORT=8717
USER node
VOLUME ["/var/lib/csuite"]
EXPOSE 8717
HEALTHCHECK --interval=10s --timeout=3s --start-period=90s --retries=12 \
  CMD test -f /var/lib/csuite/.ready && curl -fsS http://127.0.0.1:8717/healthz || exit 1
ENTRYPOINT ["/app/docker/entrypoint.sh"]
