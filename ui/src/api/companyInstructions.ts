import { api } from "./client";

// COMPANY.md: the standing-rules box every agent in this company gets
// prepended ahead of its own AGENTS.md on every run. Mirrors
// server/src/services/company-instructions.ts's CompanyInstructionsFile shape.
export type CompanyInstructionsFile = {
  path: string;
  content: string;
  exists: boolean;
  size: number;
};

export const companyInstructionsApi = {
  get: (companyId: string) =>
    api.get<CompanyInstructionsFile>(`/companies/${companyId}/instructions`),
  update: (companyId: string, content: string) =>
    api.put<CompanyInstructionsFile>(`/companies/${companyId}/instructions`, { content }),
  remove: (companyId: string) =>
    api.delete<void>(`/companies/${companyId}/instructions`),
};
