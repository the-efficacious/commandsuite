#!/usr/bin/env bash
# Prove a `docker compose up` of this checkout: the four assertions the
# deployment docs promise, then the same four after a restart (the
# entrypoint re-runs the bring-up idempotently against the volume), then
# down. Used by CI and by anyone verifying the container by hand.
#
#   scripts/compose-check.sh            # up → assert → restart → assert → down -v
#   KEEP=1 scripts/compose-check.sh     # leave it running afterwards
#
# Requires docker with the compose plugin. Prints what it saw; exits
# non-zero at the first assertion that is not true.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

PORT="${CSUITE_PORT:-8717}"
URL="http://127.0.0.1:$PORT"
compose() { docker compose "$@"; }
say()  { printf '\n== %s\n' "$*"; }
ok()   { printf '   ok  %s\n' "$*"; }
die()  { printf '\n   FAIL %s\n' "$*" >&2; compose logs --no-color --tail=40 csuite >&2 || true; [ "${KEEP:-0}" = 1 ] || compose down -v >/dev/null 2>&1 || true; exit 1; }

wait_healthy() {
  for _ in $(seq 1 60); do
    case "$(compose ps --format '{{.Health}}' csuite 2>/dev/null)" in
      healthy) return 0 ;;
      unhealthy) return 1 ;;
    esac
    sleep 3
  done
  return 1
}

assert_all() {
  say "$1: broker and web UI"
  local code; code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$URL/healthz")"
  [ "$code" = 200 ] || die "GET /healthz returned $code"
  ok "/healthz 200"
  curl -s --max-time 5 "$URL/" | grep -q '<title>CommandSuite</title>' || die "GET / did not serve the web UI"
  ok "/ serves the web UI"

  say "$1: seeded member can use the API (token read from the volume, never printed)"
  local token; token="$(compose exec -T csuite cat /var/lib/csuite/secrets/admin.token)"
  [ -n "$token" ] || die "no admin token on the volume"
  curl -s --max-time 5 -H "Authorization: Bearer $token" "$URL/roster" | grep -q '"name":"'"${CSUITE_ADMIN:-admin}"'"' || die "roster as ${CSUITE_ADMIN:-admin} failed"
  ok "authenticated roster lists ${CSUITE_ADMIN:-admin}"

  say "$1: runner member's credential resolves inside the container with no env token"
  compose exec -T -w /var/lib/csuite/runner csuite \
    env -i HOME=/home/node PATH=/app/packages/csuite/node_modules/.bin:/usr/local/bin:/usr/bin:/bin \
      CSUITE_URL=http://127.0.0.1:8717 CSUITE_AUTH_CONFIG_PATH=/var/lib/csuite/auth.json \
      csuite roster </dev/null | grep -q "^${CSUITE_RUNNER:-builder} " || die "saved auth for the runner member did not resolve from /var/lib/csuite/runner"
  ok "saved auth for (http://127.0.0.1:8717, /var/lib/csuite/runner) resolves; roster lists ${CSUITE_RUNNER:-builder}"
  compose exec -T csuite stat -c '%a %n' /var/lib/csuite/secrets/admin.token /var/lib/csuite/secrets/admin.totp | grep -vq '^600 ' && die "secret files are not 0600" || ok "secret files are mode 0600 on the volume"

  if [ "${CSUITE_START_RUNNER:-0}" = 1 ]; then
    say "$1: stub runner connected (CSUITE_START_RUNNER=1, verb stub)"
    local rconn=0
    for _ in $(seq 1 30); do
      if curl -s --max-time 5 -H "Authorization: Bearer $token" "$URL/roster" | grep -q '"name":"'"${CSUITE_RUNNER:-builder}"'"[^}]*"connected":1'; then rconn=1; break; fi
      sleep 2
    done
    [ "$rconn" = 1 ] || die "roster never showed ${CSUITE_RUNNER:-builder} connected=1 with the stub started"
    ok "roster shows ${CSUITE_RUNNER:-builder} connected=1 (stub runner)"
    curl -s --max-time 5 -H "Authorization: Bearer $token" "$URL/roster" | grep -q '"name":"'"${CSUITE_RUNNER:-builder}"'"[^}]*"title":"stub runner (CI instrument)"' || die "the stub member's roster title does not name it a stub"
    ok "roster title names the stub: 'stub runner (CI instrument)'"
    # The activity uploader batches: session_start can lag connected=1 by
    # a flush window, so poll with the same bound as the connection.
    local sstart=0
    for _ in $(seq 1 30); do
      if curl -s --max-time 5 -H "Authorization: Bearer $token" "$URL/members/${CSUITE_RUNNER:-builder}/activity?limit=50" | grep -q '"kind":"session_start"'; then sstart=1; break; fi
      sleep 2
    done
    [ "$sstart" = 1 ] || die "no session_start activity event for the stub runner within 60s"
    ok "session_start activity event present for ${CSUITE_RUNNER:-builder}"
  fi

  say "$1: in-container doctor — broker-only image reports the agent binary absent by design, not failed"
  local doctor
  doctor="$(compose exec -T -w /var/lib/csuite/runner csuite \
    env -i HOME=/home/node PATH=/app/packages/csuite/node_modules/.bin:/usr/local/bin:/usr/bin:/bin \
      CSUITE_URL=http://127.0.0.1:8717 CSUITE_AUTH_CONFIG_PATH=/var/lib/csuite/auth.json \
      csuite claude --doctor </dev/null)" || die "csuite claude --doctor exited non-zero in the container"
  printf '%s\n' "$doctor" | grep -q 'absent by design' || die "doctor did not report the agent binary as absent by design"
  printf '%s\n' "$doctor" | grep -q 'doctor: OK' || die "doctor did not end OK (the absent agent binary must be advisory, not FAIL)"
  ok "doctor: OK with '[WARN] claude binary — absent by design'"
}

say "build + up"
compose up -d --build
wait_healthy || die "container did not become healthy (see logs)"
ok "container healthy"
assert_all "first start"

say "restart — the entrypoint re-runs the bring-up against the volume"
compose restart csuite
wait_healthy || die "container did not become healthy after restart"
ok "healthy after restart"
assert_all "after restart"
# grep -c, not grep -q: -q closes the pipe on the first match and pipefail
# would turn `docker compose logs` SIGPIPE into a failure.
[ "$(compose logs --no-color --no-log-prefix csuite | grep -c "already seeded")" -ge 1 ] || die "second bring-up did not report the volume as already seeded"
ok "second bring-up was idempotent (already seeded, already enrolled)"

say "what this proves and what it does not"
if [ "${CSUITE_START_RUNNER:-0}" = 1 ]; then
  printf '   --  the container ran the STUB runner (a test/CI instrument, never a deployable member): the roster\n'
  printf '       showed connected=1 and a session_start event — a measured connection, no model anywhere.\n'
else
  printf '   --  the container stops at an enrolled runner member (credential on the volume, --doctor green); a live\n'
  printf '       model runner runs outside it (docs/guides/always-on-agent), or set CSUITE_START_RUNNER=1 with\n'
  printf '       CSUITE_RUNNER_VERB=stub for the credential-free test instrument.\n'
fi

if [ "${KEEP:-0}" = 1 ]; then
  say "leaving the stack running (KEEP=1): $URL"
else
  say "down"
  compose down -v >/dev/null
  ok "stack removed, volume deleted"
fi
