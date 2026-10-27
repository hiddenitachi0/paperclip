import type {
  ContractDeadlineKind,
  ContractDeadlineState,
  ContractStatus,
  ContractTermValueKind,
  ContractTextStatus,
  ContractType,
  CreateContract,
  CreateContractDeadline,
  CreateContractParty,
  LinkPreviousContractVersion,
  UpdateContract,
  UpdateContractDeadline,
  UpdateContractParty,
  UpsertContractTerm,
} from "@paperclipai/shared";
import { api } from "./client";

/**
 * Legal: the contract register. Every route is company-scoped and the server
 * refuses anyone who is not allowed to see contracts, so a 403 here means
 * "not for you", not "broken".
 *
 * The list never carries the contract's own words; they only come back from
 * `get` when `includeText` is asked for, and nothing in this client logs them.
 */

export interface Contract {
  id: string;
  companyId: string;
  title: string;
  type: ContractType;
  status: ContractStatus;
  assetId: string | null;
  textStatus: ContractTextStatus;
  language: string | null;
  governingLaw: string | null;
  effectiveDate: string | null;
  expiryDate: string | null;
  autoRenewal: boolean | null;
  noticePeriodDays: number | null;
  summary: string | null;
  supersedesContractId: string | null;
  versionNo: number;
  changeSummary: string | null;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  sourceIssueId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ContractParty {
  id: string;
  companyId: string;
  contractId: string;
  organizationId: string | null;
  role: string;
  name: string | null;
  createdAt: string;
}

export interface ContractDeadline {
  id: string;
  companyId: string;
  contractId: string;
  kind: ContractDeadlineKind;
  dueDate: string;
  leadTimesDays: number[];
  clauseRef: string | null;
  state: ContractDeadlineState;
  note: string | null;
  createdAt: string;
  updatedAt: string;
  /**
   * Reminder tasks already opened for this date. The server does not send them
   * yet; the contract page shows them as soon as it does.
   */
  reminders?: Array<{ leadDays: number; issueId: string | null }>;
}

export interface ContractTerm {
  id: string;
  companyId: string;
  contractId: string;
  key: string;
  valueKind: ContractTermValueKind;
  /** Comes back as a string because the column is an exact decimal. */
  numberValue: string | null;
  currency: string | null;
  textValue: string | null;
  boolValue: boolean | null;
  clauseRef: string | null;
  pageRef: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ContractDetail extends Contract {
  parties: ContractParty[];
  deadlines: ContractDeadline[];
  terms: ContractTerm[];
  /** Only present when the page asked for the contract's own words. */
  extractedText?: string | null;
}

export interface ContractVersion {
  id: string;
  title: string;
  status: ContractStatus;
  versionNo: number;
  changeSummary: string | null;
  supersedesContractId: string | null;
  effectiveDate: string | null;
  createdAt: string;
}

export interface LinkVersionResult {
  previousContractId: string;
  versionNo: number;
  carryDeadlines: boolean;
  movedDeadlines: number;
  supersededDeadlines: number;
}

export interface ContractListFilters {
  status?: ContractStatus;
  type?: ContractType;
  expiresBefore?: string;
}

export interface CrmOrganisationOption {
  id: string;
  name: string;
}

/**
 * Attaching a PDF or Word file needs the server's contract upload route. Until
 * that route is live this stays false: the Add contract form then saves the
 * details and says plainly that the file cannot be attached yet. When the route
 * lands, wire `uploadFile` to it and flip this to true.
 */
export const CONTRACT_FILE_UPLOAD_READY = false;
export const CONTRACT_FILE_MAX_BYTES = 25 * 1024 * 1024;

function base(companyId: string) {
  return `/companies/${companyId}`;
}

export const contractsApi = {
  list: (companyId: string, filters: ContractListFilters = {}) => {
    const params = new URLSearchParams();
    if (filters.status) params.set("status", filters.status);
    if (filters.type) params.set("type", filters.type);
    if (filters.expiresBefore) params.set("expiresBefore", filters.expiresBefore);
    const query = params.toString();
    return api.get<Contract[]>(`${base(companyId)}/contracts${query ? `?${query}` : ""}`);
  },
  get: (companyId: string, contractId: string) =>
    api.get<ContractDetail>(`${base(companyId)}/contracts/${contractId}`),
  /** Fetches the contract's own words. Only the text panel on the contract page uses this. */
  getWithText: (companyId: string, contractId: string) =>
    api.get<ContractDetail>(`${base(companyId)}/contracts/${contractId}?includeText=true`),
  create: (companyId: string, input: CreateContract) => api.post<ContractDetail>(`${base(companyId)}/contracts`, input),
  update: (companyId: string, contractId: string, input: UpdateContract) =>
    api.patch<Contract>(`${base(companyId)}/contracts/${contractId}`, input),
  remove: (companyId: string, contractId: string) =>
    api.delete<{ ok: true }>(`${base(companyId)}/contracts/${contractId}`),
  versions: (companyId: string, contractId: string) =>
    api.get<ContractVersion[]>(`${base(companyId)}/contracts/${contractId}/versions`),
  linkPreviousVersion: (companyId: string, contractId: string, input: LinkPreviousContractVersion) =>
    api.post<LinkVersionResult>(`${base(companyId)}/contracts/${contractId}/link-previous-version`, input),

  listDeadlines: (companyId: string, filters: { state?: ContractDeadlineState; dueBefore?: string } = {}) => {
    const params = new URLSearchParams();
    if (filters.state) params.set("state", filters.state);
    if (filters.dueBefore) params.set("dueBefore", filters.dueBefore);
    const query = params.toString();
    return api.get<ContractDeadline[]>(`${base(companyId)}/contract-deadlines${query ? `?${query}` : ""}`);
  },
  addDeadline: (companyId: string, contractId: string, input: CreateContractDeadline) =>
    api.post<ContractDeadline>(`${base(companyId)}/contracts/${contractId}/deadlines`, input),
  updateDeadline: (companyId: string, contractId: string, deadlineId: string, input: UpdateContractDeadline) =>
    api.patch<ContractDeadline>(`${base(companyId)}/contracts/${contractId}/deadlines/${deadlineId}`, input),
  removeDeadline: (companyId: string, contractId: string, deadlineId: string) =>
    api.delete<{ ok: true }>(`${base(companyId)}/contracts/${contractId}/deadlines/${deadlineId}`),

  addParty: (companyId: string, contractId: string, input: CreateContractParty) =>
    api.post<ContractParty>(`${base(companyId)}/contracts/${contractId}/parties`, input),
  updateParty: (companyId: string, contractId: string, partyId: string, input: UpdateContractParty) =>
    api.patch<ContractParty>(`${base(companyId)}/contracts/${contractId}/parties/${partyId}`, input),
  removeParty: (companyId: string, contractId: string, partyId: string) =>
    api.delete<{ ok: true }>(`${base(companyId)}/contracts/${contractId}/parties/${partyId}`),

  setTerm: (companyId: string, contractId: string, key: string, input: UpsertContractTerm) =>
    api.put<ContractTerm>(`${base(companyId)}/contracts/${contractId}/terms/${encodeURIComponent(key)}`, input),
  removeTerm: (companyId: string, contractId: string, key: string) =>
    api.delete<{ ok: true }>(`${base(companyId)}/contracts/${contractId}/terms/${encodeURIComponent(key)}`),

  /** Names of the organisations in the CRM, so a party can be picked instead of typed. */
  listOrganisations: (companyId: string) =>
    api.get<CrmOrganisationOption[]>(`${base(companyId)}/crm/organisations`),

  /** Stores a PDF or Word file and returns the contract it created. Not wired up yet, see CONTRACT_FILE_UPLOAD_READY. */
  uploadFile: async (_companyId: string, _file: File, _details: { title: string; type: ContractType }): Promise<ContractDetail> => {
    throw new Error("Adding a file is not switched on yet.");
  },

  /** Where the stored file can be opened or downloaded. */
  fileUrl: (assetId: string) => `/api/assets/${assetId}/content`,
};
