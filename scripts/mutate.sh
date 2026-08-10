#!/usr/bin/env bash
#
# Run a mutation against a source file and ASSERT THE MUTATION APPLIED
# before interpreting the suite.
#
# WHY THIS EXISTS. Mutation testing reports "the guard works" when a
# mutation is applied and the suite goes red. But:
#
#     mutation applied, test kills it     suite green after restore
#     mutation never applied              suite green
#
# are indistinguishable from outside. A patch with the wrong
# indentation, a stale anchor string, a typo in a `replace` target —
# all of them produce a green suite and a reported guard that was never
# tested. The failure is silent and always in the reassuring direction.
#
# Found 2026-08-01: a mutation on the process-rules store did not apply
# because the anchor had six spaces of indentation and the file had
# four. The suite passed. The guard would have been reported as
# verified without ever being exercised.
#
# USAGE
#
#   scripts/mutate.sh <file> <label> <python-patch> <command...>
#
# The patch runs with the file's contents bound to `s`; assign back to
# `s`. Example:
#
#   scripts/mutate.sh apps/server/src/process-document.ts \
#     "an edit drops the superseded text" \
#     "s=s.replace('if (current !== null) previous[field] = current[field];','',1)" \
#     pnpm --filter csuite-server test
#
# Exit codes: 0 ran, 2 the mutation did not apply (nothing was run).
# The file is always restored.

set -u

if [ "$#" -lt 4 ]; then
  echo "usage: $0 <file> <label> <python-patch> <command...>" >&2
  exit 64
fi

FILE="$1"; LABEL="$2"; PATCH="$3"; shift 3
ORIG="$(mktemp)"
trap 'cp "$ORIG" "$FILE"; rm -f "$ORIG"' EXIT

cp "$FILE" "$ORIG"

python3 - "$FILE" <<PY
import sys
p = sys.argv[1]
s = open(p).read()
$PATCH
open(p, 'w').write(s)
PY

if diff -q "$FILE" "$ORIG" >/dev/null 2>&1; then
  echo "───── $LABEL"
  echo "  MUTATION DID NOT APPLY — the result would be meaningless, so nothing ran."
  echo "  Check the anchor string: indentation and exact text must match."
  exit 2
fi

CHANGED=$(diff "$ORIG" "$FILE" | grep -c '^[<>]')
echo "───── $LABEL  (applied: ${CHANGED} lines changed)"
"$@"
