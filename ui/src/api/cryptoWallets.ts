import type {
  CompanyCryptoSettings,
  CreateCryptoWalletInput,
  CryptoAgentLimits,
  CryptoSendRequest,
  CryptoWalletBalance,
  CryptoWalletDestination,
  CryptoWalletSummary,
  CryptoWalletTransactionSummary,
  UpdateCompanyCryptoSettingsInput,
  UpdateCryptoWalletInput,
} from "@paperclipai/shared";
import { api } from "./client";

// Crypto wallets for agents: the owner/admin screens. The server never
// returns a private key or the secret's id; the import form's key is sent
// once, in the create request, and never comes back.

const base = (companyId: string) => `/companies/${companyId}/crypto`;

export const cryptoWalletsApi = {
  settings: (companyId: string) => api.get<CompanyCryptoSettings>(`${base(companyId)}/settings`),
  updateSettings: (companyId: string, input: UpdateCompanyCryptoSettingsInput) =>
    api.patch<CompanyCryptoSettings>(`${base(companyId)}/settings`, input),
  list: (companyId: string, agentId?: string) =>
    api.get<CryptoWalletSummary[]>(`${base(companyId)}/wallets${agentId ? `?agentId=${encodeURIComponent(agentId)}` : ""}`),
  create: (companyId: string, input: CreateCryptoWalletInput) => api.post<CryptoWalletSummary>(`${base(companyId)}/wallets`, input),
  update: (companyId: string, walletId: string, input: UpdateCryptoWalletInput) =>
    api.patch<CryptoWalletSummary>(`${base(companyId)}/wallets/${walletId}`, input),
  setFrozen: (companyId: string, walletId: string, frozen: boolean, reason?: string) =>
    api.post<CryptoWalletSummary>(`${base(companyId)}/wallets/${walletId}/freeze`, { frozen, ...(reason ? { reason } : {}) }),
  archive: (companyId: string, walletId: string) => api.post<CryptoWalletSummary>(`${base(companyId)}/wallets/${walletId}/archive`, {}),
  balance: (companyId: string, walletId: string) => api.get<CryptoWalletBalance>(`${base(companyId)}/wallets/${walletId}/balance`),
  destinations: (companyId: string, walletId: string) =>
    api.get<CryptoWalletDestination[]>(`${base(companyId)}/wallets/${walletId}/destinations`),
  addDestination: (companyId: string, walletId: string, input: { address: string; label: string }) =>
    api.post<CryptoWalletDestination>(`${base(companyId)}/wallets/${walletId}/destinations`, input),
  removeDestination: (companyId: string, walletId: string, destinationId: string) =>
    api.delete<void>(`${base(companyId)}/wallets/${walletId}/destinations/${destinationId}`),
  transactions: (companyId: string, walletId: string) =>
    api.get<CryptoWalletTransactionSummary[]>(`${base(companyId)}/wallets/${walletId}/transactions`),
  send: (companyId: string, walletId: string, input: CryptoSendRequest) =>
    api.post<CryptoWalletTransactionSummary>(`${base(companyId)}/wallets/${walletId}/send`, input),
  agentLimits: (companyId: string, agentId: string) => api.get<CryptoAgentLimits>(`${base(companyId)}/agents/${agentId}/limits`),
  setAgentLimits: (companyId: string, agentId: string, input: CryptoAgentLimits) =>
    api.put<CryptoAgentLimits>(`${base(companyId)}/agents/${agentId}/limits`, input),
};
