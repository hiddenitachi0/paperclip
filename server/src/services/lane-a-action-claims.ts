/**
 * DUR-4355: a quick agent must never tell the person an action happened when
 * no tool actually ran for it this turn (made/sent a picture, video or
 * audio; saved/remembered something; started a task or job; checked weather
 * or prices). Observed with Maja (Mistral Small 3.2 24B via OpenRouter): the
 * model wrote "[Generating a picture of myself ...]" and "I'll fix it and
 * give you another attempt" without ever calling the Media Studio tool.
 *
 * This module is pure text/data matching, used by lane-a.ts's callModel loop:
 *  1. `detectLaneAActionClaim` — does the reply's text claim a tool-only
 *     action, in English or Norwegian?
 *  2. `isLaneAActionClaimFulfilled` — did a matching tool actually succeed
 *     this turn?
 *  3. When a claim is unfulfilled, `pickLaneAForcedToolName` finds a tool
 *     name offered this turn to force the retry onto (when the provider
 *     supports forcing one), and the two note builders produce the
 *     corrective retry message and the final plain-language fallback.
 *
 * Patterns are deliberately narrow (first-person claims of having done, or
 * being about to do, the specific action) rather than matching any mention
 * of the topic, to keep false positives on ordinary chat low.
 */
import type { LaneAAction } from "./lane-a.js";

export type LaneAActionClaimFamily = "media" | "memory" | "task" | "lookup";

export interface LaneAActionClaimMatch {
  family: LaneAActionClaimFamily;
  /** The exact text the pattern matched, for logging. */
  matchedPhrase: string;
}

interface FamilyRule {
  family: LaneAActionClaimFamily;
  patterns: RegExp[];
  /** Tool names (exact match or substring test) that count as "this family was actually done". */
  toolNames: string[];
  toolNameIncludes?: string[];
  /** Human phrase used in the corrective note and the fallback line, e.g. "make the picture". */
  actionPhrase: string;
}

const FAMILY_RULES: FamilyRule[] = [
  {
    family: "media",
    actionPhrase: "make the picture",
    toolNames: [],
    // The sanitized model-facing name keeps "-" (only "." becomes "_"), so
    // the built-in Media Studio tool is `paperclip_media-studio__generate-image`.
    toolNameIncludes: ["media-studio"],
    patterns: [
      // English: "here is your picture", "I'll generate a video for you", bracketed status notes.
      /\bhere(?:'s| is) (?:your|the) (?:picture|image|photo|video|clip|song|audio)\b/i,
      /\bi(?:'m| am|'ll| will)?\s*(?:generat(?:e|ing)|mak(?:e|ing)|creat(?:e|ing)|draw(?:ing)?)\s+(?:you\s+)?(?:a|the|your)?\s*(?:picture|image|photo|video|clip|song|audio)\b/i,
      /\[\s*generating\s+(?:a|the)?\s*(?:picture|image|photo|video|audio)[^\]]*\]/i,
      /\bi('ll| will) fix it and (?:give|send) you another (?:attempt|try|one|picture|image)\b/i,
      // Norwegian: "her er bildet", "jeg lager et bilde til deg".
      /\bher (?:er|kommer) (?:bildet|videoen|lydklippet|bildet ditt)\b/i,
      /\bjeg\s*(?:lager|genererer|sender)\s*(?:deg\s+)?(?:et|en|)?\s*(?:bilde|bildet|video|videoen|lydklipp)\b/i,
    ],
  },
  {
    family: "memory",
    actionPhrase: "save that to memory",
    toolNames: ["remember", "forget"],
    patterns: [
      /\bi(?:'ve| have) (?:remembered|saved|noted|stored) (?:that|this|it)\b/i,
      /\bi('ll| will) remember (?:that|this|it)\b/i,
      // Norwegian: "jeg har husket/lagret det", "jeg skal huske dette".
      /\bjeg har (?:husket|lagret|notert) (?:det|dette)\b/i,
      /\bjeg skal huske (?:det|dette)\b/i,
    ],
  },
  {
    family: "task",
    actionPhrase: "start the job",
    toolNames: ["start_job", "start_research_task", "route_to_agent"],
    patterns: [
      /\bi(?:'ve| have) (?:started|kicked off|begun) (?:the|a|that) (?:job|task)\b/i,
      /\bi('ll| will) (?:start|get (?:started|right) on) (?:the|a|that) (?:job|task)\b/i,
      /\bi(?:'ve| have) handed (?:this|it) (?:over )?to\b/i,
      // Norwegian: "jeg har startet jobben", "jeg skal sette i gang oppgaven".
      /\bjeg har (?:startet|satt i gang) (?:jobben|oppgaven)\b/i,
      /\bjeg (?:skal|vil) (?:starte|sette i gang) (?:jobben|oppgaven)\b/i,
    ],
  },
  {
    family: "lookup",
    actionPhrase: "check that",
    toolNames: ["get_weather", "web_search", "read_web_page", "read_business_data"],
    patterns: [
      /\bi(?:'ve| have) checked (?:the )?(?:weather|price|prices)\b/i,
      /\bi('ll| will) check (?:the )?(?:weather|price|prices)\b/i,
      /\blet me (?:check|look up) (?:the )?(?:weather|price|prices)\b/i,
      // Norwegian: "jeg har sjekket været/prisen", "jeg skal sjekke prisene".
      /\bjeg har sjekket (?:været|prisen|prisene)\b/i,
      /\bjeg (?:skal|vil) sjekke (?:været|prisen|prisene)\b/i,
    ],
  },
];

/** Does the reply's text claim a tool-only action, in English or Norwegian? Null when it does not. */
export function detectLaneAActionClaim(text: string): LaneAActionClaimMatch | null {
  for (const rule of FAMILY_RULES) {
    for (const pattern of rule.patterns) {
      const match = text.match(pattern);
      if (match) return { family: rule.family, matchedPhrase: match[0] };
    }
  }
  return null;
}

function familyRule(family: LaneAActionClaimFamily): FamilyRule {
  const rule = FAMILY_RULES.find((r) => r.family === family);
  if (!rule) throw new Error(`Unknown lane A action-claim family: ${family}`);
  return rule;
}

function toolNameMatchesFamily(family: LaneAActionClaimFamily, toolName: string): boolean {
  const rule = familyRule(family);
  if (rule.toolNames.includes(toolName)) return true;
  return (rule.toolNameIncludes ?? []).some((needle) => toolName.includes(needle));
}

/**
 * A tool name we have specific family rules for, so we know exactly what it
 * does (and, by elimination, what it does not do). Anything else is a
 * company API tool or MCP connector with an arbitrary name -- we have no way
 * to know it *isn't* the one that produced the claimed action.
 */
function isKnownBuiltinToolName(toolName: string): boolean {
  return FAMILY_RULES.some(
    (rule) => rule.toolNames.includes(toolName) || (rule.toolNameIncludes ?? []).some((needle) => toolName.includes(needle)),
  );
}

/** Did a tool call matching this family actually succeed this turn? */
export function isLaneAActionClaimFulfilled(family: LaneAActionClaimFamily, actions: LaneAAction[]): boolean {
  return actions.some((action) => {
    if (!action.ok) return false;
    if (toolNameMatchesFamily(family, action.tool)) return true;
    // A picture/video/audio made by any tool (not just a name containing
    // "media_studio") still counts for the media family.
    if (family === "media" && Boolean((action as { image?: unknown }).image)) return true;
    // A successful call to a tool we have no family rule for (a company API
    // tool or MCP connector) can do anything -- trust that it produced the
    // claimed action rather than forcing a retry onto a tool that was never
    // going to match any name we recognize.
    return !isKnownBuiltinToolName(action.tool);
  });
}

/** The first tool name offered this turn that matches the family, for forcing the retry onto. Null when none is offered. */
export function pickLaneAForcedToolName(family: LaneAActionClaimFamily, offeredToolNames: Iterable<string>): string | null {
  for (const name of offeredToolNames) {
    if (toolNameMatchesFamily(family, name)) return name;
  }
  return null;
}

/** The short system note for the one automatic retry, forcing the model to either call the tool or say plainly that it cannot. */
export function buildLaneAActionClaimRetryNote(family: LaneAActionClaimFamily): string {
  const phrase = familyRule(family).actionPhrase;
  return `You said you would ${phrase} but did not call the tool. Call the tool now, or say plainly that you cannot.`;
}

/** What the person sees when the retry still made no matching tool call. */
export function buildLaneAActionClaimFallbackLine(family: LaneAActionClaimFamily): string {
  const phrase = familyRule(family).actionPhrase;
  return `I could not ${phrase} this time.`;
}
