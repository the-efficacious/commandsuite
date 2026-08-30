# syntax=docker/dockerfile:1
# CommandSuite — broker + CLI in one image, built from this checkout.
#
# Two stages on one pinned base. The builder installs the workspace with
# the pinned pnpm, builds every package, then re-installs production-only
# for the `csuite` meta-package and its dependencies (drops the UI build
# tooling and test frameworks). The runtime copies that pruned tree, the
# bootstrap script, and nothing else — no sources, no tests, no secrets.
#
# Size note: the tree carries @anthropic-ai/claude-agent-sdk (~263 MB), a
# hard dependency of csuite-cli that `csuite claude --doctor` checks for.
# Splitting it out is a CLI dependency-shape change, tracked on #198.
#
# Base pinned by digest; bump deliberately.
ARG NODE_IMAGE=node:22-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5

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
# store is warm so this is offline and fast. csuite-cli declares the
# broker as a peer dependency (it loads it lazily for `setup`/`serve`);
# the production install does not re-link that peer, so link it where a
# dev install puts it. Then drop what the runtime never reads.
RUN pnpm install --prod --frozen-lockfile --offline --filter "csuite..." \
 && ln -sfn ../../../apps/server packages/cli/node_modules/csuite-server \
 && rm -rf apps/web-host packages/web-ui docs scripts/test \
      packages/*/src packages/*/test apps/server/src apps/server/test \
      .turbo packages/*/.turbo apps/*/.turbo

# ---- runtime ----------------------------------------------------------
FROM ${NODE_IMAGE}
# curl: scripts/bootstrap.sh's health checks and the container healthcheck.
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
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
