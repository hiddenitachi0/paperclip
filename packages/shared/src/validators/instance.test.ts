import { describe, expect, it } from "vitest";
import {
  instanceExperimentalSettingsSchema,
  instanceGeneralSettingsSchema,
  patchInstanceExperimentalSettingsSchema,
  patchInstanceGeneralSettingsSchema,
} from "./instance.js";
import {
  DEFAULT_INSTRUCTIONS_STALENESS_THRESHOLD_DAYS,
  DEFAULT_NEEDS_YOU_STALLED_AFTER_HOURS,
  DEFAULT_AGENT_CARD_EXPIRES_AFTER_HOURS,
} from "../types/instance.js";

describe("instance experimental settings validators", () => {
  it("defaults the server info debug view off", () => {
    const settings = instanceExperimentalSettingsSchema.parse({});

    expect(settings.enableServerInfoDebugView).toBe(false);
  });

  it("accepts server info debug view patches", () => {
    expect(
      patchInstanceExperimentalSettingsSchema.parse({
        enableServerInfoDebugView: true,
      }),
    ).toEqual({
      enableServerInfoDebugView: true,
    });
  });
});

// DUR-69/DUR-109: "one number for the whole instance, changeable later"
// (WHAT TO BUILD item 5) — this is that one configurable threshold.
describe("instructionsStalenessThresholdDays", () => {
  it("defaults to 60 days", () => {
    const settings = instanceGeneralSettingsSchema.parse({});
    expect(settings.instructionsStalenessThresholdDays).toBe(60);
    expect(DEFAULT_INSTRUCTIONS_STALENESS_THRESHOLD_DAYS).toBe(60);
  });

  it("accepts a patch overriding the threshold", () => {
    expect(
      patchInstanceGeneralSettingsSchema.parse({ instructionsStalenessThresholdDays: 30 }),
    ).toEqual({ instructionsStalenessThresholdDays: 30 });
  });

  it("rejects a non-positive threshold", () => {
    expect(() => instanceGeneralSettingsSchema.parse({ instructionsStalenessThresholdDays: 0 })).toThrow();
  });

  it("rejects a non-integer threshold", () => {
    expect(() => instanceGeneralSettingsSchema.parse({ instructionsStalenessThresholdDays: 60.5 })).toThrow();
  });
});

// The time-based half of the Now page's "nobody is moving this" source.
describe("agentCardExpiresAfterHours (close unanswered agent cards after)", () => {
  it("defaults to 24 hours", () => {
    const settings = instanceGeneralSettingsSchema.parse({});
    expect(settings.agentCardExpiresAfterHours).toBe(24);
    expect(DEFAULT_AGENT_CARD_EXPIRES_AFTER_HOURS).toBe(24);
  });

  it("accepts a patch overriding the agent default", () => {
    expect(
      patchInstanceGeneralSettingsSchema.parse({ agentCardExpiresAfterHours: 48 }),
    ).toEqual({ agentCardExpiresAfterHours: 48 });
  });

  it("rejects 0 (there is no 'close at once'; 'never' is per card via neverExpires)", () => {
    expect(() => instanceGeneralSettingsSchema.parse({ agentCardExpiresAfterHours: 0 })).toThrow();
  });

  it("rejects a non-integer number of hours", () => {
    expect(() => instanceGeneralSettingsSchema.parse({ agentCardExpiresAfterHours: 1.5 })).toThrow();
  });
});

describe("needsYouStalledAfterHours", () => {
  it("defaults to 12 hours", () => {
    const settings = instanceGeneralSettingsSchema.parse({});
    expect(settings.needsYouStalledAfterHours).toBe(12);
    expect(DEFAULT_NEEDS_YOU_STALLED_AFTER_HOURS).toBe(12);
  });

  it("accepts a patch overriding the threshold", () => {
    expect(
      patchInstanceGeneralSettingsSchema.parse({ needsYouStalledAfterHours: 48 }),
    ).toEqual({ needsYouStalledAfterHours: 48 });
  });

  it("rejects a non-positive threshold", () => {
    expect(() => instanceGeneralSettingsSchema.parse({ needsYouStalledAfterHours: 0 })).toThrow();
  });

  it("rejects a non-integer threshold", () => {
    expect(() => instanceGeneralSettingsSchema.parse({ needsYouStalledAfterHours: 12.5 })).toThrow();
  });
});
