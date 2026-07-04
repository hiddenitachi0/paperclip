# cowork-importer

Convert a **Claude Code / Cowork project** into an **`agentcompanies/v1`** package and
(optionally) import it straight into a running Paperclip instance via the official
`/companies/import` API.

This is an **external converter** — it touches no Paperclip core code. It reads a project
folder and either writes markdown or calls the public import API. Dependency-free; needs only
Node 18+ (for global `fetch`).

## Usage

```bash
# Inspect the package it would produce
node tools/cowork-importer/convert.mjs <project-dir> --out ./my-package

# Preview the import against a running Paperclip (no changes made)
node tools/cowork-importer/convert.mjs <project-dir> --import --dry-run

# Import for real (creates a new company)
node tools/cowork-importer/convert.mjs <project-dir> --import --api http://localhost:3100
```

Options: `--out <dir>`, `--print`, `--import`, `--dry-run`, `--api <url>`
(default `http://localhost:3100`), `--company-name <name>`, `-h/--help`.

## What it reads

| Project file | Becomes |
|---|---|
| `CLAUDE.md` / `AGENTS.md` (root) | company name/description + the lead agent's instructions |
| `.claude/agents/*.md` (or `agents/*.md`) | one Paperclip agent each (frontmatter `name`/`description`; body = instructions) |
| `.claude/skills/*/SKILL.md`, `skills/*/SKILL.md`, `.agents/skills/*/SKILL.md` | company skills, copied through as-is |

## Mapping

- **Single-task project** (no `.claude/agents/*`) → **one** specialized agent whose
  instructions are the root instructions body.
- **Broader project** (has subagents) → a **lead** agent (from the root `CLAUDE.md`) plus one
  agent per subagent file, each reporting to the lead.
- A `.paperclip.yaml` sidecar sets each agent's adapter (`claude_local`), role, and sidebar
  order. Change the adapter there (or edit the emitted package) before importing if you want a
  different runtime.

## Output shape (`agentcompanies/v1`)

```
COMPANY.md
agents/<slug>/AGENTS.md
skills/<slug>/SKILL.md      # when the project has skills
.paperclip.yaml             # Paperclip fidelity sidecar
```

The format matches what Paperclip's own company export emits, so imported companies
round-trip cleanly.

## Notes / limits (v1)

- Slash-commands (`.claude/commands/*.md`) are not yet mapped — a future version may turn them
  into skills or starter tasks.
- Cowork web exports whose on-disk layout differs from Claude Code's `.claude/` convention can
  still be converted by passing a folder that contains a root `CLAUDE.md`/`AGENTS.md` (single
  agent) — extend `readSubagents`/`readSkills` if a new layout appears.
- Uses `target.mode: new_company`. To merge into an existing company, adapt the `target` in
  `importToPaperclip` (the import API also supports `existing_company`).
