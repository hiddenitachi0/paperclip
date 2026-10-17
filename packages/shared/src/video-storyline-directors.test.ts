import { describe, expect, it } from "vitest";
import {
  VIDEO_DIRECTOR_STARTERS,
  createVideoStorylineDirectorSchema,
  extractVideoWriterJson,
  parseVideoWriterReply,
  savedModelToolSupport,
  videoWriterContractText,
} from "./video-storyline-directors.js";

const shot = (prompt: string, extra: Record<string, unknown> = {}) => ({ prompt, duration_seconds: 5, ...extra });

describe("the writer's answer", () => {
  it("reads a storyboard from a fenced reply, keeps the cast per shot and the music, and drops the extras before the import's checks", () => {
    const text = [
      "Sure, here it is:",
      "```json",
      JSON.stringify({
        type: "storyboard",
        note: "Calm film.",
        storyboard: {
          title: "T",
          music: "piano",
          voice: "a calm narrator",
          scenes: [{ scene_title: "One", shots: [shot("A", { cast: ["Ada", "Ada", " Bo "] }), shot("B")] }],
        },
      }),
      "```",
    ].join("\n");
    const result = parseVideoWriterReply(text, { allowed: ["questions", "storyboard"], shotCount: 0 });
    expect(result.ok).toBe(true);
    if (!result.ok || result.reply.type !== "storyboard") throw new Error("expected a storyboard");
    expect(result.reply.script.shotCount).toBe(2);
    expect(result.reply.shotCast).toEqual([["Ada", "Bo"], []]);
    expect(result.reply.music).toBe("piano");
    expect(result.reply.voice).toBe("a calm narrator");
    expect(result.reply.rawScript).not.toHaveProperty("music");
  });

  it("takes the import's own bare shape as a storyboard", () => {
    const result = parseVideoWriterReply({ scenes: [{ scene_title: "S", shots: [shot("A")] }] }, { allowed: ["storyboard"], shotCount: 0 });
    expect(result.ok).toBe(true);
  });

  it("lists plain problems for a broken storyboard (for the repair prompt)", () => {
    const result = parseVideoWriterReply({ type: "storyboard", storyboard: { scenes: [{ scene_title: "S", shots: [{ duration_seconds: 99 }] }] } }, { allowed: ["storyboard"], shotCount: 0 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.join(" ")).toMatch(/prompt is missing/);
    expect(result.errors.join(" ")).toMatch(/duration_seconds/);
  });

  it("refuses a type that is not allowed this turn, and text with no JSON", () => {
    expect(parseVideoWriterReply({ type: "questions", questions: [{ question: "Q?" }] }, { allowed: ["storyboard"], shotCount: 0 }).ok).toBe(false);
    expect(parseVideoWriterReply("I will write it now!", { allowed: ["storyboard"], shotCount: 0 }).ok).toBe(false);
  });

  it("keeps at most 3 questions with up to 4 options each", () => {
    const result = parseVideoWriterReply(
      { type: "questions", questions: [{ question: "1?", options: ["a", "b", "c", "d", "e"] }, "2?", { question: "3?" }, { question: "4?" }] },
      { allowed: ["questions", "storyboard"], shotCount: 0 },
    );
    expect(result.ok).toBe(true);
    if (!result.ok || result.reply.type !== "questions") throw new Error("expected questions");
    expect(result.reply.questions).toHaveLength(3);
    expect(result.reply.questions[0]!.options).toHaveLength(4);
    expect(result.reply.questions[1]!.question).toBe("2?");
  });

  it("checks changes against the current shot numbers and refuses two changes to one shot", () => {
    const ok = parseVideoWriterReply(
      { type: "changes", changes: [{ op: "update", shot: 2, prompt: "New" }, { op: "add", after_shot: 0, prompt: "First", duration_seconds: 5 }, { op: "remove", shot: 3 }] },
      { allowed: ["changes"], shotCount: 3 },
    );
    expect(ok.ok).toBe(true);
    const bad = parseVideoWriterReply(
      { type: "changes", changes: [{ op: "update", shot: 4, prompt: "x" }, { op: "remove", shot: 1 }, { op: "update", shot: 1, prompt: "y" }, { op: "update", shot: 2 }] },
      { allowed: ["changes"], shotCount: 3 },
    );
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.errors.join(" ")).toMatch(/from 1 to 3/);
    expect(bad.errors.join(" ")).toMatch(/more than once/);
    expect(bad.errors.join(" ")).toMatch(/at least one of/);
  });

  it("finds the JSON object in surrounding prose", () => {
    expect(extractVideoWriterJson('Here: {"a": 1} hope that helps')).toEqual({ a: 1 });
    expect(extractVideoWriterJson("nothing here")).toBeNull();
  });

  it("describes the contract for the allowed shapes only", () => {
    const text = videoWriterContractText(["changes"]);
    expect(text).toContain('"type": "changes"');
    expect(text).not.toContain('"type": "questions"');
  });
});

describe("tool support of a saved model", () => {
  it("OpenRouter: decided by the hosts allowed to run it (the company's blocked hosts included)", () => {
    const entry = { provider: "openrouter", model: "org/model", specs: { openrouterHostsSeen: [{ slug: "a", tools: false }, { slug: "b", tools: true }] } };
    expect(savedModelToolSupport(entry).canUseTools).toBe(true);
    expect(savedModelToolSupport(entry, ["b"]).canUseTools).toBe(false);
    expect(savedModelToolSupport({ ...entry, providerRouting: { only: ["a"] } }).canUseTools).toBe(false);
  });

  it("uses the model's own Tools fact, and treats an unknown local model as one that can't", () => {
    expect(savedModelToolSupport({ provider: "local", model: "mystery:7b", specs: { tools: "yes" } }).canUseTools).toBe(true);
    expect(savedModelToolSupport({ provider: "openai", model: "gpt-x", specs: { tools: "no" } }).canUseTools).toBe(false);
    expect(savedModelToolSupport({ provider: "local", model: "mystery:7b" })).toMatchObject({ canUseTools: false, source: "unknown" });
    expect(savedModelToolSupport({ provider: "anthropic", model: "claude-sonnet-5" }).canUseTools).toBe(true);
  });
});

describe("directors", () => {
  it("ships the tutorial and action starters", () => {
    expect(VIDEO_DIRECTOR_STARTERS.map((s) => s.name)).toEqual(["Tutorial / explainer", "Action movie"]);
  });

  it("fills defaults on create and refuses unknown fields", () => {
    const parsed = createVideoStorylineDirectorSchema.parse({ name: " Noir " });
    expect(parsed).toMatchObject({ name: "Noir", writingEntryId: null, thinking: null, defaultShotSeconds: null });
    expect(createVideoStorylineDirectorSchema.safeParse({ name: "X", model: "y" }).success).toBe(false);
    expect(createVideoStorylineDirectorSchema.safeParse({ name: "X", defaultShotSeconds: 90 }).success).toBe(false);
  });
});
