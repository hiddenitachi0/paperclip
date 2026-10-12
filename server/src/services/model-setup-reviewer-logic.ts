import {
  parseModelConverterOps,
  type ModelConverterOp,
  type ModelHostCapabilities,
  type ModelProbeSetResult,
} from "@paperclipai/shared";

/**
 * DUR-4558 (child of DUR-4392): the model setup reviewer's decisions, as pure
 * functions -- what a probe + capability result means, which allow-listed
 * change would fix it, whether a rerun is "no worse", and whether a change may
 * be applied straight away or must go to the owner on a card.
 *
 * Least privilege: a proposal can only touch the three entry settings below
 * and the converter list. It can never carry a key, an address, a host
 * restriction or a cost limit -- the type has no field for them.
 */

export interface ReviewedSettings {
  defaultThinking: "on" | "off" | null;
  defaultTemperature: number | null;
  defaultMaxOutputTokens: number | null;
}

export interface ReviewEntry extends ReviewedSettings {
  id: string;
  provider: string;
  model: string;
  baseUrl: string | null;
}

export interface ReviewProposal {
  /** Stable key for the finding (also the dedupe key across reruns). */
  code: "qwen_empty_thinking" | "unsupported_reasoning_effort" | "tool_description_plain";
  title: string;
  /** Plain English, shown to the owner. */
  why: string;
  settingsPatch: Partial<ReviewedSettings>;
  addOps: ModelConverterOp[];
  /** True when the change turns a capability off (tools, pictures): never auto-applied. */
  dropsCapability: boolean;
  /** True when no probe can confirm it (hosted model); the evidence is the host's published parameter list. */
  evidence: "probes" | "host_capabilities";
}

export interface ReviewFinding {
  code: string;
  text: string;
}

export interface CapabilityScores {
  chat: number | null;
  tools: number | null;
  pictures: number | null;
  /** Probes record no timings yet, so speed isn't scored. */
  speed: null;
}

function probe(r: ModelProbeSetResult, kind: string) {
  return r.probes.find((p) => p.kind === kind);
}

function emptyCount(r: ModelProbeSetResult): { empty: number; errors: number; runs: number } {
  const rows = probe(r, "empty_reply")?.emptyReplies ?? [];
  return rows.reduce((a, e) => ({ empty: a.empty + e.empty, errors: a.errors + e.errors, runs: a.runs + e.runs }), { empty: 0, errors: 0, runs: 0 });
}

export function scoreProbes(r: ModelProbeSetResult): CapabilityScores {
  if (!r.ran) return { chat: null, tools: null, pictures: null, speed: null };
  const { empty, errors, runs } = emptyCount(r);
  const refusalOk = probe(r, "refusal")?.ok ? 1 : 0;
  const chat = runs > 0 ? Math.round(((runs - empty - errors) / runs) * 80 + refusalOk * 20) : refusalOk * 100;
  return { chat, tools: probe(r, "tool_call")?.ok ? 100 : 0, pictures: probe(r, "picture_request")?.ok ? 100 : 0, speed: null };
}

/** Findings that have no safe automatic fix (a stale address needs a person), shown in the report. */
export function findProblems(r: ModelProbeSetResult, caps: ModelHostCapabilities): ReviewFinding[] {
  const out: ReviewFinding[] = [];
  if (r.ran) {
    const { errors, runs } = emptyCount(r);
    if (r.probes.every((p) => !p.ok) && runs > 0 && errors === runs) {
      out.push({ code: "stale_address", text: "Every test call failed to get an answer. The saved address or model name may be out of date (for example after a provider switch). Check them; the reviewer never edits an address." });
    }
  }
  for (const m of caps.mismatches) out.push({ code: "capability_mismatch", text: m });
  return out;
}

export function proposeChanges(entry: ReviewEntry, caps: ModelHostCapabilities, r: ModelProbeSetResult, currentOps: readonly ModelConverterOp[]): ReviewProposal[] {
  const out: ReviewProposal[] = [];
  const has = (op: ModelConverterOp["op"]) => currentOps.some((o) => o.op === op);
  const hasDrop = (param: string) => currentOps.some((o) => o.op === "drop_param" && o.param === param);

  if (r.ran) {
    const { empty, errors, runs } = emptyCount(r);
    const allFailed = runs > 0 && errors === runs;
    if (empty > 0 && !allFailed) {
      const rows = probe(r, "empty_reply")?.emptyReplies ?? [];
      const onEmpty = rows.filter((e) => e.thinking !== "off").reduce((n, e) => n + e.empty, 0);
      const settingsPatch: Partial<ReviewedSettings> = entry.defaultThinking !== "off" && onEmpty > 0 ? { defaultThinking: "off" } : {};
      const addOps: ModelConverterOp[] = has("strip_output_wrapper") ? [] : [{ op: "strip_output_wrapper", wrapper: "think" }];
      if (Object.keys(settingsPatch).length > 0 || addOps.length > 0) {
        out.push({
          code: "qwen_empty_thinking",
          title: "Turn thinking off and strip <think> blocks",
          why: `${empty} of ${runs} short answers came back empty, which is what happens when a thinking model spends its turn planning. Thinking off${addOps.length ? " and removing leftover <think> blocks" : ""} should give it words to say.`,
          settingsPatch,
          addOps,
          dropsCapability: false,
          evidence: "probes",
        });
      }
    }
    const tool = probe(r, "tool_call");
    const pic = probe(r, "picture_request");
    if (tool?.ok && pic && !pic.ok && !currentOps.some((o) => o.op === "tool_description_variant")) {
      out.push({
        code: "tool_description_plain",
        title: "Use the plain tool descriptions",
        why: "The model used the clock tool but didn't ask for a picture when asked. Shorter, plainer tool descriptions usually help a small model pick the right tool.",
        settingsPatch: {},
        addOps: [{ op: "tool_description_variant", variant: "plain" }],
        dropsCapability: false,
        evidence: "probes",
      });
    }
  }

  if (caps.fetched && caps.source === "openrouter" && caps.sent.reasoningEffort && !hasDrop("reasoning_effort")) {
    const noThinking = caps.mismatches.some((m) => /No host for this model supports thinking control/.test(m));
    if (noThinking) {
      out.push({
        code: "unsupported_reasoning_effort",
        title: "Stop sending the thinking setting",
        why: "No host for this model accepts the thinking setting, and sending it can make a host drop the tools. The converter removes it from every request.",
        settingsPatch: {},
        addOps: [{ op: "drop_param", param: "reasoning_effort" }],
        dropsCapability: false,
        evidence: "host_capabilities",
      });
    }
  }
  return out;
}

/** "No worse": nothing that passed before fails now, and empty/failed answers did not increase. */
export function isNoWorse(before: ModelProbeSetResult, after: ModelProbeSetResult): boolean {
  if (!before.ran || !after.ran) return false;
  for (const p of before.probes) if (p.ok && !probe(after, p.kind)?.ok) return false;
  const b = emptyCount(before);
  const a = emptyCount(after);
  return a.empty <= b.empty && a.errors <= b.errors;
}

export type ChangeDecision = "apply" | "card";

/**
 * Applies straight away only when the change keeps every capability AND the
 * evidence holds: a probe rerun no worse, or (hosted models, which are never
 * probed) the host's published parameter list. Anything else goes to the owner.
 */
export function decideChange(proposal: ReviewProposal, before: ModelProbeSetResult, after: ModelProbeSetResult | null): ChangeDecision {
  if (proposal.dropsCapability) return "card";
  if (proposal.evidence === "host_capabilities") return "apply";
  return after && isNoWorse(before, after) ? "apply" : "card";
}

export function mergeOps(current: readonly ModelConverterOp[], add: readonly ModelConverterOp[]): ModelConverterOp[] {
  const key = (o: ModelConverterOp) => JSON.stringify(o);
  const seen = new Set(current.map(key));
  return parseModelConverterOps([...current, ...add.filter((o) => !seen.has(key(o)))]);
}

export function summarize(scores: CapabilityScores, problems: ReviewFinding[], proposals: ReviewProposal[]): string {
  const s = (n: number | null) => (n === null ? "not tested" : `${n}/100`);
  const head = `Chat ${s(scores.chat)}, tools ${s(scores.tools)}, pictures ${s(scores.pictures)}.`;
  if (problems.length === 0 && proposals.length === 0) return `${head} Nothing to fix.`;
  return [head, ...problems.map((p) => p.text), ...proposals.map((p) => `Suggested: ${p.title}. ${p.why}`)].join(" ");
}
