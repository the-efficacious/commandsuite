#!/usr/bin/env bash
# The service gate as a host-runnable script (obj-mtg8urof-p) — the
# same sequence the CI `service` job runs in bootstrap.yml: broker up
# with an enrolled runner, install-service with broker-observed
# liveness, systemd-analyze verify, reinstall over the root-0440
# sudoers (the privileged snapshot path), cycle via the scoped rule,
# and a teardown that proves no surviving process.
#
# Requires: systemd as PID 1, passwordless sudo, a built workspace.
# Refuses to run against a unit that already exists for this user —
# never touch a real seat's service (release preparation must be able
# to run on a box that hosts a live runner).
set -euo pipefail
cd "$(dirname "$0")/.."

PORT="${CSUITE_SERVICE_CHECK_PORT:-8733}"
DIR="${CSUITE_SERVICE_CHECK_DIR:-$(mktemp -d /tmp/csuite-service-check.XXXXXX)}"
UNIT="csuite-$(id -un)"

if systemctl list-unit-files "${UNIT}.service" 2>/dev/null | grep -q "${UNIT}.service"; then
  if systemctl is-active --quiet "$UNIT"; then
    echo "service-check: unit $UNIT already exists and is active on this host — refusing to run the install/teardown cycle over a live seat" >&2
    echo "service-check: run on a host whose $UNIT is not a real runner (CI, or a scratch box)" >&2
    exit 3
  fi
fi

cleanup() {
  sudo systemctl disable --now "$UNIT" >/dev/null 2>&1 || true
  sudo rm -f "/etc/systemd/system/$UNIT.service" "/etc/sudoers.d/$(id -un)-csuite-runner"
  sudo systemctl daemon-reload
  CSUITE_BOOTSTRAP_DIR="$DIR" scripts/bootstrap.sh down >/dev/null 2>&1 || true
  if pgrep -af "dist/index.js stub" | grep -v "bash -c" | grep -q "$DIR"; then
    echo "service-check: leaked stub process" >&2
    exit 1
  fi
}
trap cleanup EXIT

CSUITE_BOOTSTRAP_DIR="$DIR" CSUITE_PORT="$PORT" scripts/bootstrap.sh up </dev/null

cd "$DIR/runner"
node "$OLDPWD/packages/cli/dist/index.js" stub install-service --url "http://127.0.0.1:$PORT" --timeout 90
systemd-analyze verify "/etc/systemd/system/$UNIT.service"
[ "$(sudo stat -c %a "/etc/sudoers.d/$(id -un)-csuite-runner")" = 440 ]
echo "unit verified; sudoers at 0440"

node "$OLDPWD/packages/cli/dist/index.js" stub install-service --url "http://127.0.0.1:$PORT" --timeout 90 | tee "$DIR/reinstall.out"
grep -q "replaced the previous install" "$DIR/reinstall.out"

LOG="$HOME/.local/var/csuite-cycle.log"
: > "$LOG" || true
node "$OLDPWD/packages/cli/dist/index.js" stub cycle --url "http://127.0.0.1:$PORT" --timeout 90
for _ in $(seq 1 60); do
  if grep -qE "✓ cycled|failed|never showed" "$LOG" 2>/dev/null; then break; fi
  sleep 2
done
grep -q "✓ cycled" "$LOG"
if grep -qE "failed|never showed" "$LOG"; then
  echo "service-check: cycle log contains a failure line" >&2
  exit 1
fi
echo "service-check: install, reinstall, cycle all green"
