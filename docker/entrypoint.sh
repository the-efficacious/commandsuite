#!/usr/bin/env bash
# Container entrypoint: bring the ecosystem up with nobody at a terminal,
# then run the broker in the foreground as PID 1.
#
# scripts/bootstrap.sh is the whole sequence and its contract is unchanged:
# it seeds the team without a TTY, starts the broker on loopback, proves
# /healthz, the web UI, an authenticated roster and a TOTP sign-in,
# enrols the runner member through the real device-code flow (approved
# from the CLI as the bootstrap member), and proves that credential
# resolves from the runner workspace with no env token and that
# `csuite <runner> --doctor` is green. It backgrounds the broker on
# 127.0.0.1 by design; a container needs it on 0.0.0.0 for the port
# mapping, so after the sequence we stop that broker and exec the real
# one in the foreground. State lives on the volume, so a restart re-runs
# `up` idempotently (already seeded, already enrolled) in a few seconds.
#
# Secrets (bearer token, TOTP secret) are written by the script to
# $CSUITE_BOOTSTRAP_DIR/secrets at mode 0600 and never printed here.
set -euo pipefail

: "${CSUITE_BOOTSTRAP_DIR:=/var/lib/csuite}"
: "${CSUITE_PORT:=8717}"
export CSUITE_BOOTSTRAP_DIR CSUITE_PORT
export CSUITE_AUTH_CONFIG_PATH="${CSUITE_AUTH_CONFIG_PATH:-$CSUITE_BOOTSTRAP_DIR/auth.json}"
# The product's own entry: the `csuite` meta-package's bin, whose
# node_modules link the CLI, the broker, core and the SDK together — the
# CLI's dynamic import of csuite-server resolves from there. bootstrap.sh
# honours CSUITE_BIN; the same binary serves in the foreground below.
CLI=/app/packages/csuite/bin/csuite.mjs
export CSUITE_BIN="$CLI"

# The container's outcome is a seeded team, a reachable UI and an
# enrolled runner member — enrolled meaning its credential resolves and
# `--doctor` is green. A live model runner inside the container (a model
# credential in the image or volume, two long-lived processes under one
# PID 1, restart semantics for both) is a different thing with its own
# doors; it is refused here rather than silently not done. Attach a
# runner from outside: docs/guides/always-on-agent.
# The stub runner (a test/CI instrument, no model credential) is the one
# exception: CSUITE_START_RUNNER=1 with CSUITE_RUNNER_VERB=stub starts it
# against the real broker once /healthz answers, so CI can observe
# connected=1 instead of stopping at an enrolled credential.
if [ "${CSUITE_START_RUNNER:-0}" != 0 ] && [ "${CSUITE_RUNNER_VERB:-claude}" != stub ]; then
  echo "csuite container: CSUITE_START_RUNNER is not supported for model runners in the container; run the runner outside it (docs/guides/always-on-agent) and enrol it against this broker with csuite connect. (CSUITE_RUNNER_VERB=stub, the credential-free test instrument, is the exception.)" >&2
  exit 64
fi
START_STUB=0
if [ "${CSUITE_START_RUNNER:-0}" != 0 ] && [ "${CSUITE_RUNNER_VERB:-claude}" = stub ]; then
  START_STUB=1
  # The bring-up below runs against a loopback broker and then stops it,
  # which would kill a step-8 runner with it — so keep the bring-up
  # runner-free and start the stub against the real broker instead.
  export CSUITE_START_RUNNER=0
fi

if [ "${1:-}" = "serve-only" ]; then
  cd "$CSUITE_BOOTSTRAP_DIR" && touch "$CSUITE_BOOTSTRAP_DIR/.ready"
  # Escape hatch: skip the bring-up and just serve an already-seeded volume.
  exec "$CLI" serve --host 0.0.0.0 --port "$CSUITE_PORT" --config-path "$CSUITE_BOOTSTRAP_DIR/server/csuite.json"
fi

# Run from the state directory: the broker keeps its file blob store at
# ./data/files relative to its cwd, and that belongs on the volume.
mkdir -p "$CSUITE_BOOTSTRAP_DIR" && cd "$CSUITE_BOOTSTRAP_DIR"
# The healthcheck requires this marker as well as /healthz: during the
# bring-up the script's own loopback broker answers /healthz, and
# "healthy" must mean the final broker below, not that one.
rm -f "$CSUITE_BOOTSTRAP_DIR/.ready"

echo "csuite container: bring-up via scripts/bootstrap.sh (state: $CSUITE_BOOTSTRAP_DIR)"
/app/scripts/bootstrap.sh up </dev/null
/app/scripts/bootstrap.sh down

echo "csuite container: bring-up complete; broker moving to the foreground on 0.0.0.0:$CSUITE_PORT"
touch "$CSUITE_BOOTSTRAP_DIR/.ready"
if [ "$START_STUB" = 1 ]; then
  # Background child survives the exec below (it stays a child of this
  # PID); it waits for the real broker, then runs the stub runner from
  # the enrolled workspace so the roster shows connected=1.
  (
    until curl -fsS "http://127.0.0.1:$CSUITE_PORT/healthz" >/dev/null 2>&1; do sleep 1; done
    cd "$CSUITE_BOOTSTRAP_DIR/runner" && exec env CSUITE_URL="http://127.0.0.1:$CSUITE_PORT"       CSUITE_AUTH_CONFIG_PATH="$CSUITE_AUTH_CONFIG_PATH"       "$CLI" stub --skip-doctor >>"$CSUITE_BOOTSTRAP_DIR/runner.log" 2>&1
  ) </dev/null &
  echo "csuite container: stub runner starting against the foreground broker (test/CI instrument — never a deployable member; log: $CSUITE_BOOTSTRAP_DIR/runner.log)"
else
  echo "csuite container: stops at an enrolled runner member (credential on the volume, preflight green); a live model runner runs outside the container — see docs/guides/always-on-agent"
fi
exec "$CLI" serve --host 0.0.0.0 --port "$CSUITE_PORT" --config-path "$CSUITE_BOOTSTRAP_DIR/server/csuite.json"
