import { describe, expect, it } from "vitest";
import type { Company } from "@paperclipai/shared";
import { resolveBareUrlTargetCompany } from "./bare-url-redirect";

function makeCompany(id: string, issuePrefix: string): Company {
  return {
    id,
    name: issuePrefix,
    description: null,
    status: "active",
    pauseReason: null,
    pausedAt: null,
    issuePrefix,
    issueCounter: 1,
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    attachmentMaxBytes: 10 * 1024 * 1024,
    requireBoardApprovalForNewAgents: false,
    feedbackDataSharingEnabled: false,
    feedbackDataSharingConsentAt: null,
    feedbackDataSharingConsentByUserId: null,
    feedbackDataSharingTermsVersion: null,
    brandColor: null,
    logoAssetId: null,
    logoUrl: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

describe("resolveBareUrlTargetCompany", () => {
  const dur = makeCompany("company-dur", "DUR");
  const nor = makeCompany("company-nor", "NOR");
  const companies = [nor, dur];

  // DUR-3933: a bare /skills or /jobs URL must resolve to the board the
  // operator was actually last on, not a stale globally-selected company.
  it("prefers the last-visited board over a stale selectedCompany", () => {
    expect(resolveBareUrlTargetCompany(companies, nor, "DUR")).toBe(dur);
  });

  it("falls back to selectedCompany when there is no board history", () => {
    expect(resolveBareUrlTargetCompany(companies, nor, null)).toBe(nor);
  });

  it("falls back to the first company when there is neither board history nor a selection", () => {
    expect(resolveBareUrlTargetCompany(companies, null, null)).toBe(nor);
  });

  it("ignores a last-visited prefix that no longer matches any known company", () => {
    expect(resolveBareUrlTargetCompany(companies, nor, "GONE")).toBe(nor);
  });

  it("matches the last-visited prefix case-insensitively", () => {
    expect(resolveBareUrlTargetCompany(companies, nor, "dur")).toBe(dur);
  });

  it("returns null when there are no companies at all", () => {
    expect(resolveBareUrlTargetCompany([], null, null)).toBeNull();
  });
});
