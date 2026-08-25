export type CompanyArtifactSource = "document" | "attachment" | "work_product";

export type CompanyArtifactMediaKind = "image" | "video" | "text" | "document" | "file" | "empty";

export type CompanyArtifactGroupBy = "none" | "task" | "parent_task" | "agent";

export interface CompanyArtifactIssueSummary {
  id: string;
  identifier: string;
  title: string;
}

export interface CompanyArtifactProjectSummary {
  id: string;
  name: string;
}

export interface CompanyArtifactAgentSummary {
  id: string;
  name: string;
}

export interface CompanyArtifact {
  id: string;
  source: CompanyArtifactSource;
  mediaKind: CompanyArtifactMediaKind;
  title: string;
  previewText: string | null;
  contentType: string | null;
  contentPath: string | null;
  openPath: string | null;
  downloadPath: string | null;
  byteSize?: number | null;
  originalFilename?: string | null;
  issue: CompanyArtifactIssueSummary;
  project: CompanyArtifactProjectSummary | null;
  createdByAgent: CompanyArtifactAgentSummary | null;
  /**
   * True when a human operator uploaded this file directly (not an agent).
   * Mutually exclusive with `createdByAgent`; render as "Uploaded by you"
   * rather than treating the artifact as maker-less.
   */
  createdByUser?: boolean;
  updatedAt: string;
  href: string;
}

export interface CompanyArtifactGroup {
  id: string;
  groupBy: Exclude<CompanyArtifactGroupBy, "none">;
  /**
   * Set for `groupBy: "task" | "parent_task"`. Null/absent for
   * `groupBy: "agent"`, which groups by `agent` instead (see below).
   */
  issue?: CompanyArtifactIssueSummary | null;
  /** Set for `groupBy: "agent"` — the person who made the files in this group, or null for the maker-less/human-upload buckets. */
  agent?: CompanyArtifactAgentSummary | null;
  /**
   * Set for `groupBy: "agent"` when this group represents files uploaded
   * directly by a human operator, distinct from the maker-less bucket
   * (`agent: null, isUserUploadGroup: falsy`) which means "no idea who made this".
   */
  isUserUploadGroup?: boolean;
  title: string;
  count: number;
  mediaKinds: CompanyArtifactMediaKind[];
  previewArtifacts: CompanyArtifact[];
  updatedAt: string;
  href: string;
}

export interface CompanyArtifactsResponse {
  artifacts: CompanyArtifact[];
  groups?: CompanyArtifactGroup[];
  selectedGroup?: CompanyArtifactGroup | null;
  nextCursor: string | null;
}
