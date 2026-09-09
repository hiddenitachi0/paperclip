import { api } from "./client";

// DUR-134: one row per platform account a persona publishes to, plus the
// posts that went (or are about to go) through it. Everything here is
// board-only on the server (server/src/routes/persona-accounts.ts) except
// enqueueing a post, which the persona's own agent does for itself.
export type PersonaAccountPlatform = "fanvue";
export type PersonaAccountAutonomyMode = "autonomous" | "requires_approval";
export type PersonaPostStatus =
  | "queued"
  | "pending_approval"
  | "approved"
  | "publishing"
  | "published"
  | "failed"
  | "rejected"
  | "cancelled";

export interface PersonaAccount {
  id: string;
  companyId: string;
  personaId: string;
  platform: PersonaAccountPlatform | string;
  accountLabel: string;
  externalAccountId: string;
  connectionStatus: string;
  aiDisclosureEnabled: boolean;
  autonomyMode: PersonaAccountAutonomyMode | string;
  dailyPostCap: number;
  warmupPostsRequired: number;
  publishedPostCount: number;
  publishingPaused: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreatePersonaAccountInput {
  platform: PersonaAccountPlatform;
  accountLabel: string;
  externalAccountId: string;
  aiDisclosureEnabled: boolean;
  autonomyMode: PersonaAccountAutonomyMode;
  dailyPostCap: number;
  warmupPostsRequired?: number;
}

export interface UpdatePersonaAccountInput {
  accountLabel?: string;
  aiDisclosureEnabled?: boolean;
  autonomyMode?: PersonaAccountAutonomyMode;
  dailyPostCap?: number;
  publishingPaused?: boolean;
}

export interface PersonaPost {
  id: string;
  companyId: string;
  personaId: string;
  personaAccountId: string;
  status: PersonaPostStatus | string;
  caption: string;
  disclosureText: string | null;
  mediaAssetId: string | null;
  approvalId: string | null;
  externalPostId: string | null;
  publishAttemptedAt: string | null;
  publishedAt: string | null;
  failureReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PersonaPublishingCompanySettings {
  companyId: string;
  publishingPaused: boolean;
  pausedAt?: string | null;
}

export const personaAccountsApi = {
  listForPersona: (personaId: string) =>
    api.get<PersonaAccount[]>(`/personas/${personaId}/persona-accounts`),
  create: (personaId: string, data: CreatePersonaAccountInput) =>
    api.post<PersonaAccount>(`/personas/${personaId}/persona-accounts`, data),
  update: (accountId: string, data: UpdatePersonaAccountInput) =>
    api.patch<PersonaAccount>(`/persona-accounts/${accountId}`, data),
  remove: (accountId: string) => api.delete<void>(`/persona-accounts/${accountId}`),
  connectCredential: (accountId: string, secretId: string) =>
    api.post<void>(`/persona-accounts/${accountId}/credential`, { secretId }),
  listCompanyPosts: (companyId: string) =>
    api.get<PersonaPost[]>(`/companies/${companyId}/persona-posts`),
  getCompanySettings: (companyId: string) =>
    api.get<PersonaPublishingCompanySettings>(`/companies/${companyId}/persona-publishing-settings`),
  setCompanyPaused: (companyId: string, publishingPaused: boolean) =>
    api.patch<PersonaPublishingCompanySettings>(`/companies/${companyId}/persona-publishing-settings`, {
      publishingPaused,
    }),
};
