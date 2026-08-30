#!/usr/bin/env bash
# Bring up the whole CommandSuite ecosystem with nobody at a terminal:
# a broker with a seeded team and member, the web UI reachable and
# signed into, and a runner member enrolled through the real device-code
# flow so its credential resolves from its working directory with no
# environment variable. Every step is checked; the script exits non-zero
# at the first thing that is not true.
#
# Usage:
#   scripts/bootstrap.sh up      # bring everything up and verify (default)
#   scripts/bootstrap.sh verify  # re-run the checks against a running stack
#   scripts/bootstrap.sh down    # stop the broker started by `up`
#
# Environment (all optional):
#   CSUITE_BIN            csuite executable. Default: this repo's built CLI
#                         (packages/cli/dist/index.js) when run from a checkout,
#                         else `csuite` on PATH.
#   CSUITE_BOOTSTRAP_DIR  where state lives. Default: ./.csuite-bootstrap
#   CSUITE_PORT           broker port. Default: 8717
#   CSUITE_TEAM           team name. Default: bootstrap
#   CSUITE_ADMIN          bootstrap member (holds every permission). Default: admin
#   CSUITE_RUNNER         runner member created for the enrolled device. Default: builder
#   CSUITE_AUTH_CONFIG_PATH
#                         device auth store to enrol into. Default: the user's real
#                         store (~/.config/csuite/auth.json). CI points it into the
#                         state dir so nothing outside the checkout is touched.
#   CSUITE_RUNNER_VERB    which runner the preflight and step 8 use: `claude` (default),
#                         `codex`, or `stub` (a test/CI instrument needing no model credential)
#                         or `codex`. The ecosystem has two runner verbs; the
#                         sequence proves whichever the seat holds a credential for.
#   CSUITE_START_RUNNER   1 → also start `csuite $CSUITE_RUNNER_VERB` from the runner
#                         workspace and wait for the roster to show it connected. Needs
#                         an agent binary and a model credential; CI does not have one
#                         and says so instead of pretending.
#
# Requires: bash, node >= 22, curl. Nothing else.
set -euo pipefail

mode="${1:-up}"
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/.." && pwd)"

DIR="${CSUITE_BOOTSTRAP_DIR:-$PWD/.csuite-bootstrap}"
PORT="${CSUITE_PORT:-8717}"
URL="http://127.0.0.1:$PORT"
TEAM="${CSUITE_TEAM:-bootstrap}"
ADMIN="${CSUITE_ADMIN:-admin}"
RUNNER="${CSUITE_RUNNER:-builder}"
VERB="${CSUITE_RUNNER_VERB:-claude}"
case "$VERB" in claude|codex|stub) ;; *) printf '\n   FAIL CSUITE_RUNNER_VERB must be claude, codex, or stub (got %s)\n' "$VERB" >&2; exit 1 ;; esac
SERVER_DIR="$DIR/server"
CONFIG="$SERVER_DIR/csuite.json"
SECRETS="$DIR/secrets"
TOKEN_FILE="$SECRETS/$ADMIN.token"
TOTP_FILE="$SECRETS/$ADMIN.totp"
WORKSPACE="$DIR/runner"
PID_FILE="$DIR/serve.pid"
LOG="$DIR/serve.log"

say()  { printf '\n== %s\n' "$*"; }
ok()   { printf '   ok  %s\n' "$*"; }
die()  { printf '\n   FAIL %s\n' "$*" >&2; exit 1; }

# ---- csuite executable ----------------------------------------------------
# CSUITE_CMD is the command as an array so it can also run under `env -i`
# (the runner checks below use exactly a service unit's environment).
# Precedence: an explicit CSUITE_BIN; then this checkout's own build, so a
# repo user never silently runs an older global install; then `csuite` on PATH.
if [ -n "${CSUITE_BIN:-}" ]; then
  CSUITE_CMD=("$CSUITE_BIN")
elif [ -f "$repo/packages/cli/dist/index.js" ]; then
  CSUITE_CMD=("$(command -v node)" "$repo/packages/cli/dist/index.js")
elif command -v csuite >/dev/null 2>&1; then
  CSUITE_CMD=("$(command -v csuite)")
else
  die "no csuite: install it (npm install -g csuite) or build this repo (pnpm install && pnpm build)"
fi
csuite() { command "${CSUITE_CMD[@]}" "$@"; }

# Run csuite from the runner workspace with a service unit's environment:
# no token variable, only HOME, PATH and the broker URL (plus the auth
# store override when the caller isolated it).
csuite_as_runner() {
  (cd "$WORKSPACE" && env -i HOME="$HOME" PATH="$PATH" CSUITE_URL="$URL" \
      ${CSUITE_AUTH_CONFIG_PATH:+CSUITE_AUTH_CONFIG_PATH="$CSUITE_AUTH_CONFIG_PATH"} \
      "${CSUITE_CMD[@]}" "$@" </dev/null)
}

node_major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
[ "$node_major" -ge 22 ] || die "node >= 22 required (found $(node --version 2>/dev/null || echo none))"
command -v curl >/dev/null || die "curl is required"

# ---- helpers --------------------------------------------------------------
wait_for_health() {
  local i
  for i in $(seq 1 60); do
    if curl -sf --max-time 2 "$URL/healthz" >/dev/null 2>&1; then return 0; fi
    sleep 0.5
  done
  return 1
}

# ---- process ownership --------------------------------------------------
# A pid file names a number, and numbers get reused. Before signalling
# anything we check the live process is the one we started: the broker's
# command line must carry our exact config path, and the runner's working
# directory must be our workspace. `kill -0` alone proves only that some
# process exists. (Linux reads /proc; elsewhere `ps` args are used and the
# runner check falls back to its argument shape.)
# Alive means running, not merely present: a zombie (exited, not yet
# reaped by its parent) answers `kill -0` but is gone for our purposes.
is_alive() {
  kill -0 "$1" 2>/dev/null || return 1
  if [ -r "/proc/$1/stat" ]; then
    [ "$(awk '{print $3}' "/proc/$1/stat" 2>/dev/null)" != "Z" ]
  else
    [ "$(ps -o stat= -p "$1" 2>/dev/null | cut -c1)" != "Z" ]
  fi
}
cmdline_of() {
  if [ -r "/proc/$1/cmdline" ]; then tr '\0' ' ' <"/proc/$1/cmdline"; else ps -o args= -p "$1" 2>/dev/null; fi
}
is_ours() { # is_ours <pid> broker|runner
  local pid="$1" kind="$2" args
  is_alive "$pid" || return 1
  args="$(cmdline_of "$pid")"
  case "$kind" in
    broker) [[ "$args" == *" serve "* && "$args" == *"$CONFIG"* ]] ;;
    runner)
      if [ -L "/proc/$pid/cwd" ]; then
        [ "$(readlink "/proc/$pid/cwd")" = "$WORKSPACE" ] && [[ "$args" =~ (claude|codex) ]]
      else
        [[ "$args" =~ (claude|codex)\ --skip-doctor ]]
      fi ;;
  esac
}
serve_running() {
  [ -f "$PID_FILE" ] && is_ours "$(cat "$PID_FILE")" broker
}
# stop_recorded <pidfile> broker|runner <label> — signal only what is ours,
# wait for it to go (bounded), escalate once, and fail if it survives.
stop_recorded() {
  local file="$1" kind="$2" label="$3" pid i
  [ -f "$file" ] || { ok "no $label running from $DIR"; return 0; }
  pid="$(cat "$file")"
  if ! is_alive "$pid"; then
    ok "$label pid $pid is not running (stale pid file removed)"; rm -f "$file"; return 0
  fi
  if ! is_ours "$pid" "$kind"; then
    printf '   --  pid %s is alive but is not our %s (%s); leaving it alone, removing the stale pid file\n' \
      "$pid" "$label" "$(cmdline_of "$pid" | cut -c1-80)"
    rm -f "$file"; return 0
  fi
  kill "$pid" 2>/dev/null || true
  for i in $(seq 1 40); do is_alive "$pid" || break; sleep 0.25; done
  if is_alive "$pid"; then
    printf '   ..  %s pid %s ignored SIGTERM for 10s; sending SIGKILL\n' "$label" "$pid"
    kill -9 "$pid" 2>/dev/null || true
    for i in $(seq 1 8); do is_alive "$pid" || break; sleep 0.25; done
  fi
  if is_alive "$pid"; then die "$label pid $pid is still running after SIGKILL"; fi
  rm -f "$file"; ok "stopped $label pid $pid (gone)"
}

# ---- down -----------------------------------------------------------------
if [ "$mode" = down ]; then
  stop_recorded "$DIR/runner.pid" runner runner
  stop_recorded "$PID_FILE" broker broker
  exit 0
fi

# ---- up -------------------------------------------------------------------
if [ "$mode" = up ]; then
  say "1. seed the team without a TTY"
  if [ -f "$CONFIG" ]; then
    ok "already seeded at $CONFIG (csuite setup refuses to re-seed a populated team; use a fresh CSUITE_BOOTSTRAP_DIR to start over)"
  else
    mkdir -p "$SECRETS" "$SERVER_DIR"
    chmod 700 "$SECRETS"
    csuite setup --non-interactive --team "$TEAM" --member "$ADMIN" \
      --token-file "$TOKEN_FILE" --totp-secret-file "$TOTP_FILE" \
      --config-path "$CONFIG" </dev/null
    ok "team '$TEAM', member '$ADMIN'; token and TOTP secret in $SECRETS (0600)"
  fi

  say "2. start the broker in the background"
  if serve_running; then
    ok "broker already running (pid $(cat "$PID_FILE"))"
  else
    # `exec` so $! is the broker itself, not a subshell around it — `down` kills what it recorded.
    ( exec "${CSUITE_CMD[@]}" serve --config-path "$CONFIG" --port "$PORT" </dev/null >"$LOG" 2>&1 ) &
    echo $! >"$PID_FILE"
    wait_for_health || { cat "$LOG" >&2; die "broker did not answer $URL/healthz within 30s (log: $LOG)"; }
    ok "listening on $URL (pid $(cat "$PID_FILE"), log $LOG)"
  fi
fi

# ---- verify (also the tail of `up`) ---------------------------------------
say "3. broker and web UI"
code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$URL/healthz")"
[ "$code" = 200 ] || die "GET /healthz returned $code"
ok "/healthz 200"
curl -s --max-time 5 "$URL/" | grep -q '<title>CommandSuite</title>' || die "GET / did not serve the web UI (no <title>CommandSuite</title>)"
ok "/ serves the web UI"

say "4. the seeded member can use the API and sign in to the web UI"
[ -f "$TOKEN_FILE" ] || die "no token file at $TOKEN_FILE"
CSUITE_TOKEN="$(cat "$TOKEN_FILE")" csuite roster --url "$URL" </dev/null | grep -q "^$ADMIN " || die "roster as $ADMIN did not list $ADMIN"
ok "roster as $ADMIN"
jar="$(mktemp)"
status=""
for attempt in 1 2; do
  totp="$(node "$here/bootstrap/totp.mjs" "$TOTP_FILE")"
  status="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 -c "$jar" -H 'content-type: application/json' \
    -d "{\"code\":\"$totp\",\"member\":\"$ADMIN\"}" "$URL/session/totp")"
  [ "$status" = 200 ] && break
  if [ "$attempt" = 1 ] && [ "$status" = 401 ]; then
    # A code is accepted once per 30 s step; a re-run inside the same step
    # is refused as a replay — the broker being right. Wait for the next step.
    wait_s=$(( 31 - $(date +%s) % 30 ))
    printf '   ..  code already used this step (replay refused); retrying in %ss\n' "$wait_s"
    sleep "$wait_s"
  fi
done
[ "$status" = 200 ] || { rm -f "$jar"; die "POST /session/totp returned $status"; }
curl -s --max-time 5 -b "$jar" "$URL/session" | grep -q "\"member\":\"$ADMIN\"" || { rm -f "$jar"; die "GET /session did not return $ADMIN"; }
rm -f "$jar"
ok "TOTP sign-in: GET /session returns $ADMIN"

say "5. enrol a runner device through the device-code flow, approved by $ADMIN"
mkdir -p "$WORKSPACE"
auth_args=()
[ -n "${CSUITE_AUTH_CONFIG_PATH:-}" ] && auth_args=(--auth-config "$CSUITE_AUTH_CONFIG_PATH")
# Is the workspace already enrolled? Then the device side is done.
if csuite_as_runner roster >/dev/null 2>&1; then
  ok "$WORKSPACE already resolves a credential for $URL"
else
  connect_out="$DIR/connect.out"
  ( csuite connect --url "$URL" --workspace "$WORKSPACE" --label "bootstrap-runner" --quiet "${auth_args[@]}" </dev/null >"$connect_out" 2>&1 ) &
  connect_pid=$!
  user_code=""
  for i in $(seq 1 40); do
    user_code="$(sed -n 's/^code:[[:space:]]*\([A-Z0-9]\{4\}-[A-Z0-9]\{4\}\).*/\1/p' "$connect_out" 2>/dev/null | head -1)"
    [ -n "$user_code" ] && break
    kill -0 "$connect_pid" 2>/dev/null || break
    sleep 0.25
  done
  [ -n "$user_code" ] || { cat "$connect_out" >&2; die "csuite connect printed no device code"; }
  ok "device code $user_code pending"
  # The stub verb's member is titled as what it is — a test instrument —
  # so the roster itself says stub (part of the stub's visibility
  # contract; a member enrolled for a real verb keeps the working title).
  if [ "$VERB" = stub ]; then
    RUNNER_TITLE="stub runner (CI instrument)"
  else
    RUNNER_TITLE="engineer"
  fi
  CSUITE_TOKEN="$(cat "$TOKEN_FILE")" csuite connect approve --url "$URL" --code "$user_code" \
    --create --member "$RUNNER" --title "$RUNNER_TITLE" --description "runner enrolled by scripts/bootstrap.sh" \
    --label "bootstrap-runner" </dev/null
  wait "$connect_pid" || { cat "$connect_out" >&2; die "csuite connect did not complete after approval"; }
  ok "approved: member '$RUNNER' created, token delivered to the device"
fi

say "6. the runner credential resolves from its working directory with no env token"
# Exactly the environment a service unit gives: no CSUITE_TOKEN, only the URL.
csuite_as_runner roster | grep -q "^$RUNNER " || die "from $WORKSPACE with no env token, roster did not resolve as $RUNNER"
ok "saved auth for ($URL, $WORKSPACE) resolves; roster lists $RUNNER"

say "7. runner preflight from that directory (csuite $VERB --doctor)"
doctor_out="$DIR/doctor.out"
if csuite_as_runner "$VERB" --doctor >"$doctor_out" 2>&1; then
  grep -q '\[PASS\][[:space:]]*saved auth' "$doctor_out" || { cat "$doctor_out"; die "doctor did not PASS 'saved auth'"; }
  ok "csuite $VERB --doctor: all checks pass, including saved auth"
else
  cat "$doctor_out"
  die "csuite $VERB --doctor failed (see above)"
fi

say "8. runner connection"
if [ "${CSUITE_START_RUNNER:-0}" = 1 ]; then
  ( cd "$WORKSPACE" && exec env -i HOME="$HOME" PATH="$PATH" CSUITE_URL="$URL" \
      ${CSUITE_AUTH_CONFIG_PATH:+CSUITE_AUTH_CONFIG_PATH="$CSUITE_AUTH_CONFIG_PATH"} \
      "${CSUITE_CMD[@]}" "$VERB" --skip-doctor </dev/null >"$DIR/runner.log" 2>&1 ) &
  echo $! >"$DIR/runner.pid"
  for i in $(seq 1 60); do
    if CSUITE_TOKEN="$(cat "$TOKEN_FILE")" csuite roster --url "$URL" </dev/null | awk -v m="$RUNNER" '$1==m && $(NF-1)>=1 {found=1} END {exit !found}'; then
      ok "roster shows $RUNNER connected=1 (runner pid $(cat "$DIR/runner.pid"), log $DIR/runner.log)"; break
    fi
    is_ours "$(cat "$DIR/runner.pid")" runner || { cat "$DIR/runner.log" >&2; die "runner exited before connecting"; }
    sleep 1
    [ "$i" = 60 ] && die "runner did not show connected=1 within 60s (log: $DIR/runner.log)"
  done
else
  printf '   --  not started: CSUITE_START_RUNNER is unset. Steps 6-7 proved the credential resolves and the\n'
  printf '       preflight passes; a live connection needs an agent binary and a model credential, which\n'
  printf '       this environment (e.g. CI) does not have. Set CSUITE_START_RUNNER=1 on a seat that does\n'
  printf '       (CSUITE_RUNNER_VERB=claude|codex selects the runner; default claude) — or set\n'
  printf '       CSUITE_RUNNER_VERB=stub, the test instrument that needs neither (what CI does).\n'
fi

say "done"
printf '   state:   %s\n   broker:  %s (log %s)\n   admin:   %s — token %s, TOTP secret %s\n   runner:  member %s enrolled for workspace %s\n   stop:    %s down\n' \
  "$DIR" "$URL" "$LOG" "$ADMIN" "$TOKEN_FILE" "$TOTP_FILE" "$RUNNER" "$WORKSPACE" "$0"
