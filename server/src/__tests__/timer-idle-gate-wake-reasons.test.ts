import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  TIMER_IDLE_GATE_EXCLUDED_WAKE_REASONS,
  TIMER_IDLE_GATE_RUN_SIGNALS,
  TIMER_IDLE_GATE_WAKE_REASON_COVERAGE,
} from "../services/timer-idle-gate.ts";

// DUR-3943 rule 3: the timer idle gate's list of "reasons an agent should
// look" must agree with the reasons the server actually wakes agents for.
// Nothing ties the two together at runtime, so this test enumerates the real
// list from the server source -- every wake-up call, every run context
// wakeReason, every queued wake-up request insert -- and checks it against
// TIMER_IDLE_GATE_WAKE_REASON_COVERAGE in both directions. A new wake reason
// fails here until someone decides how the gate covers it.

const SERVER_SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Functions whose options carry a wake reason directly. */
const WAKE_CALL_NAMES = [
  "wakeup",
  "enqueueWakeup",
  "addWakeup",
  "queueIssueAssignmentWakeup",
  "enqueueStrandedIssueRecovery",
];

/**
 * Places where the reason is not written at the call site, and where it
 * really comes from. Every one of them goes through enqueueWakeup, which
 * records an agent_wakeup_requests row -- the gate's "wakeup_request" signal
 * -- so whatever reason arrives is covered. Keyed "file::expression".
 */
const DYNAMIC_WAKE_REASON_SITES: Record<string, string> = {
  "routes/agents.ts::req.body.reason":
    "POST /agents/:id/wakeup and /heartbeat/invoke: a person or the agent itself names the reason; any value.",
  "routes/agents.ts::wakeup(id, wakeOpts)":
    "POST /agents/:id/wakeup (on-demand): options built from the request body; any reason.",
  "routes/issues.ts::wakeup(agentId, wakeup)":
    "Flushes the addWakeup(...) map built just above; those reasons are read from the addWakeup calls.",
  "routes/issues.ts::addWakeup(executionStageWakeup.agentId, executionStageWakeup.wakeup)":
    "Execution stage wake-ups built by the stage helper in this file, whose wakeReason values are read directly.",
  "routes/issues.ts::addWakeup(commentDecisionStageWakeup.agentId, commentDecisionStageWakeup.wakeup)":
    "Same stage helper, reached from the comment route.",
  "services/issue-assignment-wakeup.ts::input.reason":
    "queueIssueAssignmentWakeup forwards its caller's reason; the callers are read directly.",
  "services/recovery/service.ts::input.reason":
    "enqueueStrandedIssueRecovery forwards its caller's reason; the callers are read directly.",
  "services/heartbeat.ts::input.wakeReason":
    "dispatchClaimedIssueMonitor forwards its caller's wakeReason; the callers are read directly.",
  "services/heartbeat.ts::input?.wakeReason":
    "Manual/scheduled monitor dispatch forwards an optional wakeReason, defaulting to the literal read here.",
  "services/heartbeat.ts::opts?.wakeReason":
    "scheduleBoundedRetryForRun forwards its caller's wakeReason; the callers are read directly.",
  "services/heartbeat.ts::contextWakeReason":
    "Summarises a stored run context for the run list; not a wake-up.",
  "services/plugin-host-services.ts::params.reason":
    "A plugin names the reason (with a literal default read here); any value.",
};

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__" || entry.name === "node_modules") continue;
      out.push(...listSourceFiles(full));
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") && !entry.name.endsWith(".d.ts")) {
      out.push(full);
    }
  }
  return out;
}

/** Index just past a string literal or comment starting at i, or i if none. */
function skipNonCode(text: string, i: number): number {
  const ch = text[i];
  if (ch === "/" && text[i + 1] === "/") {
    const end = text.indexOf("\n", i);
    return end === -1 ? text.length : end;
  }
  if (ch === "/" && text[i + 1] === "*") {
    const end = text.indexOf("*/", i + 2);
    return end === -1 ? text.length : end + 2;
  }
  if (ch === '"' || ch === "'" || ch === "`") {
    let j = i + 1;
    while (j < text.length && text[j] !== ch) j += text[j] === "\\" ? 2 : 1;
    return j + 1;
  }
  return i;
}

/** Index of the bracket closing the one at `open`. */
function matchBracket(text: string, open: number): number {
  const pairs: Record<string, string> = { "(": ")", "{": "}", "[": "]" };
  const stack: string[] = [];
  for (let i = open; i < text.length; i += 1) {
    const skipped = skipNonCode(text, i);
    if (skipped !== i) {
      i = skipped - 1;
      continue;
    }
    const ch = text[i]!;
    if (pairs[ch]) stack.push(pairs[ch]!);
    else if (ch === ")" || ch === "}" || ch === "]") {
      stack.pop();
      if (stack.length === 0) return i;
    }
  }
  return text.length;
}

/** Value text of a property starting at `start`, up to its delimiter. */
function readValue(text: string, start: number): string {
  let depth = 0;
  for (let i = start; i < text.length; i += 1) {
    const skipped = skipNonCode(text, i);
    if (skipped !== i) {
      i = skipped - 1;
      continue;
    }
    const ch = text[i]!;
    if (ch === "(" || ch === "{" || ch === "[") depth += 1;
    else if (ch === ")" || ch === "}" || ch === "]") {
      if (depth === 0) return text.slice(start, i);
      depth -= 1;
    } else if ((ch === "," || ch === ";" || ch === "\n") && depth === 0) {
      return text.slice(start, i);
    }
  }
  return text.slice(start);
}

/** Properties named `key` in `text` with their object depth (1 = outermost object). */
function findProperties(text: string, key: string): Array<{ depth: number; expr: string; offset: number }> {
  const found: Array<{ depth: number; expr: string; offset: number }> = [];
  let depth = 0;
  for (let i = 0; i < text.length; i += 1) {
    const skipped = skipNonCode(text, i);
    if (skipped !== i) {
      i = skipped - 1;
      continue;
    }
    const ch = text[i]!;
    if (ch === "{") depth += 1;
    else if (ch === "}") depth -= 1;
    else if (text.startsWith(key, i) && !/[\w$.]/.test(text[i - 1] ?? "") && !/[\w$]/.test(text[i + key.length] ?? "")) {
      const rest = text.slice(i + key.length);
      const colon = /^\s*:/.exec(rest);
      if (colon) {
        found.push({ depth, expr: readValue(text, i + key.length + colon[0].length).trim(), offset: i });
      } else if (/^\s*[,}]/.test(rest) && /[{,]\s*$/.test(text.slice(0, i))) {
        found.push({ depth, expr: key, offset: i }); // shorthand `{ reason, ... }`
      }
    }
  }
  return found;
}

const TYPE_ONLY = /^\??\s*(string|number|null|undefined|unknown)(\s*\|\s*(string|number|null|undefined|unknown))*$/;
const REASON_SHAPE = /^[a-z][a-z0-9_.]*$/;
const NON_VALUE_WORDS = new Set(["null", "undefined", "true", "false", "as", "const", "typeof", "string"]);

interface SourceFile {
  rel: string;
  text: string;
}

class ReasonResolver {
  readonly literals = new Map<string, Set<string>>();
  readonly dynamic = new Map<string, Set<string>>();

  constructor(private readonly files: SourceFile[]) {}

  private add(map: Map<string, Set<string>>, key: string, where: string) {
    if (!map.has(key)) map.set(key, new Set());
    map.get(key)!.add(where);
  }

  resolve(file: SourceFile, expr: string, offset: number, where: string, depth = 0): void {
    const cleaned = expr.replace(/\bas const\b/g, "").replace(/[;,]\s*$/, "").trim();
    if (!cleaned || TYPE_ONLY.test(cleaned) || depth > 6) return;

    // cond ? a : b -> only the branches are values.
    const ternary = /^([^?]*[^?.])\?(?![?.])([\s\S]*)$/.exec(cleaned);
    if (ternary && ternary[2]!.includes(":")) {
      const branches = ternary[2]!;
      const colon = branches.indexOf(":");
      this.resolve(file, branches.slice(0, colon), offset, where, depth + 1);
      this.resolve(file, branches.slice(colon + 1), offset, where, depth + 1);
      return;
    }

    // A function call computes the reason at runtime: record the whole call
    // as a dynamic site rather than guessing from its pieces.
    if (/^[\w$.?]+\s*\([\s\S]*\)$/.test(cleaned)) {
      this.add(this.dynamic, `${file.rel}::${cleaned.replace(/\s+/g, " ")}`, where);
      return;
    }

    for (const match of cleaned.matchAll(/"([^"]*)"|'([^']*)'/g)) {
      const value = match[1] ?? match[2] ?? "";
      if (REASON_SHAPE.test(value)) this.add(this.literals, value, where);
    }
    const withoutStrings = cleaned.replace(/"[^"]*"|'[^']*'/g, " ");
    for (const match of withoutStrings.matchAll(/[A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*)*/g)) {
      const ident = match[0];
      if (NON_VALUE_WORDS.has(ident)) continue;
      if (!this.resolveIdentifier(file, ident, offset, where, depth)) {
        this.add(this.dynamic, `${file.rel}::${ident}`, where);
      }
    }
  }

  private resolveIdentifier(file: SourceFile, ident: string, offset: number, where: string, depth: number): boolean {
    const [base, ...members] = ident.split(/\??\./);
    const definition = this.findDefinition(file, base!, offset);
    if (!definition) return false;
    if (members.length === 0) {
      this.resolve(definition.file, definition.expr, definition.offset, where, depth + 1);
      return true;
    }
    const objectText = definition.expr.trim();
    if (!objectText.startsWith("{")) return false;
    const property = findProperties(objectText, members[members.length - 1]!).find((prop) => prop.depth === 1);
    if (!property) return false;
    this.resolve(definition.file, property.expr, definition.offset, where, depth + 1);
    return true;
  }

  private findDefinition(file: SourceFile, name: string, offset: number) {
    const pattern = new RegExp(`(?:const|let)\\s+${name.replace(/\$/g, "\\$")}\\s*(?::[^=\\n]+)?=\\s*`, "g");
    const readAt = (source: SourceFile, index: number, length: number) => {
      const start = index + length;
      const expr = source.text[start] === "{" ? source.text.slice(start, matchBracket(source.text, start) + 1) : readStatement(source.text, start);
      return { file: source, expr, offset: start };
    };
    let nearest: RegExpExecArray | null = null;
    for (const match of file.text.matchAll(pattern)) {
      if (match.index! < offset) nearest = match;
    }
    if (nearest) return readAt(file, nearest.index!, nearest[0].length);
    if (!/^[A-Z][A-Z0-9_]+$/.test(name)) return null;
    for (const other of this.files) {
      const exported = new RegExp(`export\\s+const\\s+${name}\\s*(?::[^=\\n]+)?=\\s*`).exec(other.text);
      if (exported) return readAt(other, exported.index, exported[0].length);
    }
    return null;
  }
}

function readStatement(text: string, start: number): string {
  let depth = 0;
  for (let i = start; i < text.length; i += 1) {
    const skipped = skipNonCode(text, i);
    if (skipped !== i) {
      i = skipped - 1;
      continue;
    }
    const ch = text[i]!;
    if (ch === "(" || ch === "{" || ch === "[") depth += 1;
    else if (ch === ")" || ch === "}" || ch === "]") depth -= 1;
    else if (ch === ";" && depth === 0) return text.slice(start, i);
  }
  return text.slice(start);
}

function enumerateWakeReasons() {
  const files: SourceFile[] = listSourceFiles(SERVER_SRC).map((full) => ({
    rel: path.relative(SERVER_SRC, full).split(path.sep).join("/"),
    text: fs.readFileSync(full, "utf8"),
  }));
  const resolver = new ReasonResolver(files);
  const callPattern = new RegExp(`(?<![\\w$])(?:${WAKE_CALL_NAMES.join("|")})\\s*\\(`, "g");

  for (const file of files) {
    // 1. Wake-up calls: the options object's own `reason`.
    for (const match of file.text.matchAll(callPattern)) {
      const before = file.text.slice(Math.max(0, match.index! - 20), match.index!);
      if (/function\s+$/.test(before) || /async\s+$/.test(before)) continue;
      const open = match.index! + match[0].length - 1;
      const args = file.text.slice(open + 1, matchBracket(file.text, open));
      if (/^\s*[A-Za-z_$][\w$]*\??\s*:/.test(args)) continue; // a signature, not a call
      const callText = `${match[0].replace(/\s+/g, "")}${args.replace(/\s+/g, " ").trim()})`;
      const reasons = findProperties(args, "reason").filter((prop) => prop.depth === 1);
      if (reasons.length === 0) {
        if (!args.includes("{")) resolver.dynamic.set(`${file.rel}::${callText.replace(/^\.?/, "")}`, new Set([file.rel]));
        continue;
      }
      for (const prop of reasons) resolver.resolve(file, prop.expr, open + prop.offset, file.rel);
    }

    // 2. Every run context wakeReason (covers runs queued without a call
    // above). Matched per line: these values are always written on one line,
    // and a whole-file scan can lose track of strings around regex literals.
    for (const match of file.text.matchAll(/(?<![\w$.?])wakeReason\s*:\s*/g)) {
      const lineStart = file.text.lastIndexOf("\n", match.index!) + 1;
      if (/^\s*(\/\/|\*|\/\*)/.test(file.text.slice(lineStart, match.index!))) continue;
      const expr = readValue(file.text, match.index! + match[0].length).trim();
      resolver.resolve(file, expr, match.index!, file.rel);
    }

    // 3. Wake-up requests written directly as waiting to run: inserted or
    // updated to "queued" (e.g. a deferred wake-up promoted once the issue
    // lock frees up) or to "deferred_issue_execution".
    for (const match of file.text.matchAll(/\.(?:insert\(agentWakeupRequests\)\s*\.values|update\(agentWakeupRequests\)\s*\.set)\(/g)) {
      const open = match.index! + match[0].length - 1;
      const values = file.text.slice(open + 1, matchBracket(file.text, open));
      if (!/status:\s*"(queued|deferred_issue_execution)"/.test(values)) continue;
      for (const prop of findProperties(values, "reason").filter((p) => p.depth === 1)) {
        resolver.resolve(file, prop.expr, open + prop.offset, file.rel);
      }
    }
  }
  return { literals: resolver.literals, dynamic: resolver.dynamic };
}

describe("timer idle gate covers every wake reason (DUR-3943 rule 3)", () => {
  const { literals, dynamic } = enumerateWakeReasons();
  const coverage = TIMER_IDLE_GATE_WAKE_REASON_COVERAGE;
  const excluded = TIMER_IDLE_GATE_EXCLUDED_WAKE_REASONS;

  it("finds the wake reasons it should (sanity check of the scan itself)", () => {
    // PRINT_WAKE_REASONS=/path/file.json writes the enumerated list out for review.
    if (process.env.PRINT_WAKE_REASONS) {
      fs.writeFileSync(
        process.env.PRINT_WAKE_REASONS,
        JSON.stringify({ reasons: [...literals.keys()].sort(), dynamic: [...dynamic.keys()].sort() }, null, 2),
      );
    }
    for (const known of ["heartbeat_timer", "issue_assigned", "issue_commented", "issue_comment_mentioned", "approval_approved", "issue_blockers_resolved", "transient_failure_retry", "self_review_pass", "cheap_run_escalation"]) {
      expect([...literals.keys()], `scan should find ${known}`).toContain(known);
    }
  });

  it("every wake reason in the server code is covered by the gate or deliberately excluded", () => {
    const uncovered = [...literals.keys()]
      .filter((reason) => !(reason in coverage) && !(reason in excluded))
      .map((reason) => `${reason} (in ${[...literals.get(reason)!].join(", ")})`);
    expect(uncovered, "add these to TIMER_IDLE_GATE_WAKE_REASON_COVERAGE or TIMER_IDLE_GATE_EXCLUDED_WAKE_REASONS").toEqual([]);
  });

  it("every reason the gate lists still exists in the server code", () => {
    const stale = [...Object.keys(coverage), ...Object.keys(excluded)].filter((reason) => !literals.has(reason));
    expect(stale, "these reasons are no longer used anywhere; remove them from the gate's lists").toEqual([]);
  });

  it("every place the reason is not written at the call site is accounted for", () => {
    expect([...dynamic.keys()].sort()).toEqual(Object.keys(DYNAMIC_WAKE_REASON_SITES).sort());
  });

  it("maps every reason to real signals, always including the wake-up request backstop", () => {
    const signals = new Set<string>(TIMER_IDLE_GATE_RUN_SIGNALS);
    for (const [reason, covered] of Object.entries(coverage)) {
      expect(covered.length, reason).toBeGreaterThan(0);
      for (const signal of covered) expect(signals.has(signal), `${reason} -> ${signal}`).toBe(true);
      expect(covered, reason).toContain("wakeup_request");
    }
  });
});
