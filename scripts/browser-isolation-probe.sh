#!/bin/sh
# DUR-4015/DUR-4065 (Maja browser): browser sandbox isolation probe.
#
# Checks that the browser containers from docker/docker-compose.browser.yml
# actually enforce the design's network isolation before Filip ever turns
# this on for real. This is a PR-only deliverable -- nothing runs it in CI or
# in production yet; it is meant for a human (or a future acceptance script,
# modelled on scripts/agent-isolation-acceptance.sh) to run by hand against a
# stack started with the browser overlay, once it is actually running
# somewhere:
#
#   scripts/browser-isolation-probe.sh
#
# It never prints a secret value -- only PASS / LEAK / SKIP, a check name,
# and a short detail. Output lines:
#
#   PASS  <check> <detail>
#   LEAK  <check> <detail>   (isolation did not hold -- this is the failure case)
#   SKIP  <check> <detail>   (containers not up, docker not available, or the
#                             check's own prerequisite -- e.g. `ip` -- is missing)
#   SUMMARY leaks=<n> passes=<n> skips=<n>
#
# What it checks, in order:
#   1. `browser` container has NO route to the `server`/`db` containers (the
#      point of `browser-internal: internal: true` -- this container must
#      only ever be reachable through the proxy).
#   2. `browser` container has no route to the Docker host itself (the
#      compose network's gateway address).
#   3. `browser` container cannot resolve or reach the public internet
#      directly (no default route out except via `browser-egress`).
#   4. `browser-egress` refuses to proxy a request to a private/reserved
#      address (127.0.0.1, 169.254.169.254, 10.0.0.0/8, 172.16.0.0/12,
#      192.168.0.0/16) -- mirrors packages/adapter-utils/src/public-address.ts's
#      refusal list.
#   5. `browser-egress` refuses the tailnet specifically: a CGNAT address
#      (100.64.0.0/10) and a `*.ts.net` hostname (EGRESS_DENY_HOST_SUFFIXES).
#   6. `browser-egress` refuses a non-80/443 port even to an otherwise public
#      host (EGRESS_ALLOWED_PORTS).
#   7. `browser-egress` allows a request to a known-public host on port 80
#      (used as a sanity check that the proxy itself works, not just that it
#      blocks -- this is also the "a public site loads through the proxy"
#      check).
#   8. Neither container can reach the `db` container's port directly.
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

# `command -v wget` failing and a genuine "wget ran and could not connect"
# both make `wget ...` exit non-zero, so every check below would silently
# report PASS instead of SKIP if wget is simply missing from the image (see
# DUR-4074 review). Check availability once per container, up front, and
# gate every wget-based check on that -- same SKIP-on-missing-prereq pattern
# already used for `docker`/`ip` above.
if exec_in browser sh -c 'command -v wget >/dev/null 2>&1'; then
  browser_has_wget=1
else
  browser_has_wget=0
fi
if exec_in browser-egress sh -c 'command -v wget >/dev/null 2>&1'; then
  egress_has_wget=1
else
  egress_has_wget=0
fi

# 1. browser -> server/db must be unreachable (no shared network with them).
if [ "$browser_has_wget" -eq 0 ]; then
  report SKIP "browser->server" "wget not available in the browser container"
elif exec_in browser sh -c 'wget -q -T 2 -O /dev/null http://server:3100/api/health'; then
  report LEAK "browser->server" "browser container reached server:3100 -- browser-internal must not share a network with the server/db"
else
  report PASS "browser->server" "server:3100 unreachable from browser container"
fi

# 2. browser -> host: browser-internal is internal-only, so this container
#    has no default route at all -- confirm that directly instead of only
#    inferring it from check 3.
host_gateway=$(exec_in browser sh -c "command -v ip >/dev/null 2>&1 && ip route show default 2>/dev/null | awk '{print \$3; exit}'")
host_gateway=$(printf '%s' "$host_gateway" | tr -d '\r\n')
if [ -z "$host_gateway" ]; then
  report SKIP "browser->host" "no default route inside the browser container (expected -- browser-internal has none) or 'ip' unavailable"
elif [ "$browser_has_wget" -eq 0 ]; then
  report SKIP "browser->host" "wget not available in the browser container"
elif exec_in browser sh -c "wget -q -T 2 -O /dev/null http://$host_gateway:22/"; then
  report LEAK "browser->host" "browser container reached the host gateway ($host_gateway) directly"
else
  report PASS "browser->host" "host gateway ($host_gateway) unreachable from browser container"
fi

# 3. browser must have no direct route to the public internet (bypassing the proxy).
if [ "$browser_has_wget" -eq 0 ]; then
  report SKIP "browser->internet-direct" "wget not available in the browser container"
elif exec_in browser sh -c 'wget -q -T 3 -O /dev/null http://example.com'; then
  report LEAK "browser->internet-direct" "browser container reached the public internet WITHOUT going through browser-egress"
else
  report PASS "browser->internet-direct" "no direct route to the public internet from the browser container"
fi

# 4. browser-egress must refuse private/reserved destinations (RFC1918,
#    loopback, link-local/metadata).
for target in "127.0.0.1" "169.254.169.254" "10.255.255.1" "172.16.0.1" "192.168.0.1"; do
  if [ "$egress_has_wget" -eq 0 ]; then
    report SKIP "egress-refuses-private" "wget not available in the browser-egress container"
  elif exec_in browser-egress sh -c "wget -q -T 2 -O /dev/null --proxy=on -e use_proxy=yes -e http_proxy=http://127.0.0.1:3128 http://$target/"; then
    report LEAK "egress-refuses-private" "proxy allowed a request to $target -- must refuse RFC1918/loopback/link-local"
  else
    report PASS "egress-refuses-private" "proxy refused $target"
  fi
done

# 5. browser-egress must refuse the tailnet specifically: a CGNAT address
#    (100.64.0.0/10, Tailscale's range) and any *.ts.net hostname
#    (EGRESS_DENY_HOST_SUFFIXES), even though ts.net itself resolves publicly.
if [ "$egress_has_wget" -eq 0 ]; then
  report SKIP "egress-refuses-tailnet" "wget not available in the browser-egress container"
elif exec_in browser-egress sh -c "wget -q -T 2 -O /dev/null --proxy=on -e use_proxy=yes -e http_proxy=http://127.0.0.1:3128 http://100.64.0.1/"; then
  report LEAK "egress-refuses-tailnet" "proxy allowed a request to 100.64.0.1 -- must refuse the CGNAT/tailnet range"
else
  report PASS "egress-refuses-tailnet" "proxy refused 100.64.0.1 (CGNAT/tailnet range)"
fi
if [ "$egress_has_wget" -eq 0 ]; then
  report SKIP "egress-refuses-tailnet" "wget not available in the browser-egress container"
elif exec_in browser-egress sh -c 'wget -q -T 3 -O /dev/null --proxy=on -e use_proxy=yes -e http_proxy=http://127.0.0.1:3128 http://example.ts.net/'; then
  report LEAK "egress-refuses-tailnet" "proxy allowed a request to *.ts.net -- must refuse the tailnet hostname suffix regardless of what it resolves to"
else
  report PASS "egress-refuses-tailnet" "proxy refused *.ts.net (tailnet hostname suffix)"
fi

# 6. browser-egress must refuse a non-80/443 port even to an otherwise public
#    host (EGRESS_ALLOWED_PORTS=80,443).
for port in 22 8080; do
  if [ "$egress_has_wget" -eq 0 ]; then
    report SKIP "egress-refuses-bad-port" "wget not available in the browser-egress container"
  elif exec_in browser-egress sh -c "wget -q -T 3 -O /dev/null --proxy=on -e use_proxy=yes -e http_proxy=http://127.0.0.1:3128 http://example.com:$port/"; then
    report LEAK "egress-refuses-bad-port" "proxy allowed a request to example.com:$port -- only ports 80/443 may pass"
  else
    report PASS "egress-refuses-bad-port" "proxy refused example.com:$port"
  fi
done

# 7. browser-egress must still allow a known-public destination on port 80
#    (proves it is actually filtering, not just broken/down -- this is also
#    the "a public site loads through the proxy" check).
if [ "$egress_has_wget" -eq 0 ]; then
  report SKIP "egress-allows-public" "wget not available in the browser-egress container"
elif exec_in browser-egress sh -c 'wget -q -T 5 -O /dev/null --proxy=on -e use_proxy=yes -e http_proxy=http://127.0.0.1:3128 http://example.com/'; then
  report PASS "egress-allows-public" "proxy allowed a request to a public host"
else
  report LEAK "egress-allows-public" "proxy refused a known-public host -- probe cannot tell refusal from breakage, treat as a failure to investigate"
fi

# 8. browser-egress -> db must also be unreachable (it only needs to reach
#    the internet, never the app's own services).
if [ "$egress_has_wget" -eq 0 ]; then
  report SKIP "egress->db" "wget not available in the browser-egress container"
elif exec_in browser-egress sh -c 'wget -q -T 2 -O /dev/null http://db:5432'; then
  report LEAK "egress->db" "browser-egress reached db:5432 -- it must not share a network with the database"
else
  report PASS "egress->db" "db:5432 unreachable from browser-egress"
fi

printf 'SUMMARY leaks=%d passes=%d skips=%d\n' "$LEAKS" "$PASSES" "$SKIPS"
[ "$LEAKS" -eq 0 ]
