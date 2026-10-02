import { z } from "zod";
import { VIDEO_SHOT_TRANSITIONS, type VideoShotTransition } from "./video-storylines.js";

/**
 * DUR-4327 (backend half of DUR-4325): the whole-storyline AI director
 * conversation -- review, turn-by-turn dialogue, per-shot proposals. These
 * enum lists MUST stay byte-for-byte in sync with
 * packages/db/src/schema/video_storyline_director_conversations.ts and
 * video_storyline_director_messages.ts's CHECK constraints (and video_shots'
 * proposal_status check), since nothing enforces the two automatically.
 *
 * Additive on top of, and entirely separate from, the existing
 * video-storylines.ts director types (VideoDirectorRunSummary etc, backing
 * video_storyline_director_runs) -- that is still the single-shot
 * idea-to-drafted-shots flow for one scene; this is the whole-storyline
 * review/dialogue/proposal flow.
 */

export const VIDEO_DIRECTOR_CONVERSATION_STATUSES = ["reviewing", "asking", "proposing", "done"] as const;
export type VideoDirectorConversationStatus = (typeof VIDEO_DIRECTOR_CONVERSATION_STATUSES)[number];

export const VIDEO_DIRECTOR_MESSAGE_ROLES = ["director", "person"] as const;
export type VideoDirectorMessageRole = (typeof VIDEO_DIRECTOR_MESSAGE_ROLES)[number];

export const VIDEO_DIRECTOR_MESSAGE_KINDS = ["review", "question", "answer", "proposal", "system"] as const;
export type VideoDirectorMessageKind = (typeof VIDEO_DIRECTOR_MESSAGE_KINDS)[number];

export const VIDEO_SHOT_PROPOSAL_STATUSES = ["pending", "accepted", "edited", "rejected"] as const;
export type VideoShotProposalStatus = (typeof VIDEO_SHOT_PROPOSAL_STATUSES)[number];

// ─── Limits ──────────────────────────────────────────────────────────────

/** Same model/shape as the round-1 director AI (video-storylines.ts) -- one structured-output call per step. */
export const VIDEO_DIRECTOR_REVIEW_MODEL = "claude-sonnet-5";
export const VIDEO_DIRECTOR_REVIEW_MAX_OUTPUT_TOKENS = 8_000;
export const VIDEO_DIRECTOR_DIALOGUE_MODEL = "claude-sonnet-5";
export const VIDEO_DIRECTOR_DIALOGUE_MAX_OUTPUT_TOKENS = 4_000;
export const VIDEO_DIRECTOR_PROPOSALS_MODEL = "claude-sonnet-5";
export const VIDEO_DIRECTOR_PROPOSALS_MAX_OUTPUT_TOKENS = 8_000;

/** "A few at a time" per the ticket -- bounds one dialogue turn's question batch. */
export const VIDEO_DIRECTOR_DIALOGUE_MAX_QUESTIONS_PER_TURN = 5;
export const VIDEO_DIRECTOR_DIALOGUE_MAX_OPTIONS_PER_QUESTION = 6;
export const VIDEO_DIRECTOR_DIALOGUE_MAX_ANSWERS_PER_TURN = 20;
/** Hard stop so a storyline that never says "good enough" cannot loop forever against the model. */
export const VIDEO_DIRECTOR_DIALOGUE_MAX_TURNS = 25;

/** The literal free-text a person can send instead of answering a specific question. */
export const VIDEO_DIRECTOR_GOOD_ENOUGH_PHRASE = "good enough";
export const VIDEO_DIRECTOR_YOU_DECIDE_PHRASE = "you decide";

// ─── Review (kind: "review", role: "director") ──────────────────────────

export interface VideoDirectorReviewShotFinding {
  shotId: string;
  sceneId: string;
  orderIndex: number;
  /** Plain-language missing/unclear points for this shot (who/what, wardrobe/appearance continuity, setting, time of day, lighting, camera framing/movement, mood, pacing, transition, sound). Empty when the shot is already specific enough. */
  issues: string[];
}

export interface VideoDirectorReviewPayload {
  /** One or two plain sentences summarizing the storyline's overall readiness. */
  summary: string;
  shotFindings: VideoDirectorReviewShotFinding[];
  /** Plain-language contradictions between shots (e.g. a character's wardrobe or the time of day flips without explanation). */
  contradictions: string[];
  /** Plain-language continuity risks across the whole storyline. */
  continuityRisks: string[];
}

// ─── Dialogue (kind: "question", role: "director"; kind: "answer", role: "person") ──

export interface VideoDirectorQuestionOption {
  id: string;
  label: string;
}

export interface VideoDirectorQuestion {
  /** Stable within the conversation -- a person's answer references this id. */
  id: string;
  /** Which shot this question is about, or null for a storyline-wide question. */
  shotId: string | null;
  prompt: string;
  /** Empty = free text; otherwise the person picks one (or still answers free text/"you decide"). */
  options: VideoDirectorQuestionOption[];
}

export interface VideoDirectorQuestionBatchPayload {
  questions: VideoDirectorQuestion[];
  /** True when the AI believes every shot is now specific enough -- `questions` is empty in that case. */
  doneAsking: boolean;
}

export interface VideoDirectorAnswerEntry {
  questionId: string;
  youDecide: boolean;
  selectedOptionId: string | null;
  answerText: string | null;
}

export interface VideoDirectorAnswerPayload {
  /** True when the person said "good enough" to end the dialogue outright, independent of any per-question answers. */
  goodEnough: boolean;
  answers: VideoDirectorAnswerEntry[];
}

// ─── Proposals (kind: "proposal", role: "director") ─────────────────────

export interface VideoDirectorProposalEntry {
  shotId: string;
  proposedPrompt: string;
  proposedCameraNotes: string | null;
  proposedDurationSeconds: number;
  proposedTransitionIn: VideoShotTransition | null;
  /** One short sentence: what changed and why, for the person reviewing the proposal. */
  rationale: string;
}

export interface VideoDirectorProposalBatchPayload {
  proposals: VideoDirectorProposalEntry[];
}

// ─── System (kind: "system", role: "director") ──────────────────────────

export interface VideoDirectorSystemPayload {
  note: string;
}

export type VideoDirectorMessagePayload =
  | VideoDirectorReviewPayload
  | VideoDirectorQuestionBatchPayload
  | VideoDirectorAnswerPayload
  | VideoDirectorProposalBatchPayload
  | VideoDirectorSystemPayload;

// ─── API-facing shapes ───────────────────────────────────────────────────

export interface VideoDirectorConversationSummary {
  id: string;
  storylineId: string;
  status: VideoDirectorConversationStatus;
  createdAt: string;
  updatedAt: string;
}

export interface VideoDirectorMessageSummary {
  id: string;
  conversationId: string;
  role: VideoDirectorMessageRole;
  kind: VideoDirectorMessageKind;
  payload: VideoDirectorMessagePayload;
  createdAt: string;
}

export interface VideoDirectorConversationDetail extends VideoDirectorConversationSummary {
  messages: VideoDirectorMessageSummary[];
}

export interface VideoShotPromptHistoryEntry {
  prompt: string;
  cameraNotes: string | null;
  durationSeconds: number;
  transitionIn: VideoShotTransition | null;
  replacedAt: string;
}

// ─── Validators ──────────────────────────────────────────────────────────

const answerEntrySchema = z
  .object({
    questionId: z.string().trim().min(1),
    youDecide: z.boolean().optional().default(false),
    selectedOptionId: z.string().trim().min(1).nullable().optional().default(null),
    answerText: z.string().trim().max(2000).nullable().optional().default(null),
  })
  .strict();

export const answerVideoDirectorConversationSchema = z
  .object({
    goodEnough: z.boolean().optional().default(false),
    answers: z.array(answerEntrySchema).max(VIDEO_DIRECTOR_DIALOGUE_MAX_ANSWERS_PER_TURN).optional().default([]),
  })
  .strict()
  .refine((value) => value.goodEnough || value.answers.length > 0, {
    message: "Answer at least one open question, or say it's good enough.",
  });
export type AnswerVideoDirectorConversationInput = z.infer<typeof answerVideoDirectorConversationSchema>;

export const editVideoDirectorProposalSchema = z
  .object({
    prompt: z.string().trim().min(1, "Describe what happens in this shot.").max(4000).optional(),
    cameraNotes: z.string().trim().max(2000).nullable().optional(),
    durationSeconds: z.number().int().min(1).max(60).optional(),
    transitionIn: z.enum(VIDEO_SHOT_TRANSITIONS).nullable().optional(),
  })
  .strict();
export type EditVideoDirectorProposalInput = z.infer<typeof editVideoDirectorProposalSchema>;
