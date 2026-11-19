# Least privilege for Nordstrand agents: what is enforced and what is open

Status as of 19 November 2026. Written for the people who run Nordstrand, not for developers.

The goal: coding and investigating agents can do their work, but cannot take control of the server they run on, cannot read other people's keys, and cannot change production by themselves. Anything that changes production goes through a step a person approves.

## What is enforced today (and checked automatically)

A test called the isolation probe runs as a real agent, inside the real server image, and reports anything the agent can reach that it should not. It runs on every change to the files that guard this. It never prints a secret, only the name or path of what it found. Stage 7 ("host control") checks that an agent:

- has no way to talk to Docker: no Docker socket, no Docker address in its settings and no Docker command. So an agent cannot open a shell in, or copy files in or out of, a running container.
- cannot read any SSH private key and has no forwarded SSH login.
- cannot write to any folder on the host machine. The only places it can write are its own workspace, the Paperclip data folder and temporary space.

The probe also proves it can fail: every run includes an agent that is deliberately given a Docker address and an SSH login, and the run fails if the probe does not catch them.

The earlier stages (0 to 2) cover the server's own secrets and program files, so agents cannot read the server's keys or change its code.

## What is still open, and who has to act

These are reported by the probe as "known gap". They do not fail the test yet.

1. **Agents can reach the Paperclip database.** The database is on the same network as the server, so an agent can open a connection to it. Fix: a network change so that agent runs cannot reach the database address. This needs Filip.
2. **The database owner password may still be the default.** The probe tries the default login and reports it as a gap while it works. Fix: rotate the owner password (planned with the database login work, [DUR-4028](/DUR/issues/DUR-4028), parked until about 10 December). After the rotation, set `PROBE_DB_DEFAULT_LOGIN_ENFORCED=1` for the probe, and a working default login will fail the test.
3. **A read-only login for the Dashboard database.** Investigating agents should only be able to read the Dashboard database, never change it. The Dashboard database is on a separate network that the agent server is not on today, which is good, but nobody has created the read-only role yet. Creating it, and giving investigators only that role, needs Filip in the Dashboard database.

## How privileged steps work

Agents never get the power to deploy, change a setting or recreate a container. They ask:

- A deploy goes on a deploy card. After the operator approves it, the on-box deploy runner (`scripts/deploy-runner.sh`) does the deploy.
- Restarting a service, recreating a container or changing one setting goes on a host action card. After approval, the on-box runner (`scripts/operator-action-runner.py`) does exactly that one action from a list the instance admin has set. A setting is saved as a company secret first, and the card names the secret and never shows the value.

Both runners run on the server, outside the agents' reach, and report the result back on the card.

## How to check

Run the "Agent Isolation Acceptance" workflow, or `scripts/agent-isolation-acceptance.sh`. The report lists every check as PASS, LEAK (must fix) or KNOWN_GAP (open item above).
