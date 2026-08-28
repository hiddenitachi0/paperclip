import Anthropic from "@anthropic-ai/sdk";
import { HttpError } from "../errors.js";

/**
 * DUR-251/DUR-335: the "secretary" that stands in for the hardcoded CEO
 * default in Simple Mode. A single cheap LLM call (same cost class as Lane A,
 * see lane-a.ts) that reads the free-text request plus the company's
 * available-agent roster and picks a lane + recipient. It is not a
 * conversation — no turn cap, no persisted state, no agent-facing tools —
 * just classification, so it deliberately does not reuse laneAService's
 * conversation bookkeeping.
 */

export const SECRETARY_CLASSIFIER_MODEL = "claude-sonnet-5";
const SECRETARY_CLASSIFIER_MAX_OUTPUT_TOKENS = 300;
// Mirrors chat-router's own message cap so the classifier never sees more
// than the endpoint it feeds would accept anyway.
export const SECRETARY_CLASSIFIER_MAX_MESSAGE_LENGTH = 20_000;

export interface SecretaryRosterEntry {
  id: string;
  name: string;
  role: string;
}

export interface SecretaryClassification {
  lane: "a" | "b";
  targetAgentId: string;
  reasoning: string;
}

function buildSystemPrompt(roster: SecretaryRosterEntry[]): string {
  const rosterList = roster
    .map((entry) => `- id=${entry.id} name=${JSON.stringify(entry.name)} role=${entry.role}`)
    .join("\n");
  return [
    "You are Paperclip's routing secretary. A person just typed a plain-language " +
      "request into Simple Mode. You have no tools and cannot change anything — " +
      "decide two things and respond with ONLY a single JSON object, no prose " +
      "before or after it:",
    '{"lane": "a" | "b", "targetAgentId": "<one id from the roster below>", "reasoning": "<one or two plain sentences a non-technical reader can understand>"}',
    "",
    'lane "a" = a quick question that can be answered directly from what someone already knows; nothing gets built, fixed, or changed.',
    'lane "b" = real work: something must be built, fixed, deployed, investigated, or otherwise changed.',
    "",
    "Pick targetAgentId as the single best-fit person for this request based on " +
      "their name and role. If nothing fits well, pick the most generalist role " +
      "available (e.g. a CEO or generalist role) rather than leaving it blank.",
    "",
    "Roster (pick targetAgentId only from these ids):",
    rosterList,
  ].join("\n");
}

function extractJsonObject(text: string): unknown {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) throw new HttpError(502, "Secretary classifier returned no parseable JSON");
  try {
    return JSON.parse(match[0]);
  } catch {
    throw new HttpError(502, "Secretary classifier returned invalid JSON");
  }
}

function parseClassification(text: string, roster: SecretaryRosterEntry[]): SecretaryClassification {
  const parsed = extractJsonObject(text);
  if (typeof parsed !== "object" || parsed === null) {
    throw new HttpError(502, "Secretary classifier returned a non-object");
  }
  const { lane, targetAgentId, reasoning } = parsed as Record<string, unknown>;
  if (lane !== "a" && lane !== "b") {
    throw new HttpError(502, "Secretary classifier returned an invalid lane");
  }
  if (typeof targetAgentId !== "string" || !roster.some((entry) => entry.id === targetAgentId)) {
    throw new HttpError(502, "Secretary classifier picked a recipient outside the roster");
  }
  if (typeof reasoning !== "string" || !reasoning.trim()) {
    throw new HttpError(502, "Secretary classifier returned no reasoning");
  }
  return { lane, targetAgentId, reasoning: reasoning.trim() };
}

export function secretaryClassifierService() {
  async function classify(params: {
    message: string;
    roster: SecretaryRosterEntry[];
  }): Promise<SecretaryClassification> {
    const { roster } = params;
    if (roster.length === 0) {
      throw new HttpError(409, "No agents are available to route this request to");
    }
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new HttpError(503, "Secretary classifier is not configured on this instance (ANTHROPIC_API_KEY unset)");
    }
    const message = params.message.slice(0, SECRETARY_CLASSIFIER_MAX_MESSAGE_LENGTH);
    const client = new Anthropic({ apiKey });

    let response;
    try {
      response = await client.messages.create({
        model: SECRETARY_CLASSIFIER_MODEL,
        max_tokens: SECRETARY_CLASSIFIER_MAX_OUTPUT_TOKENS,
        system: buildSystemPrompt(roster),
        messages: [{ role: "user", content: message }],
      });
    } catch (err) {
      if (err instanceof Anthropic.AuthenticationError) {
        throw new HttpError(503, "Secretary classifier credentials are invalid");
      }
      if (err instanceof Anthropic.RateLimitError) {
        throw new HttpError(429, "Secretary classifier is rate limited upstream — retry shortly");
      }
      if (err instanceof Anthropic.APIError) {
        throw new HttpError(502, `Secretary classifier call failed: ${err.message}`);
      }
      throw err;
    }

    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("");

    return parseClassification(text, roster);
  }

  return { classify };
}
