---
name: lean-coding
description: Check whether new code needs to exist before writing it — search for an existing solution, prefer the standard library, and write the smallest correct change. Never cuts safety, accessibility, or needed error handling.
key: paperclipai/bundled/software-development/lean-coding
recommendedForRoles:
  - engineer
tags:
  - code-quality
  - minimalism
  - refactoring
  - efficiency
defaultInstall: true
---

# Lean Coding

Most unnecessary code is not a bug — it is code that never needed to exist. Before writing a line, run it through this checklist in order. Stop at the first "yes" that resolves the need.

## The checklist

1. **Does this code need to exist?**
   Re-read the actual requirement. Agents over-satisfy vague asks by building configurability, abstractions, or handling for cases nobody described. If the task is "fix this bug," the answer is a fix, not a refactor plus a fix plus a guard for three hypothetical future bugs.

2. **Is it already in the codebase?**
   Grep before you write. A helper, a util, a validator, a similar component two directories over — reuse or extend it instead of writing a parallel version. Duplicated logic is a maintenance liability the moment one copy gets a fix the other doesn't.

3. **Is it in the standard library or an already-installed dependency?**
   Language runtimes and the packages already in `package.json` cover most of what looks like custom logic: date math, deep equality, debouncing, retries, CSV parsing. Reach for those before writing your own, and before adding a new dependency for something the runtime already does.

4. **Can it be one line, or a few, instead of a structure?**
   A single well-named expression beats a class, a factory, or a config object built to hold one case. If you're building an abstraction for a second caller that doesn't exist yet, stop — add it when the second caller shows up, not before.

5. **Only then: write the minimum.**
   Implement exactly what step 1 asked for, using what steps 2–4 found. No speculative parameters, no extra branches for inputs that can't occur here, no unused exports "for later."

If the honest answer at any step is "yes, write it," write it — this checklist is a filter against waste, not a mandate to avoid all new code.

## Never cut

These are not up for minimization. Cutting them to save lines is not lean, it's a defect:

- **Safety and validation** — input checks at trust boundaries, auth/permission checks, injection-safe query and template construction.
- **Accessibility** — labels, keyboard paths, contrast, focus handling, semantic markup.
- **Error handling where semantically needed** — anywhere a failure is expected (network calls, parsing external input, file I/O) and silently swallowing it would corrupt state or mislead the user. "Where semantically needed" excludes defensive handling for states that structurally cannot occur — see the checklist above.

When in doubt about whether something falls in this list, keep it and ask, rather than cut it to look lean.

## Applying it mid-task

- Before opening a new file, search for an existing one that does most of the job.
- Before adding a helper function, check if three lines inline would do — a helper used exactly once, with a name no clearer than the code itself, is not saving anything.
- Before adding a config flag or optional parameter, confirm a real caller needs the variation today, not that one might exist someday.
- When a review or test pass turns up code nothing exercises, delete it in the same change rather than leaving it "just in case."

## What this looks like in a diff

- Smaller diffs, concentrated on the lines that satisfy the requirement.
- Fewer new files and fewer new exported symbols per change.
- No net-new abstraction unless the change has two or more real call sites today.
- The same tests, safety checks, and accessibility coverage as a heavier version of the same change — lean is measured in code volume, not in coverage.
