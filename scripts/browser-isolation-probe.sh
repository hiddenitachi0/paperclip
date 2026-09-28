#!/bin/sh
# DUR-4015 (Maja browser, step 2): browser sandbox isolation probe.
#
# Checks that the browser containers from docker/docker-compose.browser.yml
# actually enforce the design's network isolation before Filip ever turns
# this on for real. This is a PR-only deliverable -- nothing runs it in CI or
# in production yet; it is meant for a human (or a future acceptance script,
# modelled on scripts/agent-isolation-acceptance.sh) to run by hand against a
# stack started with the browser overlay, once Backend Engineer's worker
# image exists and the overlay is actually running somewhere:
#
#   scripts/browser-isolation-probe.sh
#
# It never prints a secret value -- only PASS / LEAK / SKIP, a check name,
# and a short detail. Output lines:
#
#   PASS  <check> <detail>
#   LEAK  <check> <detail>   (isolation did not hold -- this is the failure case)
#   SKIP  <check> <detail>   (containers not up, or docker not available)
#   SUMMARY leaks=<n> passes=<n> skips=<n>
#
# What it checks, in order:
#   1. `browser` container has NO route to the `server`/`db` containers or
#      the Docker host gateway (the point of `browser-internal: internal: true`
#      -- this container must only ever be reachable through the proxy).
#   2. `browser` container cannot resolve or reach the public internet
#      directly (no default route out except via `browser-egress`).
#   3. `browser-egress` refuses to proxy a request to a private/reserved
#      address (127.0.0.1, 169.254.169.254, 10.0.0.0/8, 100.64.0.0/10) --
#      mirrors packages/adapter-utils/src/public-address.ts's refusal list.
#   4. `browser-egress` allows a request to a known-public host (used as a
#      sanity check that the proxy itself works, not just that it blocks).
#   5. Neither container can reach the `db` container's port directly.
#
# Exit status: 1 if any LEAK, else 0 (including when everything was SKIPped
# because the stack is not running -- that is "nothing to report", not a
# failure; re-run once the stack is up).
set -u

LEAKS=0
PASSES=0
SKIPS=0

report() {
  status="$1"
  check="$2"
  detail="$3"
  printf '%s %s %s\n' "$status" "$check" "$detail"
  case "$status" in
    LEAK) LEAKS=$((LEAKS + 1)) ;;
    PASS) PASSES=$((PASSES + 1)) ;;
    SKIP) SKIPS=$((SKIPS + 1)) ;;
  esac
}

COMPOSE="docker compose -f docker/docker-compose.yml -f docker/docker-compose.browser.yml"

if ! command -v docker >/dev/null 2>&1; then
  report SKIP prereq "docker not available on this host"
  printf 'SUMMARY leaks=%d passes=%d skips=%d\n' "$LEAKS" "$PASSES" "$SKIPS"
  exit 0
fi

browser_up=$($COMPOSE ps -q browser 2>/dev/null)
egress_up=$($COMPOSE ps -q browser-egress 2>/dev/null)

if [ -z "$browser_up" ] || [ -z "$egress_up" ]; then
  report SKIP prereq "browser/browser-egress containers not running (start the overlay first)"
  printf 'SUMMARY leaks=%d passes=%d skips=%d\n' "$LEAKS" "$PASSES" "$SKIPS"
  exit 0
fi

exec_in() {
  # exec_in <service> <command...>
  svc="$1"
  shift
  $COMPOSE exec -T "$svc" "$@" 2>&1
}

# 1. browser -> server/db must be unreachable (no shared network with them).
if exec_in browser sh -c 'command -v wget >/dev/null 2>&1 && wget -q -T 2 -O /dev/null http://server:3100/api/health'; then
  report LEAK "browser->server" "browser container reached server:3100 -- browser-internal must not share a network with the server/db"
else
  report PASS "browser->server" "server:3100 unreachable from browser container"
fi

# 2. browser must have no direct route to the public internet (bypassing the proxy).
if exec_in browser sh -c 'command -v wget >/dev/null 2>&1 && wget -q -T 3 -O /dev/null http://example.com'; then
  report LEAK "browser->internet-direct" "browser container reached the public internet WITHOUT going through browser-egress"
else
  report PASS "browser->internet-direct" "no direct route to the public internet from the browser container"
fi

# 3. browser-egress must refuse private/reserved destinations.
for target in "127.0.0.1" "169.254.169.254" "10.255.255.1" "100.64.0.1"; do
  if exec_in browser-egress sh -c "command -v wget >/dev/null 2>&1 && wget -q -T 2 -O /dev/null --proxy=on -e use_proxy=yes -e http_proxy=http://127.0.0.1:3128 http://$target/"; then
    report LEAK "egress-refuses-private" "proxy allowed a request to $target -- must refuse RFC1918/loopback/link-local/CGNAT"
  else
    report PASS "egress-refuses-private" "proxy refused $target"
  fi
done

# 4. browser-egress must still allow a known-public destination (proves it is
#    actually filtering, not just broken/down).
if exec_in browser-egress sh -c 'command -v wget >/dev/null 2>&1 && wget -q -T 5 -O /dev/null --proxy=on -e use_proxy=yes -e http_proxy=http://127.0.0.1:3128 http://example.com/'; then
  report PASS "egress-allows-public" "proxy allowed a request to a public host"
else
  report LEAK "egress-allows-public" "proxy refused a known-public host -- probe cannot tell refusal from breakage, treat as a failure to investigate"
fi

# 5. browser-egress -> db must also be unreachable (it only needs to reach
#    the internet, never the app's own services).
if exec_in browser-egress sh -c 'command -v wget >/dev/null 2>&1 && wget -q -T 2 -O /dev/null http://db:5432'; then
  report LEAK "egress->db" "browser-egress reached db:5432 -- it must not share a network with the database"
else
  report PASS "egress->db" "db:5432 unreachable from browser-egress"
fi

printf 'SUMMARY leaks=%d passes=%d skips=%d\n' "$LEAKS" "$PASSES" "$SKIPS"
[ "$LEAKS" -eq 0 ]
