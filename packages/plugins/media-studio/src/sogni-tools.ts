// Media Studio's Sogni tools: one agent tool per Sogni tool, each built from
// Sogni's own published argument schema (sogni-schemas.ts). Sogni's argument
// names and descriptions are kept; what Paperclip cannot offer is left out
// (picture addresses, "which earlier result" indices, several variations);
// and the picture to work on is a Paperclip file id instead, uploaded to
// Sogni's own storage by the worker so no Paperclip address leaves the box.
//
// Picture tools run as a one-step Sogni creative workflow
// (POST /v1/creative-agent/workflows, poll, download). enhance_prompt is a
// synchronous Sogni tool and runs on POST /v1/creative-agent/tools/execute.

import { checkJsonSchema, type JsonSchema } from "./json-schema-check.js";
import { sogniToolNames, sogniToolSchema } from "./sogni-schemas.js";

export type SogniToolKind = "picture" | "text";

export interface SogniToolDef {
  /** The Paperclip tool name (namespaced by the host as paperclip.media-studio:<name>). */
  name: string;
  /** Sogni's tool name, as in its schemas and tool-names.json. */
  sogniTool: string;
  /** What the operator sees on the Tools tab. */
  displayName: string;
  /** Plain first sentence(s) for the agent and the operator. */
  summary: string;
  kind: SogniToolKind;
  /** Sogni arguments not offered to agents, besides the address/index ones every tool drops. */
  hide?: string[];
  /** Arguments Paperclip always sends (not offered to agents). */
  fixed?: Record<string, unknown>;
  /** Descriptions for arguments Sogni's schema leaves undescribed (from Sogni's tool description); Sogni's own always win. */
  describe?: Record<string, string>;
  /** Arguments Sogni requires that Paperclip fills when left out, with the sentence added to their description. */
  filled?: Record<string, string>;
  /** Start of the stored file's name. */
  filenamePrefix: string;
  /** The word for what comes back, in sentences ("bigger picture", "cut-out"). */
  resultNoun: string;
}

/** The Paperclip arguments every picture tool takes. */
export const PAPERCLIP_FILE_ARG = "fileId";
export const PAPERCLIP_ISSUE_ARG = "issueId";

const FILE_ID_DESCRIPTION =
  "The picture to work on: its file id in this company's Files (a picture attached to one of the company's tasks works too). A picture made earlier in this chat reports its file id.";
const ISSUE_ID_DESCRIPTION =
  "Optional. The task to attach the new picture to; only use a task the person named or that is assigned to you. Leave it out to save the picture to the company's Files without a task.";

const PICTURE_TAIL =
  " The new picture is saved to the company's Files (or attached to the task given as issueId) and shown in the chat; the original is not changed." +
  " Needs the Sogni key in Media Studio settings. Counts toward the agent's daily picture limit.";

export const SOGNI_TOOLS: readonly SogniToolDef[] = [
  {
    name: "sogni-upscale-image",
    sogniTool: "upscale_image",
    displayName: "Upscale picture (Sogni)",
    summary:
      "Make a picture bigger with Sogni without changing what is in it: 2, 3 or 4 times the size, or a set longest side (3840 for 4K, 7680 for 8K, up to 15360). It does not repaint or fix anything; use Restore photo for that.",
    kind: "picture",
    filenamePrefix: "upscaled",
    resultNoun: "bigger picture",
  },
  {
    name: "sogni-remove-background",
    sogniTool: "remove_background",
    displayName: "Remove background (Sogni)",
    summary:
      "Cut out the main subject of a picture with Sogni and make the background transparent (a PNG), without repainting it. Set applyMask to false to get the soft black-and-white mask instead.",
    kind: "picture",
    filenamePrefix: "no-background",
    resultNoun: "cut-out",
  },
  {
    name: "sogni-restore-photo",
    sogniTool: "restore_photo",
    displayName: "Restore photo (Sogni)",
    summary:
      "Repair or change an existing photo with Sogni from a written instruction: remove scratches, stains and noise, colourise an old photo, remove an object, change text, or transform it while keeping the people recognisable.",
    kind: "picture",
    filenamePrefix: "restored",
    resultNoun: "restored photo",
  },
  {
    name: "sogni-change-angle",
    sogniTool: "change_angle",
    displayName: "Change camera angle (Sogni)",
    summary:
      "Make a new view of a picture's subject from another camera angle with Sogni, for example from the left side, from above, or closer.",
    kind: "picture",
    filenamePrefix: "new-angle",
    resultNoun: "new view",
  },
  {
    name: "sogni-apply-style",
    sogniTool: "apply_style",
    displayName: "Apply style (Sogni)",
    summary:
      "Redo a picture in another style with Sogni (an era, a painting style, a known artist or franchise) while keeping its subject, pose and composition. One style per call.",
    kind: "picture",
    filenamePrefix: "styled",
    resultNoun: "restyled picture",
  },
  {
    name: "sogni-segment-image",
    sogniTool: "segment_image",
    displayName: "Select objects (Sogni)",
    summary:
      "Select objects in a picture with Sogni and get a black-and-white mask of them, or with applyMask true the objects cut out on a transparent background. Say what to select with text (\"the red suitcase\"), with points, or with boxes (positions from 0 to 1 across and down the picture).",
    kind: "picture",
    // One picture comes back per call: Sogni's several-candidates option is off.
    hide: ["multimask"],
    fixed: { multimask: false },
    // Sogni's segment_image schema gives these no description; this is its tool description's rule, per argument.
    describe: {
      points:
        "Points on the picture: label positive on what to select, negative on what to leave out. x and y run from 0 to 1 across and down the original picture. Points can go with at most one box, never with text.",
      boxes:
        "Boxes around what to select: x0,y0 is the top-left corner and x1,y1 the bottom-right, each from 0 to 1 across and down the original picture. A box labelled negative leaves an area out and needs text.",
    },
    filenamePrefix: "selection",
    resultNoun: "selection",
  },
  {
    name: "sogni-enhance-prompt",
    sogniTool: "enhance_prompt",
    displayName: "Improve picture prompt (Sogni)",
    summary:
      "Turn a rough picture idea into a detailed prompt written for one specific Sogni model, to use with Generate image. Returns text only: no picture is made and it does not count toward the daily picture limit. Needs the Sogni key in Media Studio settings.",
    kind: "text",
    // Deprecated in Sogni's schema ("never selects or overrides"), and assets carry addresses.
    hide: ["prompting_type", "model_title", "assets"],
    filled: {
      target_output: 'Optional here: leave it out for "image_prompt".',
      destination_model: "Optional here: leave it out to use the Sogni model from Media Studio settings.",
    },
    filenamePrefix: "prompt",
    resultNoun: "prompt",
  },
];

/** Sogni arguments no agent is offered: picture addresses, earlier-result indices, several variations. */
function isAddressOrIndexArg(name: string): boolean {
  return /(^|_)url$|Url$|Index$|Indices$/.test(name) || name === "numberOfVariations";
}

export function findSogniTool(name: string): SogniToolDef | undefined {
  return SOGNI_TOOLS.find((def) => def.name === name);
}

/** The Sogni arguments an agent may pass for this tool (from the vendored schema). */
export function offeredSogniArgs(def: SogniToolDef): string[] {
  const schema = sogniToolSchema(def.sogniTool);
  const properties = (schema.properties ?? {}) as Record<string, JsonSchema>;
  return Object.keys(properties).filter((name) => !isAddressOrIndexArg(name) && !def.hide?.includes(name) && !(name in (def.fixed ?? {})));
}

/**
 * The tool's parametersSchema, built from Sogni's vendored schema: Sogni's
 * own names and descriptions for what is kept, plus fileId (picture tools)
 * and issueId. No other names are accepted.
 */
const parametersCache = new Map<string, JsonSchema>();

export function sogniToolParameters(def: SogniToolDef): JsonSchema {
  const cached = parametersCache.get(def.name);
  if (cached) return structuredClone(cached);
  const built = buildParameters(def);
  parametersCache.set(def.name, built);
  return structuredClone(built);
}

function buildParameters(def: SogniToolDef): JsonSchema {
  const schema = sogniToolSchema(def.sogniTool);
  if (!sogniToolNames().hosted.includes(def.sogniTool)) {
    throw new Error(`${def.sogniTool} is not one of Sogni's hosted tools in the vendored tool-names.json.`);
  }
  const sogniProperties = (schema.properties ?? {}) as Record<string, JsonSchema>;
  const offered = offeredSogniArgs(def);
  for (const name of [PAPERCLIP_FILE_ARG, PAPERCLIP_ISSUE_ARG]) {
    if (name in sogniProperties) throw new Error(`Sogni's ${def.sogniTool} now has its own "${name}" argument; Media Studio's needs renaming.`);
  }
  const properties: Record<string, JsonSchema> = {};
  if (def.kind === "picture") properties[PAPERCLIP_FILE_ARG] = { type: "string", description: FILE_ID_DESCRIPTION };
  for (const name of offered) {
    const copy = structuredClone(sogniProperties[name]!);
    if (typeof copy.description !== "string" && def.describe?.[name]) copy.description = def.describe[name];
    const note = def.filled?.[name];
    if (note) copy.description = `${typeof copy.description === "string" ? `${copy.description} ` : ""}${note}`;
    properties[name] = copy;
  }
  if (def.kind === "picture") properties[PAPERCLIP_ISSUE_ARG] = { type: "string", description: ISSUE_ID_DESCRIPTION };
  const sogniRequired = Array.isArray(schema.required) ? (schema.required as string[]) : [];
  const required = [
    ...(def.kind === "picture" ? [PAPERCLIP_FILE_ARG] : []),
    ...sogniRequired.filter((name) => offered.includes(name) && !def.filled?.[name]),
  ];
  return { type: "object", additionalProperties: false, properties, required };
}

/** The tool's description: the plain summary, and for picture tools where the result goes. */
export function sogniToolDescription(def: SogniToolDef): string {
  return def.kind === "picture" ? `${def.summary}${PICTURE_TAIL}` : def.summary;
}

/** The manifest's tool entries for every Sogni tool. */
export function sogniToolDeclarations(): Array<{ name: string; displayName: string; description: string; parametersSchema: Record<string, unknown> }> {
  return SOGNI_TOOLS.map((def) => ({
    name: def.name,
    displayName: def.displayName,
    description: sogniToolDescription(def),
    parametersSchema: sogniToolParameters(def),
  }));
}

export interface PreparedSogniCall {
  /** Exactly what goes in the Sogni step's (or tools/execute's) `arguments`. */
  arguments: Record<string, unknown>;
  /** Picture tools: the Paperclip file to send. */
  fileId: string | null;
  issueId: string | null;
}

/**
 * Check an agent's arguments and turn them into Sogni's. First against the
 * tool's parametersSchema (so an unknown name, a wrong type or a value out of
 * range is refused with a plain sentence), then Sogni's own rules the schema
 * only states in words, and last the finished arguments against Sogni's
 * vendored schema exactly as published.
 */
export function prepareSogniCall(
  def: SogniToolDef,
  params: unknown,
  settings: { defaultModel: string },
): PreparedSogniCall | { error: string } {
  const record = params === undefined || params === null ? {} : params;
  const parameters = sogniToolParameters(def);
  const allowed = Object.keys((parameters.properties ?? {}) as Record<string, unknown>);
  const problem = checkJsonSchema(parameters, record, "", (key) =>
    `The ${def.displayName} tool does not take "${key}". It takes: ${allowed.join(", ")}.`,
  );
  if (problem) return { error: problem };
  const input = record as Record<string, unknown>;

  let fileId: string | null = null;
  if (def.kind === "picture") {
    fileId = String(input[PAPERCLIP_FILE_ARG]).trim();
    if (!fileId) return { error: "fileId must be the file id of a picture in this company's Files." };
  }
  const issueRaw = input[PAPERCLIP_ISSUE_ARG];
  const issueId = typeof issueRaw === "string" && issueRaw.trim() ? issueRaw.trim() : null;

  const args: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (key === PAPERCLIP_FILE_ARG || key === PAPERCLIP_ISSUE_ARG) continue;
    args[key] = value;
  }
  const sogniSchema = sogniToolSchema(def.sogniTool);
  const sogniProperties = (sogniSchema.properties ?? {}) as Record<string, unknown>;
  // The uploaded picture is the first (and only) request picture: index -1.
  if (def.kind === "picture" && "sourceImageIndex" in sogniProperties) args.sourceImageIndex = -1;
  Object.assign(args, def.fixed ?? {});
  if (def.sogniTool === "enhance_prompt") {
    if (args.target_output === undefined) args.target_output = "image_prompt";
    if (args.destination_model === undefined) args.destination_model = settings.defaultModel;
  }

  const rule = sogniRules(def.sogniTool, args);
  if (rule) return { error: rule };

  const final = checkJsonSchema(sogniSchema, args, "", (key) =>
    `Sogni's ${def.sogniTool} does not take "${key}", so the call was not sent.`,
  );
  if (final) return { error: final };
  return { arguments: args, fileId, issueId };
}

/** Rules Sogni's schemas state in their descriptions rather than in the schema itself. */
function sogniRules(tool: string, args: Record<string, unknown>): string | null {
  if (tool === "change_angle" && typeof args.loraStrength === "number" && (args.loraStrength < 0.1 || args.loraStrength > 1)) {
    return "loraStrength must be from 0.1 to 1.0.";
  }
  if (tool === "segment_image") {
    const text = typeof args.text === "string" ? args.text : "";
    const points = Array.isArray(args.points) ? (args.points as Array<Record<string, unknown>>) : [];
    const boxes = Array.isArray(args.boxes) ? (args.boxes as Array<Record<string, unknown>>) : [];
    if (!text && points.length === 0 && boxes.length === 0) {
      return "Say what to select: text (such as \"the red suitcase\"), a positive point, or a box.";
    }
    if (points.length > 0 && text) return "Points cannot be combined with text. Use text (with boxes if needed), or points (with at most one box).";
    if (points.length > 0 && boxes.length > 1) return "Points can be combined with at most one box.";
    if (points.length > 0 && boxes.length === 0 && !points.some((p) => p.label === "positive")) {
      return "Add at least one positive point (a point on the object to select).";
    }
    if (!text && boxes.some((b) => b.label === "negative")) return "A negative box needs text saying what to select.";
  }
  return null;
}
