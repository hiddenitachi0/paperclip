import { describe, expect, it } from "vitest";
import { QUALITY_DONE_EVIDENCE_MODES, updateCompanyQualityLoopSettingsSchema } from "./quality-loops.js";

describe("updateCompanyQualityLoopSettingsSchema: doneEvidenceMode (DUR-5179)", () => {
  it("accepts exactly off, report and enforce", () => {
    expect([...QUALITY_DONE_EVIDENCE_MODES]).toEqual(["off", "report", "enforce"]);
    for (const mode of QUALITY_DONE_EVIDENCE_MODES) {
      expect(updateCompanyQualityLoopSettingsSchema.parse({ doneEvidenceMode: mode })).toEqual({ doneEvidenceMode: mode });
    }
  });

  it("rejects anything else, including a wrong case, a boolean and null", () => {
    for (const bad of ["ENFORCE", "on", "strict", "", true, null, 1]) {
      expect(updateCompanyQualityLoopSettingsSchema.safeParse({ doneEvidenceMode: bad }).success).toBe(false);
    }
  });

  it("is optional, so a patch that leaves it out keeps the stored value", () => {
    expect(updateCompanyQualityLoopSettingsSchema.parse({ selfReviewPasses: 1 })).toEqual({ selfReviewPasses: 1 });
  });

  it("still refuses unknown fields", () => {
    expect(updateCompanyQualityLoopSettingsSchema.safeParse({ doneEvidenceModes: "enforce" }).success).toBe(false);
  });
});
