---
title: Website SFTP Deploy
summary: What a website project needs so the deploy runner can publish it over SFTP without any agent holding the deploy key
---

A project whose `deployTransport` is `sftp` is published by the deploy runner, not by an agent. The runner fetches the approved commit, uploads the files the policy lists to the web host over SFTP, swaps them in, and checks the live pages. The SFTP key is read by the runner at that moment and by nothing else: **it is never shown to, stored by, or passed to any agent.** An agent can only ask for a deploy (a board approval card); only the runner holds the key.

Everything below is board-only to set. An agent cannot change the host, the key pin, the file list or the transport.

## What the project needs

1. **A repo whose root is the docroot.** What git tracks in the repo is what can be published. The runner uploads files at the paths they have in the repo, under the project's remote directory, so `index.html` at the repo root lands at `<remote directory>/index.html`.
2. **A workspace and a `deployPolicy`** on the project, enabled, with these fields (all settable in the project's deploy settings):

| Field | What it is |
| --- | --- |
| `workspaceId` | The project workspace (the checkout of the repo) the runner deploys from. |
| `deployTargetPath` | Where the runner keeps that checkout on its host. |
| `requestingAgentId` | The agent whose approval cards request deploys. It is also the agent the SFTP credential is bound to (see below). |
| `sftpHost`, `sftpPort`, `sftpUsername` | The SFTP account. |
| `sftpRemotePath` | The remote directory the site is served from. No spaces. |
| `sftpHostKeySha256` | **Required.** The base64 SHA-256 of the host's public key, 43 characters, without a `SHA256:` prefix. Passed to curl as `--hostpubsha256` on every SFTP call, so a hijacked address cannot receive the key. Get it with `ssh-keyscan -t ed25519 HOST \| ssh-keygen -lf -` and copy what follows `SHA256:`. |
| `sftpAllowlist` | What may be published. An entry is one file (`index.html`) or a folder written with a trailing `/` (`Apps/`). |
| `sftpExclude` | Optional. Files or folders (`Apps/data/`, `Apps/Turnus/turnus-store.php`) removed from what the allowlist resolves to. |
| `appHealthCheckPaths` | At least one page that must still answer after the swap, for example `/`. |
| `healthCheckUrl` | Health-check address of the live site. |

3. **The credential bound to the requesting agent**, by an instance admin, through the agent's SFTP deploy credential binding. A Secret holds the password or the private key; the runner resolves it by agent when it deploys. Nothing in the project settings contains a password or key.

### How folders and excludes resolve

- A folder entry means **every file git tracks under that folder at the approved commit** (`git ls-files` in the checkout), not whatever is on disk. Untracked files and git-ignored files can never be published.
- Excludes are applied after that. An exclude is an exact file path, or a folder ending in `/`.
- Allowlist entries and excludes must be plain relative paths: no `..`, no absolute path, no `.` or empty segment (`./a`, `a//b`), no spaces, quotes or backslashes. A bad entry refuses the deploy; it is never silently skipped, because skipping an exclude would publish exactly what it was meant to keep off the site.
- A folder entry that tracks no file, or an allowlist that resolves to nothing, refuses the deploy (a typo must not publish a partial site).
- A tracked symlink is refused: curl would follow it and publish whatever it points to on the runner.
- A file with a space or quote in its name makes the whole deploy fail before anything is swapped. Exclude it, or rename it.

## The SFTP account

Give the account only what the deploy does, with the key restricted in `authorized_keys`:

```
restrict,command="internal-sftp" ssh-ed25519 AAAA... deploy
```

and `Subsystem sftp internal-sftp` in `sshd_config`. The key can then do nothing but SFTP, whatever happens to it. ed25519 keys work with the runner's curl (curl 8.14 / libssh2 1.11 authenticates with the private key alone; the runner also passes the public half, derived with `ssh-keygen -y`, when `ssh-keygen` is installed, for older libssh2 builds).

The account needs to be able to create, rename and remove files and folders under the remote directory: the runner uses upload, `mkdir`, `rename`, `rm` and `rmdir`.

## The staging folder: deny it on the web server

An upload is never written straight to the live path. The runner first uploads every file to

```
<sftpRemotePath>/.deploy-staging/<approval id>/...
```

and only after all of them arrived does it rename them into place one by one. That staging folder is **inside the served docroot**, so:

1. **The site must refuse to serve `.deploy-staging`.** Add this before the first deploy, and check that `https://<site>/.deploy-staging/` answers 403 or 404.
   - Apache (`.htaccess` in the docroot): `RedirectMatch 404 /\.deploy-staging(/|$)`
   - nginx: `location ~ /\.deploy-staging { return 404; }`
   - A host that blocks dot-folders by default may already do this; verify, do not assume.
2. **The runner removes it after every run**, successful or not: every attempted file (including a partial copy left by a failed transfer), then each folder it created, deepest first, then the run's folder, then `.deploy-staging` itself. If the runner is killed mid-run the folder can be left behind, which is why step 1 is not optional. Look for a stray `.deploy-staging` after any interrupted deploy and remove it.

Also deny `*.deploy-bak` the same way if the site can serve arbitrary file names: during a swap, the previous version of a file briefly sits next to it as `<name>.deploy-bak`.

## What the runner checks before and while it uploads

- The host-key pin is checked before the credential is read. No pin, or a malformed pin, means no connection.
- Every curl call to the host carries the pin; a host presenting another key gets nothing.
- Any file failing to stage leaves the live path untouched. A failed swap restores the previous file; if that restore also fails, the log says the file is missing and names where the old copy is.
