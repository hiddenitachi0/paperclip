#!/bin/sh
# Paperclip git credential helper.
#
# Supplies a GitHub token from the process environment to git, so that agents
# (and managed workspace clones) can clone / fetch / push private repos and open
# PRs with NO per-agent, per-company, or per-repo git wiring. Each agent run
# injects its own GITHUB_TOKEN, so the credential used automatically matches that
# agent's access level (a write token pushes; a read-only token gets a clean 403
# on push instead of leaking write access).
#
# Wired github.com-scoped in the image's /etc/gitconfig (see Dockerfile), so it
# never offers the token to any other host. Adding a new company therefore needs
# only a GITHUB_TOKEN secret bound to its agents (done in the dashboard) — nothing
# else. GitHub's username is always the literal "x-access-token" for token auth,
# so no username variable is ever required.
#
# git invokes a credential helper as: <helper> <get|store|erase>, with the
# request on stdin. We only answer "get"; we ignore store/erase (nothing to
# persist — the token lives in the environment, never on disk).

[ "$1" = "get" ] || exit 0

token="${GITHUB_TOKEN:-${GH_TOKEN:-}}"
[ -n "$token" ] || exit 0

echo "username=x-access-token"
echo "password=$token"
