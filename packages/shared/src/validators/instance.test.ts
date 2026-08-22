import { describe, expect, it } from "vitest";
import {
  instanceExperimentalSettingsSchema,
  instanceGeneralSettingsSchema,
  patchInstanceExperimentalSettingsSchema,
  patchInstanceGeneralSettingsSchema,
} from "./instance.js";
import { DEFAULT_INSTRUCTIONS_STALENESS_THRESHOLD_DAYS } from "../types/instance.js";

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
