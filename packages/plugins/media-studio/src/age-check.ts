// Age check: every picture is checked for apparent age before it leaves
// Paperclip for training or identity (Fal LoRA training, Higgsfield Soul ID,
// a Hugging Face publish of a LoRA trained on the pictures, and the
// training-set zip download). Pictures that are not clearly of an adult are
// never sent.
//
// The result is kept per picture CONTENT (sha256 of the file's bytes), not per
// file id, so a re-uploaded copy of the same picture keeps its result and
// cannot be checked again for a different answer. Stored in plugin state,
// scope "company" (the company the host verified for the call), so one
// company's results are never used for another's pictures:
//   pictureAgeChecks   Record<sha256, AgeCheckRecord>
//
// The check itself is one call to the company's chosen analysis model through
// the host (ctx.models.analyseImage, capability models.image_analysis.run),
// with a minimal prompt that must answer strict JSON
// {"apparentAdult": true | false | null}. Only `true` is "adult"; `false` is
// "under18"; `null` or a refusal is "unclear". An answer that cannot be read
// is not stored (it says nothing about the person) and the action is refused.
//
// A stored result never gets milder: a picture once judged "under18" or
// "unclear" stays refused, even if a later analysis says otherwise.

import { createHash } from "node:crypto";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { AnalysisModelSetting } from "./vision-analysis.js";

export type AgeVerdict = "adult" | "under18" | "unclear";

export interface AgeCheckRecord {
  sha256: string;
  verdict: AgeVerdict;
  /** The company's saved model (Settings > Models) that judged it. */
  modelEntryId: string | null;
  checkedAt: string;
}

export const AGE_CHECK_EXPLANATION =
  "Every picture is checked for apparent age before it leaves Paperclip. Pictures that are not clearly of an adult are never sent.";

export const AGE_CHECK_COST_NOTE =
  "Pictures not checked before take one call each to the company's analysis model (charged like any other analysis by that model). A picture is only checked once, even if it is uploaded again.";

export const AGE_CHECK_SYSTEM_PROMPT = [
  "You check whether the person in a picture clearly looks like an adult (18 or older).",
  "Never say or guess who the person is. Do not describe the picture.",
  'Answer with exactly this JSON and nothing else: {"apparentAdult": true}',
  "Use true only when the person clearly looks 18 or older; false when they look under 18; null when you are unsure, when there is no clear person, or when there is more than one person and any of them may be under 18.",
].join("\n");

export const AGE_CHECK_USER_PROMPT = 'Does the person in this picture clearly look like an adult? Answer only {"apparentAdult": true|false|null}.';

export const AGE_CHECK_UNREADABLE_MESSAGE =
  "The analysis model's answer to the age check could not be read, so nothing was sent. Try again, or pick another analysis model (one that can see pictures) in Media Studio's identity settings.";

export const AGE_CHECK_NO_MODEL_MESSAGE =
  "Every picture is checked for apparent age before it leaves Paperclip, and some of these pictures have not been checked yet. Pick an analysis model (one that can see pictures) in Media Studio's identity settings first.";

const STATE_KEY = "pictureAgeChecks";
const MAX_RECORDS = 20_000;
const SHA256 = /^[0-9a-f]{64}$/;
const VERDICTS: readonly AgeVerdict[] = ["adult", "under18", "unclear"];
const SEVERITY: Record<AgeVerdict, number> = { adult: 0, unclear: 1, under18: 2 };

export function sha256Of(bytes: Buffer | Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Read the age check's answer strictly: exactly {"apparentAdult": true|false|null}. */
export function parseAgeCheck(answer: string): AgeVerdict | "unreadable" {
  const trimmed = answer.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  let parsed: unknown;
  try {
    parsed = JSON.parse(fenced ? fenced[1]! : trimmed);
  } catch {
    // Prose like "I can't help with that" is a refusal: not clearly an adult.
    return /\b(can['’]?t|cannot|won['’]?t|unable|not able|sorry|refuse)\b/i.test(answer) ? "unclear" : "unreadable";
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "unreadable";
  const obj = parsed as Record<string, unknown>;
  if (obj.refused === true) return "unclear";
  const keys = Object.keys(obj);
  if (keys.length !== 1 || keys[0] !== "apparentAdult") return "unreadable";
  if (obj.apparentAdult === true) return "adult";
  if (obj.apparentAdult === false) return "under18";
  if (obj.apparentAdult === null) return "unclear";
  return "unreadable";
}

const scope = (companyId: string) => ({ scopeKind: "company" as const, scopeId: companyId, stateKey: STATE_KEY });

function readRecord(value: unknown): AgeCheckRecord | null {
  const r = (value ?? {}) as Record<string, unknown>;
  if (typeof r.sha256 !== "string" || !SHA256.test(r.sha256)) return null;
  if (!VERDICTS.includes(r.verdict as AgeVerdict)) return null;
  return {
    sha256: r.sha256,
    verdict: r.verdict as AgeVerdict,
    modelEntryId: typeof r.modelEntryId === "string" ? r.modelEntryId : null,
    checkedAt: typeof r.checkedAt === "string" ? r.checkedAt : "",
  };
}

/** This company's stored results, by content hash. */
export async function loadAgeChecks(ctx: PluginContext, companyId: string): Promise<Map<string, AgeCheckRecord>> {
  const raw = await ctx.state.get(scope(companyId));
  const out = new Map<string, AgeCheckRecord>();
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      const rec = readRecord(value);
      if (rec && rec.sha256 === key) out.set(key, rec);
    }
  }
  return out;
}

/**
 * In-process lock per company: every read-modify-write of the stored results
 * runs one after another, so two checks finishing at the same time can never
 * drop each other's results or let a milder verdict overwrite a stricter one.
 * The chain is entered synchronously, before the first await.
 */
const companyLocks = new Map<string, Promise<unknown>>();
export function withAgeCheckLock<T>(companyId: string, fn: () => Promise<T>): Promise<T> {
  const key = `${STATE_KEY}:${companyId}`;
  const run = (companyLocks.get(key) ?? Promise.resolve()).then(() => fn());
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  companyLocks.set(key, tail);
  void tail.then(() => {
    if (companyLocks.get(key) === tail) companyLocks.delete(key);
  });
  return run;
}

function stricter(a: AgeCheckRecord | undefined, b: AgeCheckRecord): AgeCheckRecord {
  return a && SEVERITY[a.verdict] >= SEVERITY[b.verdict] ? a : b;
}

/** The stored result of one picture, read inside the lock (null: not checked yet). */
export function storedAgeCheck(ctx: PluginContext, companyId: string, sha256: string): Promise<AgeCheckRecord | null> {
  return withAgeCheckLock(companyId, async () => (await loadAgeChecks(ctx, companyId)).get(sha256) ?? null);
}

/**
 * Store one result. Runs inside the company's lock and re-reads right before
 * writing, so results stored by another call meanwhile are kept, and a stored
 * result never gets milder (under18 > unclear > adult). Returns the result
 * that is stored for the picture afterwards (possibly a stricter earlier one).
 */
export function recordAgeCheck(ctx: PluginContext, companyId: string, record: AgeCheckRecord): Promise<AgeCheckRecord> {
  return withAgeCheckLock(companyId, async () => {
    const all = await loadAgeChecks(ctx, companyId);
    const existing = all.get(record.sha256);
    const kept = stricter(existing, record);
    if (kept === existing) return existing;
    all.set(record.sha256, kept);
    let entries = [...all.values()];
    if (entries.length > MAX_RECORDS) {
      // Forget the oldest "adult" results first; refusals are kept.
      const adults = entries.filter((e) => e.verdict === "adult").sort((a, b) => a.checkedAt.localeCompare(b.checkedAt));
      const drop = new Set(adults.slice(0, entries.length - MAX_RECORDS).map((e) => e.sha256));
      entries = entries.filter((e) => !drop.has(e.sha256));
    }
    await ctx.state.set(scope(companyId), Object.fromEntries(entries.map((e) => [e.sha256, e])));
    return kept;
  });
}

export interface AgeCheckPicture {
  fileId: string;
  /** A name the person recognises ("IMG_2041.jpg"), or null. */
  name: string | null;
  sha256: string;
}

export interface AgeCheckedPicture extends AgeCheckPicture {
  verdict: AgeVerdict | null;
  checkedAt: string | null;
}

/** Ask the company's analysis model about one picture; store and return the result. */
export async function runAgeCheck(
  ctx: PluginContext,
  companyId: string,
  analysis: AnalysisModelSetting,
  picture: AgeCheckPicture,
  /** A quick agent's tool-call run id, when the check runs inside one (see PluginImageAnalysisInput.runId). */
  runId?: string | null,
): Promise<AgeCheckRecord> {
  // Checked again right before the call: a picture another call has judged
  // meanwhile (e.g. refused) is not sent to the model again.
  const known = await storedAgeCheck(ctx, companyId, picture.sha256);
  if (known) return known;
  const answer = await ctx.models.analyseImage(companyId, {
    entryId: analysis.entryId,
    fileId: picture.fileId,
    keySecretId: analysis.keySecretId,
    systemPrompt: AGE_CHECK_SYSTEM_PROMPT,
    userPrompt: AGE_CHECK_USER_PROMPT,
    maxOutputTokens: 60,
    ...(runId ? { runId } : {}),
  });
  const verdict = parseAgeCheck(answer.text);
  if (verdict === "unreadable") throw new Error(AGE_CHECK_UNREADABLE_MESSAGE);
  return recordAgeCheck(ctx, companyId, { sha256: picture.sha256, verdict, modelEntryId: analysis.entryId, checkedAt: new Date().toISOString() });
}

/** The stored result of each picture (null: not checked yet). Calls nothing outside. */
export function withVerdicts(pictures: AgeCheckPicture[], checks: Map<string, AgeCheckRecord>): AgeCheckedPicture[] {
  return pictures.map((p) => {
    const rec = checks.get(p.sha256);
    return { ...p, verdict: rec?.verdict ?? null, checkedAt: rec?.checkedAt ?? null };
  });
}

/** One plain sentence naming the refused pictures. */
export function refusedMessage(refused: Array<{ name: string | null; verdict: AgeVerdict | null; position: number }>): string {
  const names = refused.map((r) => `${r.name ?? `picture ${r.position}`} (${r.verdict === "under18" ? "may be under 18" : "not clearly an adult"})`);
  const n = refused.length;
  return `Nothing was sent: ${n} ${n === 1 ? "picture is" : "pictures are"} not clearly of an adult: ${names.join(", ")}. Remove ${n === 1 ? "it" : "them"} from the ticked pictures. ${AGE_CHECK_EXPLANATION}`;
}
