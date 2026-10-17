# Agents, skills and positions — audit (17 Oct 2026)

What this covers: every agent in Durkan Agency and Nordstrand Konsernet (except the two quick agents, Assistant and Secretary), every skill a company can install, the skills Paperclip is missing, a catalogue of ready-to-hire positions, and what to do about Brag.

The exact live changes are in `2026-10-17-apply-plan.json` next to this file. They can be applied one by one through the API.

## The short version

1. **Most agents are on the wrong brain.** 18 of 28 agents run on outdated models (Haiku 4.5, Sonnet 5), and 10 have no model set at all. No model means the Claude program picks its own default. On a Max plan that is Opus, the most expensive tier, so these agents may be the costliest in the fleet without anyone having chosen that. Every agent now gets an explicit current model and effort.
2. **Positions' skills never reached the agents.** A position could list skills, but nothing passed them to the agent when it ran, so the old Brag position never actually gave anyone the Brag skill. This is fixed: an agent now gets its position's skills on every run.
3. **Paperclip had no skills for ordinary office work.** It had nothing for email, calendars, social media, customer support, reports, bookkeeping, hiring, pictures and video, or code and security review. 14 new skills fill that gap, and every company can install them.
4. **A position catalogue.** 20 ready-to-hire positions, each with instructions, skills, a suggested model and one-click jobs. Owners add one with **Positions → Add from catalogue**.
5. **Brag is now a skill, not a position.** The Brag position turns into the new **Content & Video Producer** position automatically on the next start. That position holds the Brag skills.

## How it works today (what I checked in the code)

| Question | Answer |
|---|---|
| What does "model = None" mean? | No `--model` flag is passed, so the Claude Code program uses its own default. That default depends on the sign-in (Opus on Max plans) and can change when the program updates. It is never a deliberate choice. |
| What does "effort = None" mean? | No `--effort` flag, so the program's default applies (high or above in current Claude Code). It is not "low". |
| Which effort values are accepted? | `low`, `medium`, `high`, `xhigh`, `max` (`packages/shared/src/model-effort.ts`). |
| Which models does the Claude adapter list? | Before this change: Opus 5, Sonnet 5, Fable 5 and older. **The 5.5 models were missing.** They are now added (`packages/adapters/claude-local/src/index.ts`). The "cheap" and "planner" model profiles moved to Sonnet 5.5 and Opus 5.5, which cost the same as or less than before. |
| How do agents get skills? | Each agent has a saved skill list (`adapterConfig.paperclipSkillSync.desiredSkills`). Only skills on that list are loaded. An empty list means no Paperclip skills at all. Most Durkan agents have none. |
| How do positions give skills? | A position has `skill_keys`. Assigning it worked out the agent's skill set (`role_provisioned_skill_keys`), but **nothing used that set**. Fixed in `server/src/services/heartbeat.ts`: the position's skills are now added to every run, the same way skills mentioned on a task already are. The agent's own saved list is left as it is. |
| Where do skills come from? | `skills/` at the repo root: installed in every company automatically (`paperclipai/paperclip/*`). The skills catalogue (`packages/skills-catalog/catalog/{bundled,optional}`): installed per company from the Skills page or `POST /companies/:id/skills/install-catalog`. Company-only skills: written inside one company; their text is not in the repo. |
| Gotcha: syncing skills | `POST /agents/:id/skills/sync` **replaces** the whole list. Always read the current list first and send old plus new. |
| Gotcha: assigning a position | Assigning applies the position's instructions once, overwriting the agent's `bootstrapPromptTemplate`. Changing a position later does not update agents already in it. The apply plan therefore gives existing agents skills directly and does **not** reassign them to positions. |

## Cost tiers

Prices per million tokens (input / output), from Anthropic's current price list:

| Model | Id | Price | Use it for |
|---|---|---|---|
| Opus 5.5 | `claude-opus-5-5` | $4 / $20 | Reviewers, security, legal, tech leads: anything where a miss is expensive. Low volume. |
| Sonnet 5.5 | `claude-sonnet-5-5` | $2 / $10 | Coding, orchestrators and CEOs, analysts, writers. The default for most work. |
| Haiku 5.5 | `claude-haiku-5-5` | $0.10 / $0.50 | High-volume routine work: support replies, inbox sorting, scheduling. |
| Fable 5.1 | `claude-fable-5-1` | $10 / $50 | Only when asked for "best possible". Not used in this plan. |

Haiku 5.5 is about 10× cheaper than the Haiku 4.5 most Nordstrand agents use now, and Opus 5.5 is cheaper than Opus 5. Moving to the current models therefore costs less per token even where the tier goes up. Agents signed in with a Claude subscription spend quota rather than money, but the tiers compare the same way.

Effort: `low` for simple routine work, `medium` as the default, `high` for coding, money, reviews and anything risky. `xhigh`/`max` are not used anywhere: they cost noticeably more and the gain only shows on very hard problems.

## Per agent: current → recommended

Skipped: **Assistant** (621d5687) and **Secretary** (3aacdb86), as Filip asked.

### Durkan Agency

| Agent | Now | Recommended | Why | Skills to add |
|---|---|---|---|---|
| Backend Engineer | none / none | Sonnet 5.5 / high | Writes production code; strong at coding, careful at high. | paperclip, github-pr-workflow, karpathy-guidelines, qa-acceptance, doc-maintenance |
| Security Reviewer | none / medium | **Opus 5.5 / high** | A missed security hole is the most expensive mistake. | paperclip, security-review, code-review |
| Fork Lead | Sonnet 5 / medium | Sonnet 5.5 / high | Lead engineer; plans, reviews and asks for merges and deploys. Same price, newer model, more care. | paperclip, task-planning, converting-plans-to-tasks, github-pr-workflow, code-review, issue-triage, doc-maintenance, create-agent |
| Frontend Engineer | none / medium | Sonnet 5.5 / high | Writes UI code. | paperclip, github-pr-workflow, karpathy-guidelines, qa-acceptance, design-critique, wireframe, agent-browser |
| Investigator | none / medium | Sonnet 5.5 / medium | Advice-only research helper. | paperclip, research-and-plan, report-analysis |
| Web Reviewer | none / none | **Opus 5.5 / high** | Reviewer; reviewers get the strongest model. | paperclip, code-review, design-critique, agent-browser, link-checker, qa-acceptance |
| Web Developer | none / medium | Sonnet 5.5 / high | Writes the website's PHP. | paperclip, github-pr-workflow, karpathy-guidelines, agent-browser, link-checker |
| CEO | Haiku 4.5 / low | **Sonnet 5.5 / medium** | Decides who does what. Haiku 4.5 at low effort is too weak to orchestrate. | paperclip, create-agent, converting-plans-to-tasks, task-planning, issue-triage, para-memory-files |
| Web Administrator | none / medium | Sonnet 5.5 / medium | Day-to-day site running with server access: routine, but mistakes are public. | paperclip, link-checker, agent-browser, doc-maintenance |

### Nordstrand Konsernet

Module specialists (Orders, Claims, Automations, Products, Purchasing, Governance, Tasks, Email) write Django code for a live finance and e-commerce system. Haiku 4.5 is too weak for that; there was already one case of detailed false "done" claims. They move to **Sonnet 5.5 at medium**. Their existing company skills (nordstrand-ops, cross-module-contracts, writes-enabled-gate, …) stay.

| Agent | Now | Recommended | Why | Skills to add |
|---|---|---|---|---|
| Sales Rep | Haiku 4.5 / none | Haiku 5.5 / medium | Customer drafts at volume. | lead-follow-up, customer-support-replies, email-triage |
| Quarterly Reporting Agent | Haiku 4.5 / none | **Sonnet 5.5 / high** | Numbers must be right (a KPI double-count bug was found here). | report-analysis |
| Orders | Haiku 4.5 / medium | Sonnet 5.5 / medium | Module specialist (code). | lean-coding, qa-acceptance |
| Salgsanalytikeren | none / none | Sonnet 5.5 / high | Sales analysis grounded in data. | paperclip, report-analysis |
| Support Rep | Haiku 4.5 / none | Haiku 5.5 / medium | Support drafts at volume. | customer-support-replies, email-triage |
| CEO | Haiku 4.5 / none | Sonnet 5.5 / medium | Orchestrator. | converting-plans-to-tasks, task-planning, issue-triage |
| Claims | Haiku 4.5 / medium | Sonnet 5.5 / medium | Module specialist. | lean-coding, qa-acceptance |
| Automations | Haiku 4.5 / medium | Sonnet 5.5 / medium | Module specialist. | lean-coding, qa-acceptance |
| Dashboard Boss | Haiku 4.5 / medium | **Sonnet 5.5 / high** | Orchestrator and sole owner of shared infrastructure. | task-planning, converting-plans-to-tasks, code-review, issue-triage |
| Reporting module | none / medium | Sonnet 5.5 / medium | Builds the reporting module. | report-analysis, lean-coding, qa-acceptance |
| Products | Haiku 4.5 / medium | Sonnet 5.5 / medium | Module specialist. | lean-coding, qa-acceptance |
| Purchasing | Haiku 4.5 / medium | Sonnet 5.5 / medium | Module specialist. | lean-coding, qa-acceptance, report-analysis |
| Claims Rep | Haiku 4.5 / none | Haiku 5.5 / medium | Claim replies at volume. | customer-support-replies, email-triage |
| Governance | Haiku 4.5 / medium | Sonnet 5.5 / medium | Module specialist. | lean-coding, qa-acceptance |
| Tasks | Haiku 4.5 / medium | Sonnet 5.5 / medium | Module specialist. | lean-coding, qa-acceptance |
| Finance | none / medium | **Sonnet 5.5 / high** | Fiken–Shopify reconciliation: money must be exact. | report-analysis, bookkeeping-assistant, lean-coding, qa-acceptance |
| Tech Boss | Haiku 4.5 / medium | **Opus 5.5 / high** | Technical gate that reviews the specialists' work; low volume, so the cost stays small. | paperclip, code-review, security-review, task-planning |
| Customer Leader | Haiku 4.5 / none | Sonnet 5.5 / medium | Leads the customer reps. | customer-support-replies, email-triage, report-analysis |
| Email | Haiku 4.5 / medium | Sonnet 5.5 / medium | Module specialist. | lean-coding, qa-acceptance |

If cost becomes a worry, the first place to save is the eight module specialists: put them on Haiku 5.5 at high effort and watch whether their work holds up. I would not save on Finance, Reporting, Dashboard Boss or Tech Boss.

## Skill review

Quality: good / ok / weak. "Fixed" means the file was edited on this branch.

| Skill | Quality | Problems | What changed or is proposed |
|---|---|---|---|
| paperclip | good | Long (572 lines); had no rule for actions outside Paperclip. | **Fixed:** anything that leaves the company and cannot be undone (customer email, publishing, spending, deleting outside data) needs an approval or confirmation first. Proposed: move the long approval text into reference files to shrink every run's prompt. |
| paperclip-board | ok → good | **Real bug:** the hire examples put the agent's prompt in `adapterConfig.systemPrompt`, which the Claude adapter ignores, so agents hired from them ran without a prompt. The examples also used `model: "sonnet"` and woke every agent every 5 minutes, and positions were not mentioned. | **Fixed:** the prompt goes in `instructionsBundle` AGENTS.md; current model ids with effort; heartbeat timers off by default; model and position notes. Still open: the "Cross-Agent Escalation" step edits adapterConfig and should use the instructions-bundle endpoints. |
| paperclip-create-agent | ok → good | No model or effort guidance; old model ids; no positions; did not say that skill sync replaces the list. | **Fixed:** "Choosing model and effort" table; never leave the model empty; position and skill notes; checklist item. |
| paperclip-converting-plans-to-tasks | good | Overlaps `task-planning`. | Give managers this one and engineers `task-planning`, not both. |
| para-memory-files | ok | Relies on `$AGENT_HOME` and a `qmd` tool that may be missing; heavy. | Give it only to long-running leads (CEO, Executive Assistant). |
| research-and-plan | good | — | — |
| link-checker | weak | Described a server function no agent can call. | **Fixed:** honest description with a manual fallback. Proposed: add a small API route so agents can really run the link check. |
| doc-maintenance | good | — | — |
| issue-triage | good | — | — |
| task-planning | good | Overlaps converting-plans-to-tasks. | See above. |
| paperclip-capsules | ok | Paperclip-brand design work only; no use to other companies. | Move to optional; give it only to the fork team. |
| wireframe | ok → good | Published to a public web link by default and told the agent to install a third-party skill itself. | **Fixed:** attach to the task by default; public link only on request; no self-install. |
| qa-acceptance | good | — | — |
| github-pr-workflow | good | — | — |
| lean-coding | good | Same job as the external karpathy-guidelines. | Give agents one of the two, not both. Durkan already has karpathy-guidelines installed, so the plan uses that there and lean-coding at Nordstrand. |
| agent-browser | good | Assumes a browser tool is available. | Add a fallback line for when no browser is available. |
| design-critique | good | — | — |
| release-announcement | ok → good | Covered social posts with no "ask before publishing" rule. | **Fixed:** approval before anything goes public. |
| brag | ok | Vendored MIT skill that ships scripts, so it stays opt-in. It suggested the "brag" role that is being retired. | **Fixed:** suggested roles retagged. It is now held through the Content & Video Producer position next to the new brag-video skill. |
| last30days | ok | External reference; ships Python plus a keychain script; needs node, python3 and API keys; scrapes Reddit, X and YouTube. | Install only for Researcher and Marketing, after an audit. Each company needs its own API keys. |
| karpathy-guidelines (external) | good | Same job as lean-coding. | See lean-coding. |

### Company-only skills (text not in the repo, judged from their descriptions)

Proposed text for the coordinator to paste after reading the current skill:

- **opencode-local-ollama** (Durkan): written around one machine's setup, which breaks "build for all users". Proposed description: *"Set up an agent to run on a self-hosted Ollama model through the opencode_local adapter. Use only when the company has its own model server; read the server address and model name from the company's Models settings — never assume a fixed address or model."* In the body, replace any hard-coded address or model with "use the address saved under Settings > Models". Do not give it to any agent by default.
- **cross-module-contracts** (Nordstrand): good. Add as the first line: *"If a contract you need is not listed here, ask the owning module's agent by task — never read another module's tables directly."*
- **nordstrand-ops** (Nordstrand): good. Add two lessons from past incidents: *"Before any dashboard deploy, check that no bulk Avstemming send is running"* and *"Deploys do not run migrations; check the migration leaf count is 1."*
- **shared-stack-ops** (Nordstrand): explains Docker, migrations and restarts, which agents are not allowed to do. Add at the top: *"Read-only knowledge. You may not run docker, psql, migrations or restarts yourself. When one is needed, file a host-action request in plain words and stop."* Give it only to Dashboard Boss and Tech Boss.
- **writes-enabled-gate** (Nordstrand): good. Add: *"Tests must stub external writes; never switch the gate on to test."*

## Missing skills — written on this branch

All 14 are in `packages/skills-catalog/catalog/optional/`. They are markdown only, written for any company, and require a person's approval before anything is sent, published, booked or paid.

| Skill key | What it does |
|---|---|
| communication/email-triage | Sorts an inbox (urgent, needs reply, FYI, noise, suspicious), summarises it, and drafts replies in the sender's language. Flags phishing; never sends. |
| communication/meeting-notes | Turns notes or a transcript into minutes: decisions, action items with owner and date, open questions, proposed tasks. |
| communication/customer-support-replies | Looks up the facts before answering, never promises beyond policy, and hands refunds, legal, safety and angry cases to a person. |
| operations/calendar-scheduling | Finds times across time zones with breaks, offers 2–3 options, and drafts invites. Never accepts or declines without approval. |
| content/social-media-management | Content calendar, per-platform format table (Instagram, Facebook, LinkedIn, X, TikTok, Shorts), brand voice, approval before publishing. |
| content/seo-content-writing | Search intent, title and meta lengths, headings, internal links, product descriptions; no keyword stuffing or invented claims. |
| analysis/report-analysis | Every number cited to its page or cell, totals recomputed, period, unit and currency checked, facts kept apart from opinion, "not in the data" when a figure is missing. |
| media/media-studio-generation | Pictures, clips, audio and storylines through Media Studio's agent tools and the storyline routes. Starts small; asks before costly video renders; no likenesses or logos without rights. |
| content/brag-video | Launch videos through the Brag pipeline: estimate, plan, approve scenes, render. Hands custom motion work to the full `brag` skill. Note: the Brag routes are board-only today, so an agent prepares the request and a person presses go. |
| quality/code-review | Pull request review: correctness first, file:line evidence, severity levels, clear verdict. Never merges. |
| quality/security-review | Quick threat model plus a 10-area checklist (access, company boundaries, injection, secrets, SSRF, uploads, …). Proof without touching live systems. |
| sales/lead-follow-up | Pipeline stages with a next step and date per lead; drafts follow-ups from real data only; respects opt-outs; no false urgency. |
| finance/bookkeeping-assistant | Sorts transactions, matches receipts, reconciles, and lists VAT questions, with a source for every amount. Never books or moves money. |
| people/hiring-pipeline | Job ad, structured interview with a scoring guide, candidate summaries. No protected traits; a person decides. |

### Still missing (proposed, not written)

- **A link-check route or tool**, so the link-checker skill works without a person.
- **Agent access to Brag and Media Studio's direct routes.** Both are board-only today, so the video and picture jobs end with "a person presses go".
- **Translation and localisation** (Norwegian and English shop texts, with glossary rules).
- **Inventory and purchasing** (reorder points, supplier emails) for e-commerce companies.
- **Invoice follow-up** (overdue reminders, drafted only).

## Positions catalogue

20 ready-to-hire positions in `packages/shared/src/position-catalogue.ts`, added with **Positions → Add from catalogue** (or `POST /api/companies/:id/positions/catalogue/:key`). Adding one creates a normal, editable position plus its one-click jobs, and installs the catalogue skills it needs. It never overwrites a position the company already has and never creates a job twice. No position can ask for a deploy; only Tech Lead and Developer can ask for a merge.

Connector keys are left empty on purpose. They are the names of each company's own tool connections, so no key works everywhere. Instead, each entry says in plain words what to connect ("the support inbox", "the shop's order system, read-only").

| Position | Suggested model / effort | Key skills | One-click jobs |
|---|---|---|---|
| Social Media Manager | Sonnet 5.5 / medium | social-media-management, media-studio-generation, seo-content-writing | Draft this week's social posts · Turn an announcement into social posts |
| Content & Video Producer | Sonnet 5.5 / high | **brag-video, brag**, media-studio-generation | Make a 30-second launch video |
| Image & Video Creator | Sonnet 5.5 / low | media-studio-generation | Make pictures from a brief · Make a short video from a storyline |
| Executive Assistant | Sonnet 5.5 / medium | email-triage, calendar-scheduling, meeting-notes, para-memory-files | Prepare my day · Write up meeting minutes |
| Email Manager | Haiku 5.5 / medium | email-triage, customer-support-replies | Summarise inbox and propose replies |
| Scheduler | Haiku 5.5 / low | calendar-scheduling | Find a meeting time |
| Report Analyst | Sonnet 5.5 / high | report-analysis | Analyse this report · Compare two periods |
| Customer Support Rep | Haiku 5.5 / medium | customer-support-replies, email-triage | Draft replies to open customer questions |
| Sales & Lead Manager | Sonnet 5.5 / medium | lead-follow-up, email-triage, calendar-scheduling | Follow up on open leads |
| Marketing Strategist | Sonnet 5.5 / high | seo-content-writing, social-media-management, report-analysis | Write a one-month marketing plan · Write a search-friendly article |
| Bookkeeper & Finance Assistant | Sonnet 5.5 / high | bookkeeping-assistant, report-analysis | Prepare the monthly bookkeeping check |
| Researcher | Sonnet 5.5 / high | research-and-plan, last30days, agent-browser | Research a question |
| Tech Lead | Opus 5.5 / high | task-planning, code-review, github-pr-workflow | Turn a request into a build plan (uses the Opus "planner" profile) |
| Developer | Sonnet 5.5 / high | github-pr-workflow, lean-coding, qa-acceptance | Fix a bug |
| Code Reviewer | Opus 5.5 / high | code-review, qa-acceptance | Review a pull request |
| QA & Tester | Sonnet 5.5 / medium | qa-acceptance, agent-browser, link-checker | Test a feature before release |
| Security Reviewer | Opus 5.5 / high | security-review, code-review | Security review of a change |
| Legal Advisor | Opus 5.5 / high | research-and-plan | Revise contract · Draft new contract · Compare two versions (the same three as before) |
| Project Manager | Sonnet 5.5 / medium | task-planning, issue-triage, meeting-notes | Write the weekly status |
| HR & Recruiter | Sonnet 5.5 / medium | hiring-pipeline, calendar-scheduling | Write a job ad and interview plan |

Every position includes the core `paperclip` skill and the same ground rules: post results in plain words, never invent facts, and nothing leaves the company without a person's approval. Jobs that send or publish something are marked "needs approval before done".

Jobs only appear once **Jobs** is switched on for the company (off by default). Durkan has jobs already (the Legal Advisor pack), but whether its switch is on was not checked; Nordstrand has no jobs yet. The apply plan checks both.

## Brag: skill, not position

Brag was added (DUR-4519) as a position whose only content was the `/brag` skill. That was the wrong shape:

- A position describes a **job a person or agent holds** (instructions, rights, skills, one-click jobs). Making launch videos is one task inside a content or marketing job, not a job on its own.
- The Brag position never worked anyway: position skills were not passed to agents (see above).

What changed:

- **Startup no longer creates a Brag position** (`server/src/services/agent-role-seed.ts`).
- **The Content & Video Producer** catalogue position holds `brag-video` (new, wraps the server's Brag pipeline) and `brag` (the full vendored skill).
- **A one-time conversion runs at every start** (`convertBragPositionsToSkill` in `server/src/services/position-catalogue.ts`). For each seeded Brag position, it:
  - creates Content & Video Producer if missing;
  - moves every agent in Brag over, giving it the new position's instructions only if it had none, and recomputing its skills and rights;
  - re-links any job attached to Brag;
  - deletes Brag.

  A position someone made themselves and happened to call "Brag" (not seeded, without the brag skill) is left alone. Nothing to do once converted. No database migration is needed.

## Code changes on this branch

| Area | Files |
|---|---|
| Current Claude model ids (+ profiles) | `packages/adapters/claude-local/src/index.ts` |
| Position skills reach the agent at run time | `server/src/services/heartbeat.ts`, `server/src/services/position-catalogue.ts` (`readPositionSkillKeys`) |
| Position catalogue data | `packages/shared/src/position-catalogue.ts` (+ export in `index.ts`) |
| Add from catalogue (service, routes, UI) | `server/src/services/position-catalogue.ts`, `server/src/routes/agent-roles.ts`, `ui/src/api/jobs.ts`, `ui/src/components/jobs/PositionCatalogueDialog.tsx`, `ui/src/pages/Positions.tsx` |
| Brag conversion | `server/src/services/position-catalogue.ts`, `server/src/services/agent-role-seed.ts`, `server/src/index.ts` |
| Legal Advisor jobs shared with the catalogue (no text change) | `server/src/services/job-starter-pack-seed.ts` |
| 14 new skills, 7 improved skills, regenerated catalogue | `packages/skills-catalog/catalog/**`, `packages/skills-catalog/generated/catalog.json`, `skills/**` |
| Tests | `server/src/__tests__/position-catalogue.test.ts`, `server/src/__tests__/position-catalogue-routes.test.ts`, `packages/skills-catalog/src/position-catalogue-skills.test.ts`, `ui/src/components/jobs/PositionCatalogueDialog.test.ts`, updated `agent-role-seed.test.ts` and `shipped-catalog.test.ts` |

Not changed: the quick-agent (lane A) model list. Its prices are pinned byte-for-byte by a test so existing quick agents keep their cost rows, and Assistant and Secretary were out of scope.

## Decisions for Filip

1. **Module specialists to Sonnet 5.5.** This is the biggest quality-versus-cost call. Alternative: Haiku 5.5 at high effort, with a review after a week.
2. **Tech Boss, Web Reviewer and Security Reviewer on Opus 5.5.** They are reviewers with low run volume.
3. **Jobs for Nordstrand.** Switching it on makes the one-click jobs visible there.
4. **Existing agents keep their setup.** They get skills directly; nobody is moved into a catalogue position, because that would overwrite their starting instructions. New hires should start from a catalogue position.
5. **Agents cannot run the Brag pipeline or Media Studio direct routes themselves yet** (board-only). Should agents get that right, with a spending cap?
