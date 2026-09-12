#!/usr/bin/env bash
# =================================================================================================
# inflight.sh -- IS ANYONE OPTIMIZING A BOOK RIGHT NOW?
#
# Written 2026-09-12 as the second half of TD-598. v3.0.863 taught every APPLY script to wait before
# it pushes to staging; nothing asked the same question before a PROMOTE, and a promote restarts
# PRODUCTION. An Optimize run lives entirely in the memory of the process serving it, so a restart
# does not slow a run down -- it destroys it, after the tokens were charged at compose. Today that
# is a tester; after marketing starts it is a stranger who paid, and neither party learns why.
#
# This is a client. It changes nothing on the server and it cannot refuse a deploy. It asks
# GET /api/pdf/deploy-inflight -- the endpoint shipped in v3.0.863 -- and reports the answer.
#
#   bash inflight.sh staging          # ask staging, print the answer, exit
#   bash inflight.sh prod             # ask production
#   bash inflight.sh prod --wait      # poll every 30s until it is clear, or the timeout
#   bash inflight.sh prod --wait --timeout 900
#
# EXIT CODES ARE THE POINT, because a promote script may want to gate on this:
#   0  clear      -- the server answered, and no run is alive.
#   1  busy       -- the server answered, and at least one run is alive (or still alive at timeout).
#   2  unknown    -- the question could not be answered: bad token, route missing, server has no
#                    token set, a 5xx, a timeout, no network. NOT the same as clear, and that
#                    distinction is TD-587's rule: refused, unknown and succeeded are three states.
#
# THE TOKEN IS NEVER PRINTED AND NEVER PASSED AS AN ARGUMENT. It is read from the environment
# (CAMPAIGNIA_DEPLOY_TOKEN, set in ~/.bashrc) and only its length is ever echoed.
# =================================================================================================
set -uo pipefail

STAGING_URL="https://chronicle-staging.up.railway.app"
PROD_URL="https://www.campaignia.com"

# A CNAME TARGET IS NOT A SERVABLE HOSTNAME. Railway routes by Host header, so production must be
# asked as www.campaignia.com -- 4aavznic.up.railway.app answers "Application not found". Learned
# 2026-09-11 and written here so the next person editing this file does not swap it back.

POLL_SECS=30
TIMEOUT="${DEPLOY_WAIT_MAX:-3600}"
TARGET=""
WAIT=0

usage() {
  echo "usage: bash inflight.sh <staging|prod> [--wait] [--timeout SECONDS]" >&2
  echo "  exit 0 = clear, 1 = busy, 2 = could not tell" >&2
}

while [ $# -gt 0 ]; do
  case "$1" in
    staging|stage)        TARGET="staging" ;;
    prod|production|live) TARGET="prod" ;;
    --wait|-w)            WAIT=1 ;;
    --timeout)            shift; TIMEOUT="${1:-}" ;;
    --timeout=*)          TIMEOUT="${1#--timeout=}" ;;
    -h|--help)            usage; exit 2 ;;
    *)                    echo "inflight: unrecognised argument: $1" >&2; usage; exit 2 ;;
  esac
  shift
done

if [ -z "$TARGET" ]; then
  echo "inflight: say which one -- staging or prod." >&2
  echo "  (There is no default on purpose. Checking staging and then promoting production is" >&2
  echo "   exactly the mistake this script exists to prevent.)" >&2
  usage
  exit 2
fi

case "$TIMEOUT" in
  ''|*[!0-9]*) echo "inflight: --timeout wants a whole number of seconds, got: $TIMEOUT" >&2; exit 2 ;;
esac

if [ "$TARGET" = "prod" ]; then BASE="$PROD_URL"; LABEL="PRODUCTION"; else BASE="$STAGING_URL"; LABEL="staging"; fi
URL="$BASE/api/pdf/deploy-inflight"

if ! command -v curl >/dev/null 2>&1; then
  echo "inflight: curl is not on PATH, so the question cannot be asked." >&2
  exit 2
fi

TOKEN="${CAMPAIGNIA_DEPLOY_TOKEN:-}"
if [ -z "$TOKEN" ]; then
  echo "inflight: CAMPAIGNIA_DEPLOY_TOKEN is not set in this shell." >&2
  echo "  It lives in ~/.bashrc and must match DEPLOY_CHECK_TOKEN in Railway." >&2
  echo "  Open a fresh Git Bash window if you have only just added it." >&2
  exit 2
fi

BODY="$(mktemp)"
trap 'rm -f -- "$BODY"' EXIT

# ask <no args> -> sets ASK_CODE and fills $BODY. Returns nothing; the caller reads ASK_CODE.
# The body file is TRUNCATED first, so a curl that never writes leaves an empty file rather than no
# file at all -- v3.0.863's apply script died under set -e on exactly that missing file. And the
# code is assigned in the fallback rather than echoed, because `|| echo 000` CONCATENATES onto
# curl's own -w output and produces 000000, which matches no case arm. Both learned by running it.
ask() {
  : > "$BODY"
  ASK_CODE="$(curl -sS -o "$BODY" -w '%{http_code}' --max-time 20 \
                   -H "x-deploy-token: $TOKEN" "$URL" 2>/dev/null)" || ASK_CODE="000"
  case "$ASK_CODE" in
    ''|*[!0-9]*) ASK_CODE="000" ;;
  esac
}

# The endpoint's own comment says key order is load-bearing because callers grep rather than parse:
# passing a code string to node -e is the Git Bash hazard that killed v3.0.858, so there is no JSON
# parser here on purpose.
describe_runs() {
  local n line
  n="$(grep -o '"count":[0-9]*' "$BODY" | head -n 1 | sed 's/.*://')"
  [ -n "$n" ] || n="?"
  echo "  $n run(s) alive:"
  # One line per run object. elapsedMs and step are the only two fields worth reading aloud; the
  # endpoint deliberately reports no user, no campaign id and no campaign name.
  grep -o '{"elapsedMs":[0-9]*,"sinceBeatMs":[0-9]*,"step":"[^"]*"}' "$BODY" | while read -r line; do
    local ms secs mins step
    ms="$(echo "$line"  | sed 's/.*"elapsedMs":\([0-9]*\).*/\1/')"
    step="$(echo "$line" | sed 's/.*"step":"\([^"]*\)".*/\1/')"
    secs=$(( ms / 1000 )); mins=$(( secs / 60 )); secs=$(( secs % 60 ))
    [ -n "$step" ] || step="(no step reported)"
    printf '    - %dm %02ds in, at: %s\n' "$mins" "$secs" "$step"
  done
}

report_failure() {
  case "$ASK_CODE" in
    403) echo "inflight: 403 -- the server refused the token (length ${#TOKEN})." >&2
         echo "  CAMPAIGNIA_DEPLOY_TOKEN and Railway's DEPLOY_CHECK_TOKEN do not match." >&2 ;;
    404) echo "inflight: 404 -- $LABEL has no /api/pdf/deploy-inflight route." >&2
         echo "  That service is running something older than v3.0.863." >&2 ;;
    503) echo "inflight: 503 -- $LABEL has no DEPLOY_CHECK_TOKEN set in its environment." >&2 ;;
    000) echo "inflight: no answer from $BASE (timeout, DNS, or no network)." >&2 ;;
    *)   echo "inflight: HTTP $ASK_CODE from $BASE." >&2 ;;
  esac
  # A body is often the whole diagnosis and is unread by default -- §6a. Never more than a line.
  if [ -s "$BODY" ]; then
    echo "  body: $(head -c 200 "$BODY" | tr -d '\r\n')" >&2
  fi
  echo "inflight: COULD NOT TELL whether $LABEL is busy. Treat that as busy, not as clear." >&2
}

STARTED="$(date +%s)"
while : ; do
  ask

  if [ "$ASK_CODE" = "200" ] && grep -q '"ok":true' "$BODY"; then
    if grep -q '"busy":false' "$BODY"; then
      echo "inflight: $LABEL is CLEAR -- no Optimize run in flight."
      exit 0
    fi
    if grep -q '"busy":true' "$BODY"; then
      echo "inflight: $LABEL is BUSY."
      describe_runs
      if [ "$WAIT" = "1" ]; then
        NOW="$(date +%s)"
        LEFT=$(( TIMEOUT - (NOW - STARTED) ))
        if [ "$LEFT" -gt "$POLL_SECS" ]; then
          echo "  waiting ${POLL_SECS}s (${LEFT}s left of the ${TIMEOUT}s budget; Ctrl-C is safe, this script changes nothing)"
          sleep "$POLL_SECS"
          continue
        fi
        echo "inflight: still busy after ${TIMEOUT}s. Not promoting." >&2
      fi
      exit 1
    fi
    # 200, ok:true, and neither busy value present. The contract says one of them is always there,
    # so this is the server having changed shape -- unknown, never clear.
    echo "inflight: $LABEL answered 200 but named no busy state. Contract changed?" >&2
    echo "  body: $(head -c 200 "$BODY" | tr -d '\r\n')" >&2
    exit 2
  fi

  report_failure
  exit 2
done
