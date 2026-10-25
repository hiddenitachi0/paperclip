---
name: security-review
description: Security review of a code change or a running system — quick threat model, a checklist covering access control, tenant scoping, injection, secrets, SSRF, uploads, dependencies and sensitive logging, proof for each finding, severity, and safe handling. Use when a task asks for a security review, a PR touches auth/data access/input handling/secrets, or before a risky release.
key: paperclipai/optional/quality/security-review
recommendedForRoles:
  - security
  - reviewer
  - engineer
  - tech-lead
tags:
  - security
  - review
  - threat-model
  - appsec
---

# Security Review

Find the ways a change or system could let the wrong person read, change or break something — prove each one safely — and tell the owner exactly what to fix first. A security review that cannot be acted on is noise; one that touches production to "prove" a point is an incident.

Use the `paperclip` skill for task mechanics. For general correctness review run `paperclipai/optional/quality/code-review` as well.

## When to use

- A PR adds or changes routes, permissions, login/session, data queries, file handling, outbound requests, secrets or third-party integrations.
- A task asks for a security review of a feature, service or configuration.
- Before releasing something that handles customer data, payments or credentials.

## When not to use

- Live incident response (active breach): escalate to the board immediately with what you know; do not run a review first.
- Penetration testing of systems you are not explicitly authorised to test.

## Procedure

1. **Scope.** Write down exactly what is in scope (commit, files, endpoints, environment) and what is not. Review code and test environments only, unless the task explicitly authorises read-only checks of production.
2. **Quick threat model (10 minutes, not a document).** Who are the actors (anonymous, signed-in user, other tenant/company, agent, admin)? What assets matter (personal data, money, credentials, other tenants' data)? Where does untrusted input enter? What trust boundary does the change cross?
3. **Walk the checklist** against the change:

   | Area | Ask |
   |---|---|
   | Access control | Is every new route/action checked for the caller's permission, server-side? Can a user act on an id they do not own? |
   | Tenant / company scoping | Does every query filter by the caller's company/tenant? Any cross-tenant read via joins, caches, file paths, background jobs? |
   | Injection | SQL built from strings, shell commands with user input, template/HTML injection, path traversal, unsafe deserialisation |
   | Secrets | Keys in code, logs, error messages, client bundles or test fixtures; secrets returned by APIs; overly broad tokens |
   | Outbound requests (SSRF) | Can a user make the server fetch an arbitrary URL? Are private/internal addresses, redirects and non-https blocked? |
   | File uploads / downloads | Size and type limits enforced server-side, content-type sniffing off, files served from a safe origin, no execution |
   | Auth & sessions | Token lifetime, revocation, CSRF on cookie auth, password/reset flows, rate limits on login and expensive endpoints |
   | Dependencies | New packages: maintained, licence OK, known advisories, install scripts; pinned versions |
   | Data exposure & logging | Personal or sensitive data in logs, analytics, error trackers or AI prompts; minimum fields returned |
   | Agent / automation risk | Can an agent grant itself rights, approve its own work, or act outside its company? |

4. **Prove findings safely.** Prefer a failing unit/integration test, a request against a local or test instance, or a precise code path explanation. Never exploit a live system, never pull real customer data, never paste a secret into a comment — say "a key is exposed at file:line" and ask for rotation.
5. **Rate severity** (below), propose the smallest fix, and note any compensating control.
6. **Report** with the template and post it on the task. For Critical/High, also flag the board directly, privately where the tool allows.

## Severity rubric

| Level | Typical example | Expected action |
|---|---|---|
| **Critical** | Unauthenticated access to other tenants' data, remote code execution, exposed production credentials | Stop release, fix now, rotate secrets |
| **High** | Authenticated user can read/modify another tenant's data; SSRF to internal network; privilege escalation | Fix before release |
| **Medium** | Missing rate limit on sensitive action, sensitive data in logs, weak upload validation with limited impact | Fix soon, tracked task |
| **Low** | Defence-in-depth gap, verbose errors, outdated dependency without known exploit path | Backlog |
| **Info** | Observation or hardening idea | Optional |

## Report template

```
Security review — <scope> at <commit/env>
Result: BLOCK RELEASE | FIX BEFORE RELEASE | OK WITH FOLLOW-UPS | NO ISSUES FOUND IN SCOPE
Threat model: actors <...>; assets <...>; entry points <...>

Findings
1. [High] <title> — path:line / endpoint
   Impact: <who can do what to whom>
   Proof: <test name, local request, or code path> (no live exploitation)
   Fix: <smallest change>; Rotate: <secret, if any>
Checked and fine: <areas>
Not checked: <areas and why>
```

## Hard rules

- Never test against production or real customer data without explicit written authorisation on the task — and even then read-only.
- Never paste secrets, tokens, personal data or working exploit payloads into comments, tasks or chats.
- Never weaken a control (disable auth, widen CORS, skip checks) to "make a test pass".
- Never approve or merge; your report is advice to the board.
- "No issues found" always comes with the scope and the not-checked list.

## Done when

- [ ] Scope and environment are written down
- [ ] The threat model names actors, assets and entry points
- [ ] Every checklist area is marked checked, not applicable, or not checked
- [ ] Each finding has severity, impact, safe proof and a fix
- [ ] Critical/High findings were raised to the board directly
- [ ] No secret or personal data appears in the report
