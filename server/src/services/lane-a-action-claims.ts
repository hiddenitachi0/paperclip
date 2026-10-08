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
      // Paperclip's own replay note, copied into a reply: the model is
      // imitating an earlier picture turn instead of calling the tool
      // (7-8 Oct, Maja on qwen3.8-27b and Mistral Small 3.2).
      /\[\s*Picture made in this turn\b/i,
      // A picture call written out as text that was not valid enough to be
      // made for real (7 Oct: {"name":"generate-image","parameters":{… with
      // a broken quote) -- treat it as a claim so the retry makes it properly.
      /^\s*(?:```(?:json)?\s*)?\{\s*"name"\s*:\s*"[^"]*(?:generate-image|quick-picture|generate-video|generate-audio)"/i,
      // English: "here is your picture", "I'll generate another image for you", bracketed status notes.
      /\bhere(?:'s| is| are) (?:your|the|another|a new|some|more|a few|two|three) (?:(?:new|other|different|fresh)\s+)?(?:pictures?|images?|photos?|shots?|selfies?|videos?|clips?|songs?|audio)\b/i,
      /\bi(?:'m| am|'ll| will|'ve| have)?\s*(?:generat(?:e|ed|ing)|mak(?:e|ing)|made|creat(?:e|ed|ing)|draw(?:ing|n)?|snap(?:ped|ping)?)\s+(?:you\s+)?(?:a|an|the|your|another|one more|a new|new|more|some|a few|two|three)?\s*(?:(?:new|other|different|fresh|quick)\s+)?(?:pictures?|images?|photos?|selfies?|videos?|clips?|songs?|audio)\b/i,
      /\[\s*generating\s+(?:a|the|another)?\s*(?:picture|image|photo|video|audio)[^\]]*\]/i,
      /\bi('ll| will) fix it and (?:give|send) you another (?:attempt|try|one|picture|image)\b/i,
      // Norwegian: "her er bildet", "her er et nytt bilde", "jeg lager et bilde til deg".
      /\bher (?:er|kommer) (?:bildet|bildene|videoen|lydklippet|bildet ditt|et nytt bilde|et bilde|et annet bilde|enda et bilde)\b/i,
      /\bjeg\s*(?:lager|laget|genererer|sender|tar|tegner)\s*(?:deg\s+)?(?:et|en|ett|enda et|et nytt|et annet|)?\s*(?:bilde|bildet|bilder|video|videoen|lydklipp)\b/i,
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

// A tool that MAKES media: "…__generate-image", "…__quick-picture",
// "…__make-picture", "…__generate-video", "…__generate-audio". Tools that only
// list looks, check a job, improve a prompt or edit an existing picture are
// never the one to force when a new picture was promised or asked for.
const MEDIA_GENERATOR_TOOL = /(?:^|__|\.)(?:generate|make|create|draw|quick)[-_](?:image|picture|photo|video|audio|song|music)s?$/i;

/** Which kind of media a text is about, so the forced retry picks the matching tool. */
function mediaKind(text: string | undefined): "video" | "audio" | "image" {
  const t = (text ?? "").toLowerCase();
  if (/\b(?:videos?|clips?|film|videoen)\b/.test(t)) return "video";
  if (/\b(?:songs?|music|audio|sound|speech|voice|musikk|sang|lydklipp)\b/.test(t)) return "audio";
  return "image";
}

/**
 * The tool offered this turn to force the retry onto, or null when none is.
 * For media it picks a generator of the kind the text is about (a full
 * picture before a quick one) and never a helper; `hint` is the claim or the
 * request text.
 */
export function pickLaneAForcedToolName(
  family: LaneAActionClaimFamily,
  offeredToolNames: Iterable<string>,
  hint?: string,
): string | null {
  const names = Array.from(offeredToolNames);
  if (family !== "media") return names.find((name) => toolNameMatchesFamily(family, name)) ?? null;
  const generators = names.filter((name) => MEDIA_GENERATOR_TOOL.test(name));
  const kind = mediaKind(hint);
  const kindPattern = kind === "video" ? /video$/i : kind === "audio" ? /(?:audio|song|music)$/i : /(?:image|picture|photo)s?$/i;
  const ofKind = generators.filter((name) => kindPattern.test(name));
  return ofKind.find((name) => !/quick[-_]picture$/i.test(name)) ?? ofKind[0] ?? generators[0] ?? null;
}

/**
 * Was any media tool called this turn, whatever the outcome? A request-type
 * retry is only for a reply that never tried: a call the picture service
 * refused (content policy, limit, outage) must not be forced again.
 */
export function laneAMediaToolAttempted(actions: readonly LaneAAction[]): boolean {
  return actions.some(
    (action) =>
      Boolean((action as { image?: unknown }).image) ||
      MEDIA_GENERATOR_TOOL.test(action.tool) ||
      toolNameMatchesFamily("media", action.tool),
  );
}

/**
 * Does the person's message ask for a picture (or video/sound) to be made?
 * English and Norwegian. `pictureEarlier` is true when an earlier turn of
 * this conversation made a picture: then a short follow-up such as "another
 * one", "other angles" or "en til" counts too.
 *
 * Narrow on purpose: a request verb near a picture word ("send me an image",
 * "show me a picture of …", "lag et bilde"), not any mention of pictures
 * ("what do you think of this image?" is not a request).
 */
export function detectLaneAPictureRequest(message: string, opts: { pictureEarlier: boolean }): boolean {
  const text = message.toLowerCase().trim();
  // "What do you think of the picture?" asks about one; "can you send me a
  // picture?" asks for one.
  if (/^(?:what|why|how|do|does|did|is|are|was|were|which|who|hva|hvorfor|hvordan|liker|er)\b/.test(text) && text.includes("?")) {
    return false;
  }
  const noun = "(?:pictures?|images?|photos?|pics?|selfies?|drawings?|portraits?|wallpapers?|videos?|clips?)";
  const verb = "(?:send|show|make|create|generate|draw|paint|render|snap|share|post)";
  if (new RegExp(`\\b${verb}\\b(?:\\s+\\S+){0,8}?\\s+${noun}\\b`).test(text)) return true;
  if (new RegExp(`\\b(?:another|one more|a new|different)\\s+(?:\\S+\\s+){0,2}?${noun}\\b`).test(text)) return true;
  // Noun-led follow-ups: "And a short video of the beam at night."
  if (new RegExp(`^(?:and\\s+|now\\s+|then\\s+|also\\s+)?(?:a|an)\\s+(?:\\S+\\s+){0,2}?${noun}\\s+(?:of|from|with|showing)\\b`).test(text)) return true;
  const nounNo = "(?:bilde|bildet|bilder|bildene|foto|selfie|tegning|video|videoen)";
  const verbNo = "(?:send|vis|lag|tegn|generer|mal)";
  if (new RegExp(`\\b${verbNo}\\b(?:\\s+\\S+){0,8}?\\s+${nounNo}\\b`).test(text)) return true;
  if (new RegExp(`\\b(?:et nytt|et annet|enda et|ett til)\\s+${nounNo}\\b`).test(text)) return true;
  if (!opts.pictureEarlier) return false;
  return /\b(?:another one|one more|again|more of (?:those|these|them)|(?:other|different|new|another) (?:angles?|poses?|views?|outfits?|styles?|versions?)|variations?|try again|en til|ett til|igjen|(?:ny|nye|andre|annen) (?:vinkel|vinkler|positur|stil|versjon))\b/.test(text);
}

/**
 * The short system note for the one automatic retry, forcing the model to
 * either call the tool or say plainly that it cannot. `reason` "request" is
 * used when the person asked for a picture and the reply made none (no claim
 * in the reply itself).
 */
export function buildLaneAActionClaimRetryNote(family: LaneAActionClaimFamily, reason: "claim" | "request" = "claim"): string {
  const phrase = familyRule(family).actionPhrase;
  if (reason === "request") {
    return `The person asked you to ${phrase} and no tool made it. Call the tool now with a fitting description, or say plainly that you cannot.`;
  }
  return `You said you would ${phrase} but did not call the tool. Call the tool now, or say plainly that you cannot.`;
}

/** What the person sees when the retry still made no matching tool call. */
export function buildLaneAActionClaimFallbackLine(family: LaneAActionClaimFamily): string {
  const phrase = familyRule(family).actionPhrase;
  return `I could not ${phrase} this time.`;
}
