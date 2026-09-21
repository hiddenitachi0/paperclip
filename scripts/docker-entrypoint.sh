#!/bin/sh
set -e

# Capture runtime UID/GID from environment variables, defaulting to 1000
PUID=${USER_UID:-1000}
PGID=${USER_GID:-1000}

# Without root we can neither remap the node user (usermod/groupmod/chown)
# nor switch users (gosu needs CAP_SETUID/CAP_SETGID), so exec directly.
# This covers Kubernetes restricted PodSecurity (runAsNonRoot + runAsUser)
# as well as platforms that assign arbitrary UIDs (e.g. OpenShift); for the
# latter a UID/GID mismatch is unfixable here, so warn instead of letting
# usermod fail cryptically and keep volume-permission issues diagnosable.
if [ "$(id -u)" -ne 0 ]; then
    if [ "$(id -u)" -ne "$PUID" ] || [ "$(id -g)" -ne "$PGID" ]; then
        echo "docker-entrypoint.sh: running unprivileged as $(id -u):$(id -g); cannot remap to requested ${PUID}:${PGID}" >&2
    fi
    exec "$@"
fi

# Adjust the node user's UID/GID if they differ from the runtime request
# and fix volume ownership only when a remap is needed
changed=0

if [ "$(id -u node)" -ne "$PUID" ]; then
    echo "Updating node UID to $PUID"
    usermod -o -u "$PUID" node
    changed=1
fi

if [ "$(id -g node)" -ne "$PGID" ]; then
    echo "Updating node GID to $PGID"
    groupmod -o -g "$PGID" node
    usermod -g "$PGID" node
    changed=1
fi

if [ "$changed" = "1" ]; then
    chown -R node:node /paperclip
fi

# DUR-3994 Stage 1: hand the server its keys without putting them in its
# environment. Every agent runs as the same user as the server, and any
# process can read the environment another process of its user was started
# with (/proc/<pid>/environ) -- removing a key inside Node does not change
# that record. So, while still root:
#   1. server-secrets-handoff.js works out the server's keys (the single list
#      in @paperclipai/adapter-utils/server-env-secrets), taking each value
#      from the root-only secrets file /run/secrets/paperclip_server when that
#      has one, otherwise from the environment;
#   2. the values go into a one-shot pipe on descriptor 3 (base64, one
#      NAME=... line each), which the server reads and closes at start-up
#      (server/src/server-secrets.ts);
#   3. every one of those names is removed from the environment the server is
#      started with.
# Only the Paperclip server itself gets this; any other command (a one-off
# `docker compose run server ...`) keeps its environment. If there is nothing
# to hand over, or the helper fails for any reason, the server is started
# exactly as before.
SECRETS_HANDOFF_LOADER=/app/server/node_modules/tsx/dist/loader.mjs
SECRETS_HANDOFF_SCRIPT=/app/server/dist/server-secrets-handoff.js
SECRETS_FILE=/run/secrets/paperclip_server

handoff=""
case " $* " in
    *" server/dist/index.js "*|*" /app/server/dist/index.js "*)
        if ! handoff="$(node --import "$SECRETS_HANDOFF_LOADER" "$SECRETS_HANDOFF_SCRIPT" "$SECRETS_FILE")"; then
            echo "docker-entrypoint.sh: could not prepare the server key hand-over; starting the server the old way" >&2
            handoff=""
        fi
        ;;
esac

if [ -n "$handoff" ]; then
    unset_args=""
    unset_line="$(printf '%s\n' "$handoff" | sed -n 's/^UNSET //p')"
    for name in $unset_line; do
        case "$name" in
            *[!A-Za-z0-9_]*|[0-9]*) continue ;;
        esac
        unset_args="$unset_args -u $name"
    done
    payload="$(printf '%s\n' "$handoff" | sed '/^UNSET/d')"
    unset handoff unset_line
    # A here-document is a pipe in dash: readable once, gone when read.
    exec 3<<PAPERCLIP_SERVER_SECRETS
$payload
PAPERCLIP_SERVER_SECRETS
    unset payload
    # shellcheck disable=SC2086 # unset_args is deliberately split into words
    exec env $unset_args PAPERCLIP_SECRETS_FD=3 gosu node "$@"
fi

exec gosu node "$@"
