import { z } from "zod";
import {
  VIDEO_SHOT_DEFAULT_DURATION_SECONDS,
  VIDEO_SHOT_MAX_DURATION_SECONDS,
  VIDEO_SHOT_MIN_DURATION_SECONDS,
  VIDEO_SHOT_TRANSITIONS,
  VIDEO_STORYLINE_MAX_SCENES,
  VIDEO_STORYLINE_MAX_SHOTS,
  FAL_KLING_ALLOWED_DURATIONS_SECONDS,
  VIDEO_STORYLINE_PROVIDERS,
  type VideoShotTransition,
} from "./video-storylines.js";

/**
 * Video storyline scripts: a whole storyline (scenes + shots) written as one
 * JSON document, usually by an AI script writer, and imported in one go
 * (POST .../video-storylines/import and .../video-storylines/:id/import).
 *
 * The clip-length rules themselves (videoRenderDurationSeconds) live in
 * video-storylines.ts next to the cost estimate that uses them.
 */

/** Plain-language note about clip lengths, shown in the script-writer instructions and the editor. */
export const VIDEO_CLIP_LENGTH_NOTE =
  `Fal.ai (the default provider, Kling video models) only makes clips of ${FAL_KLING_ALLOWED_DURATIONS_SECONDS.join(" or ")} seconds. ` +
  `A shot written with another length is rendered at the next allowed length (for example 3 -> 5, 7 -> 10, anything over 10 -> 10) ` +
  `and is billed at that length. Sogni accepts any length from ${VIDEO_SHOT_MIN_DURATION_SECONDS} to ${VIDEO_SHOT_MAX_DURATION_SECONDS} seconds as far as we know. ` +
  `When in doubt, use 5 or 10.`;

// ─── Script import: limits ─────────────────────────────────────────────────

export const VIDEO_SCRIPT_TITLE_MAX_LENGTH = 200;
export const VIDEO_SCRIPT_SCENE_TITLE_MAX_LENGTH = 200;
export const VIDEO_SCRIPT_SCENE_NOTES_MAX_LENGTH = 4_000;
export const VIDEO_SCRIPT_PROMPT_MAX_LENGTH = 4_000;
export const VIDEO_SCRIPT_CAMERA_NOTES_MAX_LENGTH = 2_000;
export const VIDEO_SCRIPT_MAX_CHARACTERS = 50;
export const VIDEO_SCRIPT_CHARACTER_NAME_MAX_LENGTH = 100;
export const VIDEO_SCRIPT_CHARACTER_DESCRIPTION_MAX_LENGTH = 1_000;
/** How many problems one validation reports before summarising the rest -- a broken 1,000-shot script should not produce a 1,000-line error. */
export const VIDEO_SCRIPT_MAX_REPORTED_ERRORS = 50;
export const VIDEO_SCRIPT_IMPORT_MODES = ["append", "replace"] as const;
export type VideoScriptImportMode = (typeof VIDEO_SCRIPT_IMPORT_MODES)[number];

const scriptPresent = (value: { script?: unknown }) => value.script !== undefined;
const scriptMissingMessage = { message: "Paste or upload a script (the \"script\" field is missing).", path: ["script"] };

/** Body of POST .../video-storylines/:storylineId/import. The script itself is checked by validateVideoStorylineScript for plain per-item messages. */
export const importVideoStorylineScriptSchema = z
  .object({
    mode: z.enum(VIDEO_SCRIPT_IMPORT_MODES).optional().default("append"),
    script: z.unknown(),
    /** true = only check the script and return the summary (scene/shot counts, seconds, estimated cost); nothing is saved. */
    dryRun: z.boolean().optional().default(false),
  })
  .strict()
  .refine(scriptPresent, scriptMissingMessage);
export type ImportVideoStorylineScriptInput = z.infer<typeof importVideoStorylineScriptSchema>;

/** Body of POST .../video-storylines/import: a brand-new storyline built from a script. */
export const createVideoStorylineFromScriptSchema = z
  .object({
    script: z.unknown(),
    /** Overrides the script's own title; one of the two is required. */
    title: z.string().trim().min(1).max(VIDEO_SCRIPT_TITLE_MAX_LENGTH).optional(),
    providerId: z.enum(VIDEO_STORYLINE_PROVIDERS).optional().default("fal"),
    model: z.string().trim().min(1).max(200).nullable().optional().default(null),
    budgetCapCents: z.number().int().min(0).nullable().optional().default(null),
    dryRun: z.boolean().optional().default(false),
  })
  .strict()
  .refine(scriptPresent, scriptMissingMessage);
export type CreateVideoStorylineFromScriptInput = z.infer<typeof createVideoStorylineFromScriptSchema>;

/** What an import (or its dry run) reports back. */
export interface VideoScriptImportSummary {
  dryRun: boolean;
  mode: VideoScriptImportMode | "new";
  storylineId: string | null;
  sceneCount: number;
  shotCount: number;
  totalSeconds: number;
  /** Seconds actually rendered/billed once clip lengths are snapped to what the provider accepts. */
  billedSeconds: number;
  estimatedCostCents: number;
  characterCount: number;
}

export interface VideoScriptShot {
  prompt: string;
  cameraNotes: string | null;
  durationSeconds: number;
  transitionIn: VideoShotTransition | null;
}

export interface VideoScriptScene {
  title: string;
  notes: string | null;
  shots: VideoScriptShot[];
}

export interface VideoScriptCharacter {
  name: string;
  description: string;
}

/** A script that passed validateVideoStorylineScript, in the server's own field names. */
export interface ParsedVideoStorylineScript {
  title: string | null;
  characters: VideoScriptCharacter[];
  scenes: VideoScriptScene[];
  sceneCount: number;
  shotCount: number;
  totalSeconds: number;
}

export type VideoStorylineScriptValidation =
  | { ok: true; script: ParsedVideoStorylineScript }
  | { ok: false; errors: string[] };

const SCRIPT_KEYS = new Set(["title", "characters", "scenes"]);
const SCENE_KEYS = new Set(["scene_title", "scene_notes", "shots"]);
const SHOT_KEYS = new Set(["prompt", "camera_notes", "duration_seconds", "transition_in"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatCount(value: number): string {
  return value.toLocaleString("en-US");
}

function unknownKeys(value: Record<string, unknown>, allowed: Set<string>): string[] {
  return Object.keys(value).filter((key) => !allowed.has(key));
}

/**
 * Checks a script strictly and returns either the cleaned-up script or a
 * list of plain, per-item problems ("Scene 2, shot 3: prompt is longer than
 * 4,000 characters"). Strict on purpose: an unknown field is almost always a
 * typo (e.g. "camera_note"), and silently dropping it would lose what the
 * writer meant.
 */
export function validateVideoStorylineScript(input: unknown): VideoStorylineScriptValidation {
  const errors: string[] = [];
  const add = (message: string) => {
    errors.push(message);
  };

  if (!isPlainObject(input)) {
    return { ok: false, errors: ["The script must be a JSON object with a \"scenes\" list."] };
  }
  for (const key of unknownKeys(input, SCRIPT_KEYS)) {
    add(`Unknown field "${key}" at the top of the script (allowed: title, characters, scenes).`);
  }

  let title: string | null = null;
  if (input.title !== undefined && input.title !== null) {
    if (typeof input.title !== "string") add("title must be text.");
    else if (input.title.trim().length > VIDEO_SCRIPT_TITLE_MAX_LENGTH) {
      add(`title is longer than ${formatCount(VIDEO_SCRIPT_TITLE_MAX_LENGTH)} characters.`);
    } else title = input.title.trim() || null;
  }

  const characters: VideoScriptCharacter[] = [];
  if (input.characters !== undefined && input.characters !== null) {
    if (!isPlainObject(input.characters)) {
      add("characters must be an object of name -> description, e.g. {\"Mia\": \"a woman in her 30s with short red hair\"}.");
    } else {
      const entries = Object.entries(input.characters);
      if (entries.length > VIDEO_SCRIPT_MAX_CHARACTERS) {
        add(`There are ${formatCount(entries.length)} characters; the most allowed is ${formatCount(VIDEO_SCRIPT_MAX_CHARACTERS)}.`);
      }
      for (const [rawName, rawDescription] of entries.slice(0, VIDEO_SCRIPT_MAX_CHARACTERS)) {
        const name = rawName.trim();
        if (!name) {
          add("A character has an empty name.");
          continue;
        }
        if (name.length > VIDEO_SCRIPT_CHARACTER_NAME_MAX_LENGTH) {
          add(`Character "${name.slice(0, 40)}...": the name is longer than ${formatCount(VIDEO_SCRIPT_CHARACTER_NAME_MAX_LENGTH)} characters.`);
          continue;
        }
        if (typeof rawDescription !== "string" || !rawDescription.trim()) {
          add(`Character "${name}": the description must be non-empty text.`);
          continue;
        }
        if (rawDescription.trim().length > VIDEO_SCRIPT_CHARACTER_DESCRIPTION_MAX_LENGTH) {
          add(`Character "${name}": the description is longer than ${formatCount(VIDEO_SCRIPT_CHARACTER_DESCRIPTION_MAX_LENGTH)} characters.`);
          continue;
        }
        characters.push({ name, description: rawDescription.trim() });
      }
    }
  }

  const scenes: VideoScriptScene[] = [];
  let shotCount = 0;
  let totalSeconds = 0;
  if (!Array.isArray(input.scenes)) {
    add("The script needs a \"scenes\" list with at least one scene.");
  } else if (input.scenes.length === 0) {
    add("The \"scenes\" list is empty -- add at least one scene with at least one shot.");
  } else {
    if (input.scenes.length > VIDEO_STORYLINE_MAX_SCENES) {
      add(`The script has ${formatCount(input.scenes.length)} scenes; a storyline can have at most ${formatCount(VIDEO_STORYLINE_MAX_SCENES)}.`);
    }
    input.scenes.forEach((rawScene, sceneIndex) => {
      const where = `Scene ${sceneIndex + 1}`;
      if (!isPlainObject(rawScene)) {
        add(`${where}: must be an object with scene_title and shots.`);
        return;
      }
      for (const key of unknownKeys(rawScene, SCENE_KEYS)) {
        add(`${where}: unknown field "${key}" (allowed: scene_title, scene_notes, shots).`);
      }
      let sceneTitle = "";
      if (rawScene.scene_title === undefined || rawScene.scene_title === null) {
        add(`${where}: scene_title is missing.`);
      } else if (typeof rawScene.scene_title !== "string") {
        add(`${where}: scene_title must be text.`);
      } else if (rawScene.scene_title.trim().length > VIDEO_SCRIPT_SCENE_TITLE_MAX_LENGTH) {
        add(`${where}: scene_title is longer than ${formatCount(VIDEO_SCRIPT_SCENE_TITLE_MAX_LENGTH)} characters.`);
      } else {
        sceneTitle = rawScene.scene_title.trim();
      }
      let sceneNotes: string | null = null;
      if (rawScene.scene_notes !== undefined && rawScene.scene_notes !== null) {
        if (typeof rawScene.scene_notes !== "string") add(`${where}: scene_notes must be text.`);
        else if (rawScene.scene_notes.trim().length > VIDEO_SCRIPT_SCENE_NOTES_MAX_LENGTH) {
          add(`${where}: scene_notes is longer than ${formatCount(VIDEO_SCRIPT_SCENE_NOTES_MAX_LENGTH)} characters.`);
        } else sceneNotes = rawScene.scene_notes.trim() || null;
      }

      const shots: VideoScriptShot[] = [];
      if (!Array.isArray(rawScene.shots) || rawScene.shots.length === 0) {
        add(`${where}: needs a "shots" list with at least one shot.`);
      } else {
        rawScene.shots.forEach((rawShot, shotIndex) => {
          const shotWhere = `${where}, shot ${shotIndex + 1}`;
          if (!isPlainObject(rawShot)) {
            add(`${shotWhere}: must be an object with at least a prompt.`);
            return;
          }
          for (const key of unknownKeys(rawShot, SHOT_KEYS)) {
            add(`${shotWhere}: unknown field "${key}" (allowed: prompt, camera_notes, duration_seconds, transition_in).`);
          }
          let ok = true;
          let prompt = "";
          if (typeof rawShot.prompt !== "string" || !rawShot.prompt.trim()) {
            add(`${shotWhere}: prompt is missing or empty.`);
            ok = false;
          } else if (rawShot.prompt.trim().length > VIDEO_SCRIPT_PROMPT_MAX_LENGTH) {
            add(`${shotWhere}: prompt is longer than ${formatCount(VIDEO_SCRIPT_PROMPT_MAX_LENGTH)} characters.`);
            ok = false;
          } else prompt = rawShot.prompt.trim();

          let cameraNotes: string | null = null;
          if (rawShot.camera_notes !== undefined && rawShot.camera_notes !== null) {
            if (typeof rawShot.camera_notes !== "string") {
              add(`${shotWhere}: camera_notes must be text.`);
              ok = false;
            } else if (rawShot.camera_notes.trim().length > VIDEO_SCRIPT_CAMERA_NOTES_MAX_LENGTH) {
              add(`${shotWhere}: camera_notes is longer than ${formatCount(VIDEO_SCRIPT_CAMERA_NOTES_MAX_LENGTH)} characters.`);
              ok = false;
            } else cameraNotes = rawShot.camera_notes.trim() || null;
          }

          let durationSeconds = VIDEO_SHOT_DEFAULT_DURATION_SECONDS;
          if (rawShot.duration_seconds !== undefined && rawShot.duration_seconds !== null) {
            const value = rawShot.duration_seconds;
            if (typeof value !== "number" || !Number.isInteger(value)) {
              add(`${shotWhere}: duration_seconds must be a whole number of seconds.`);
              ok = false;
            } else if (value < VIDEO_SHOT_MIN_DURATION_SECONDS || value > VIDEO_SHOT_MAX_DURATION_SECONDS) {
              add(`${shotWhere}: duration_seconds must be between ${VIDEO_SHOT_MIN_DURATION_SECONDS} and ${VIDEO_SHOT_MAX_DURATION_SECONDS}.`);
              ok = false;
            } else durationSeconds = value;
          }

          let transitionIn: VideoShotTransition | null = null;
          if (rawShot.transition_in !== undefined && rawShot.transition_in !== null) {
            const value = rawShot.transition_in;
            if (typeof value !== "string" || !(VIDEO_SHOT_TRANSITIONS as readonly string[]).includes(value)) {
              add(`${shotWhere}: transition_in must be one of ${VIDEO_SHOT_TRANSITIONS.join(", ")}.`);
              ok = false;
            } else transitionIn = value as VideoShotTransition;
          }

          if (ok) {
            shots.push({ prompt, cameraNotes, durationSeconds, transitionIn });
            totalSeconds += durationSeconds;
          }
          shotCount += 1;
        });
      }
      scenes.push({ title: sceneTitle, notes: sceneNotes, shots });
    });
    if (shotCount > VIDEO_STORYLINE_MAX_SHOTS) {
      add(`The script has ${formatCount(shotCount)} shots; a storyline can have at most ${formatCount(VIDEO_STORYLINE_MAX_SHOTS)}.`);
    }
  }

  if (errors.length > 0) {
    if (errors.length > VIDEO_SCRIPT_MAX_REPORTED_ERRORS) {
      const extra = errors.length - VIDEO_SCRIPT_MAX_REPORTED_ERRORS;
      return { ok: false, errors: [...errors.slice(0, VIDEO_SCRIPT_MAX_REPORTED_ERRORS), `...and ${formatCount(extra)} more problem(s).`] };
    }
    return { ok: false, errors };
  }
  return {
    ok: true,
    script: { title, characters, scenes, sceneCount: scenes.length, shotCount, totalSeconds },
  };
}

/** The character sheet as plain text, stored at the top of the first imported scene's notes so the director AI and the editor both see it. */
export function formatVideoScriptCharacters(characters: readonly VideoScriptCharacter[]): string | null {
  if (characters.length === 0) return null;
  return ["Characters:", ...characters.map((c) => `- ${c.name}: ${c.description}`)].join("\n");
}

// ─── Script-writer instructions (served by the UI and GET .../script-instructions) ──

export const VIDEO_STORYLINE_SCRIPT_EXAMPLE = {
  title: "The Lighthouse Keeper",
  characters: {
    Ada: "a woman in her 60s with short silver hair, round glasses, a dark green wool coat and a yellow scarf",
    Bo: "a scruffy grey-and-white border collie with a red collar",
  },
  scenes: [
    {
      scene_title: "Storm at dusk",
      scene_notes: "Rocky coast, heavy rain, cold blue light, lighthouse beam sweeping.",
      shots: [
        {
          prompt:
            "Wide shot of a white stone lighthouse on a rocky cliff at dusk in heavy rain, waves crashing below, the lighthouse beam sweeping across dark clouds.",
          camera_notes: "Slow push-in from the sea toward the cliff.",
          duration_seconds: 5,
          transition_in: "fade",
        },
        {
          prompt:
            "Inside the lighthouse lamp room: Ada, a woman in her 60s with short silver hair, round glasses, a dark green wool coat and a yellow scarf, wipes rain off the big brass lens with a cloth. Warm lamp light, rain streaking the windows.",
          camera_notes: "Medium shot, static camera, eye level.",
          duration_seconds: 5,
          transition_in: "cut",
        },
      ],
    },
    {
      scene_title: "The dog finds something",
      shots: [
        {
          prompt:
            "On the wet rocks below the lighthouse, Bo, a scruffy grey-and-white border collie with a red collar, digs at something shiny wedged between two stones while rain falls.",
          camera_notes: "Low angle close-up, handheld feel.",
          duration_seconds: 10,
          transition_in: "dissolve",
        },
      ],
    },
  ],
};

function scriptInstructionsMarkdown(): string {
  return [
    "# Instructions for writing a video storyline script",
    "",
    "You are writing a script for an AI video generator that renders a long video **one short clip (shot) at a time** and joins the clips together. Return the whole script as **one JSON document** in the exact format below.",
    "",
    "## Structure",
    "",
    "- A **storyline** is the whole video. It has an optional `title`, an optional `characters` list and a list of `scenes`.",
    "- A **scene** is one place/moment of the story: `scene_title` (required), `scene_notes` (optional, for the human reader) and a list of `shots`.",
    "- A **shot** is one clip the video model renders: `prompt` (required), `camera_notes` (optional), `duration_seconds` (optional, default 5) and `transition_in` (optional).",
    `- Limits: at most ${formatCount(VIDEO_STORYLINE_MAX_SCENES)} scenes and ${formatCount(VIDEO_STORYLINE_MAX_SHOTS)} shots; a prompt can be up to ${formatCount(VIDEO_SCRIPT_PROMPT_MAX_LENGTH)} characters, camera notes up to ${formatCount(VIDEO_SCRIPT_CAMERA_NOTES_MAX_LENGTH)}, scene notes up to ${formatCount(VIDEO_SCRIPT_SCENE_NOTES_MAX_LENGTH)}.`,
    "",
    "## How to write each shot",
    "",
    "1. **Every shot must stand on its own.** The video model sees ONLY that one shot's prompt -- never the scene, the title, other shots or the character list. Write each prompt as if it were the only thing the model will ever read.",
    "2. **Repeat character descriptions in every shot they appear in.** Do not write \"Ada\" alone -- write \"Ada, a woman in her 60s with short silver hair, round glasses, a dark green wool coat and a yellow scarf\" every time, with the same wording, so she looks the same in every clip. The `characters` list is only a reference sheet for people.",
    "3. **One continuous take, one main action.** A shot is a single unbroken camera take with one clear thing happening. No cuts, montages, flashbacks or \"then later\" inside a shot -- split those into separate shots.",
    "4. **Describe only what can be seen.** Who is in frame, what they look like, what they do, the setting, lighting, weather, time of day and mood. No dialogue, no on-screen text or captions, no thoughts, feelings or backstory the camera cannot show.",
    "5. **Continuity:** each shot starts from the last frame of the previous shot. Keep positions, clothing, lighting and time of day consistent from one shot to the next, and change things gradually. To move to a new place, show it (walking through a door, the camera panning) or start a new scene.",
    "6. **Camera notes** (`camera_notes`) describe framing and movement only: wide/medium/close-up, angle, static, pan, tilt, push-in, tracking, handheld.",
    "",
    "## Durations",
    "",
    `- \`duration_seconds\` is a whole number from ${VIDEO_SHOT_MIN_DURATION_SECONDS} to ${VIDEO_SHOT_MAX_DURATION_SECONDS}; most video models only make 5- or 10-second clips.`,
    `- ${VIDEO_CLIP_LENGTH_NOTE}`,
    "- Keep each shot's action small enough to fit its length: about one simple action per 5 seconds.",
    "",
    "## Transitions",
    "",
    "- `transition_in` is how this shot starts after the previous one: `cut` (hard cut), `fade` or `dissolve`. Leave it out to use the storyline's default (normally `cut`). The first shot of the video never has a transition.",
    "- Use `cut` within a scene, and `fade`/`dissolve` sparingly between scenes or for passing time.",
    "",
    "## Length",
    "",
    "- Total length = the sum of all shot durations. As a guide: a 1-minute video is about 6-12 shots, a 5-minute video about 30-60 shots.",
    "- Cost grows with total seconds, so do not pad the story with filler shots.",
    "",
    "## Output format",
    "",
    "Return **JSON only** -- no explanation, no markdown fences, no comments -- with exactly these fields (no others):",
    "",
    "```",
    "{",
    '  "title": "string (optional)",',
    '  "characters": { "Name": "visual description", ... } (optional),',
    '  "scenes": [',
    "    {",
    '      "scene_title": "string",',
    '      "scene_notes": "string (optional)",',
    '      "shots": [',
    "        {",
    '          "prompt": "string, self-contained, visible things only",',
    '          "camera_notes": "string (optional)",',
    `          "duration_seconds": number (optional, ${VIDEO_SHOT_MIN_DURATION_SECONDS}-${VIDEO_SHOT_MAX_DURATION_SECONDS}, default ${VIDEO_SHOT_DEFAULT_DURATION_SECONDS}),`,
    `          "transition_in": "${VIDEO_SHOT_TRANSITIONS.join('" | "')}" (optional)`,
    "        }",
    "      ]",
    "    }",
    "  ]",
    "}",
    "```",
    "",
    "## Example",
    "",
    "```json",
    JSON.stringify(VIDEO_STORYLINE_SCRIPT_EXAMPLE, null, 2),
    "```",
    "",
  ].join("\n");
}

/** One shared text so the editor's "Script-writer instructions" button and GET .../video-storylines/script-instructions always say the same thing. */
export const VIDEO_STORYLINE_SCRIPT_INSTRUCTIONS: string = scriptInstructionsMarkdown();
