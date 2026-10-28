// DUR-4902: the "How was this made?" record of one storyboard picture or one
// video clip. Written into the activity log's details.generation when the
// picture is made / the clip is started and finished, and read back for the
// panel on each picture and clip.
//
// Built from named fields only, never by copying a request: the request holds
// the provider key's header, picture bytes (data: URIs) and more. The prompt
// text is scrubbed as well (a pasted key or a picture's data: address is
// removed), and logActivity runs sanitizeRecord over the details on top.

import { and, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { activityLog } from "@paperclipai/db";
import {
  GENERATION_SEED_UNSUPPORTED,
  type VideoShotGenerationRecord,
  type VideoShotGenerationResponse,
} from "@paperclipai/shared";
import { applyLoraRules, SOGNI_MAX_LORAS, type ContentMode, type SogniLoraInfo } from "@paperclipai/plugin-sdk/media";
import { redactKnownLeakedSecretPatterns, redactKnownSecretValues } from "../redaction.js";
import type { SentRequestFacts } from "./generation-facts.js";
import { loraFitDrops } from "./storyboard-picture-look.js";

export const STILL_RECORD_ACTION = "video_shot.still_generated";
export const CLIP_STARTED_ACTION = "video_shot.render_started";
export const CLIP_FINISHED_ACTION = "video_shot.render_finished";

const DATA_URI_RE = /data:[a-z0-9.+/-]+(?:;[a-z0-9=.+-]+)*;base64,[A-Za-z0-9+/=_-]+/gi;
const PROMPT_MAX = 8000;

/** Prompt text safe to store: picture data and key-shaped text removed, the known keys of this request removed, and bounded. */
export function scrubRecordText(text: string, knownSecrets: readonly string[] = []): string {
  const withoutPictures = text.replace(DATA_URI_RE, "[picture data left out]");
  const clean = redactKnownLeakedSecretPatterns(redactKnownSecretValues(withoutPictures, knownSecrets));
  return clean.length > PROMPT_MAX ? `${clean.slice(0, PROMPT_MAX)}…` : clean;
}

export interface RequestedLora {
  id: string;
  strength: number;
}

/**
 * Which of the requested LoRAs did not go out, and why. Reasons come from the
 * same rules the request was built with: the film's rating rules, then the
 * model fit and Sogni's limit. A LoRA that is not in `sent` and matches no
 * rule still gets a reason, never a silent gap.
 */
export function explainDroppedLoras(input: {
  requested: readonly RequestedLora[];
  sent: readonly RequestedLora[];
  mode: ContentMode;
  model: string;
  known: SogniLoraInfo[] | null;
}): Array<{ id: string; reason: string }> {
  const sentIds = new Set(input.sent.map((l) => l.id));
  const missing = input.requested.filter((l) => !sentIds.has(l.id));
  if (missing.length === 0) return [];
  const byRating = new Map(applyLoraRules(input.requested, input.mode, input.known).dropped.map((d) => [d.id, d.message]));
  const byFit = new Map(loraFitDrops(input.requested.filter((l) => !byRating.has(l.id)), input.model, input.known).map((d) => [d.id, d.reason]));
  const seen = new Set<string>();
  const out: Array<{ id: string; reason: string }> = [];
  for (const l of missing) {
    if (seen.has(l.id)) continue;
    seen.add(l.id);
    out.push({
      id: l.id,
      reason: byRating.get(l.id) ?? byFit.get(l.id) ?? `Left out of the request (Sogni takes at most ${SOGNI_MAX_LORAS} LoRAs, and this one did not fit the picture's rules).`,
    });
  }
  return out;
}

export interface GenerationRecordInput {
  kind: "still" | "clip";
  prompt: string;
  provider: string;
  model: string | null;
  /** Set when the picture was made from reference pictures with an editing model. */
  editModel?: string | null;
  sent: SentRequestFacts | null | undefined;
  loras?: readonly RequestedLora[];
  lorasDropped?: ReadonlyArray<{ id: string; reason: string }>;
  contentRating: ContentMode;
  references?: ReadonlyArray<{ fileId: string | null; role: string }>;
  referencesNotSent?: number;
  estimatedCostCents: number | null;
  actualCostCents?: number | null;
  providerCredits?: number | null;
  notes?: readonly string[];
  /** The request's own secrets (the provider key), removed from any text if they somehow appear in it. */
  knownSecrets?: readonly string[];
  now?: Date;
}

export function buildGenerationRecord(input: GenerationRecordInput): VideoShotGenerationRecord {
  const secrets = input.knownSecrets ?? [];
  const sent = input.sent ?? null;
  const negative = sent?.negativePrompt?.trim() ? scrubRecordText(sent.negativePrompt.trim(), secrets) : null;
  return {
    version: 1,
    kind: input.kind,
    madeAt: (input.now ?? new Date()).toISOString(),
    promptSent: scrubRecordText(input.prompt, secrets),
    negativePromptSent: negative,
    provider: input.provider,
    model: input.model,
    editModel: input.editModel ?? null,
    tool: sent?.tool ?? null,
    loras: (input.loras ?? []).map((l) => ({ id: l.id, strength: l.strength })),
    lorasDropped: (input.lorasDropped ?? []).map((l) => ({ id: l.id, reason: scrubRecordText(l.reason, secrets) })),
    contentRating: input.contentRating,
    contentFilterOn: sent?.contentFilterOn ?? null,
    providerSafety: { ...(sent?.safety ?? {}) },
    promptExpansion: sent?.promptExpansion ?? "not supported by this tool",
    references: (input.references ?? []).map((r) => ({ fileId: r.fileId, role: r.role })),
    referencesNotSent: input.referencesNotSent ?? 0,
    seed: sent?.seed ?? GENERATION_SEED_UNSUPPORTED,
    estimatedCostCents: input.estimatedCostCents,
    actualCostCents: input.actualCostCents ?? null,
    providerCredits: input.providerCredits ?? null,
    notes: (input.notes ?? []).map((n) => scrubRecordText(n, secrets)),
  };
}

function asRecord(details: unknown): VideoShotGenerationRecord | null {
  if (!details || typeof details !== "object") return null;
  const generation = (details as Record<string, unknown>).generation;
  if (!generation || typeof generation !== "object" || (generation as { version?: unknown }).version !== 1) return null;
  return generation as VideoShotGenerationRecord;
}

/** The newest record of each kind for one shot (company-scoped). */
export async function readShotGenerationRecords(db: Db, companyId: string, shotId: string): Promise<VideoShotGenerationResponse> {
  const rows = await db
    .select({ action: activityLog.action, details: activityLog.details })
    .from(activityLog)
    .where(
      and(
        eq(activityLog.companyId, companyId),
        eq(activityLog.entityType, "video_shot"),
        eq(activityLog.entityId, shotId),
        inArray(activityLog.action, [STILL_RECORD_ACTION, CLIP_STARTED_ACTION, CLIP_FINISHED_ACTION]),
      ),
    )
    .orderBy(desc(activityLog.createdAt))
    .limit(20);
  let still: VideoShotGenerationRecord | null = null;
  let clip: VideoShotGenerationRecord | null = null;
  for (const row of rows) {
    const record = asRecord(row.details);
    if (!record) continue;
    if (row.action === STILL_RECORD_ACTION) still ??= record;
    else clip ??= record;
  }
  return { still, clip };
}

/** The record written when this shot's current clip was started (to be completed with the cost when it finishes); null when none exists. */
export async function readClipStartRecord(db: Db, companyId: string, shotId: string): Promise<VideoShotGenerationRecord | null> {
  const [row] = await db
    .select({ details: activityLog.details })
    .from(activityLog)
    .where(and(eq(activityLog.companyId, companyId), eq(activityLog.entityType, "video_shot"), eq(activityLog.entityId, shotId), eq(activityLog.action, CLIP_STARTED_ACTION)))
    .orderBy(desc(activityLog.createdAt))
    .limit(1);
  return asRecord(row?.details);
}
