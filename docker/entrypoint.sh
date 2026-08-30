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

if [ "${1:-}" = "serve-only" ]; then
  cd "$CSUITE_BOOTSTRAP_DIR"
  # Escape hatch: skip the bring-up and just serve an already-seeded volume.
  exec "$CLI" serve --host 0.0.0.0 --port "$CSUITE_PORT" --config-path "$CSUITE_BOOTSTRAP_DIR/server/csuite.json"
fi

# Run from the state directory: the broker keeps its file blob store at
# ./data/files relative to its cwd, and that belongs on the volume.
mkdir -p "$CSUITE_BOOTSTRAP_DIR" && cd "$CSUITE_BOOTSTRAP_DIR"

echo "csuite container: bring-up via scripts/bootstrap.sh (state: $CSUITE_BOOTSTRAP_DIR)"
/app/scripts/bootstrap.sh up </dev/null
/app/scripts/bootstrap.sh down

echo "csuite container: bring-up complete; broker moving to the foreground on 0.0.0.0:$CSUITE_PORT"
echo "csuite container: no live runner started (CSUITE_START_RUNNER unset or no model credential in a container); the enrolled runner member's credential is on the volume"
exec "$CLI" serve --host 0.0.0.0 --port "$CSUITE_PORT" --config-path "$CSUITE_BOOTSTRAP_DIR/server/csuite.json"
