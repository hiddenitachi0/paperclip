import type {
  PreviewReportDataInput,
  ReportDataPreview,
  ReportTemplate,
  UpdateReportTemplateInput,
} from "@paperclipai/shared";
import { api } from "./client";

/**
 * DUR-4072 PR3: report templates on the Connections page -- choosing where a
 * template's data comes from, and previewing it. The data is read by the
 * server; no key or credential ever travels through here.
 */
export const reportsApi = {
  listTemplates: (companyId: string) => api.get<ReportTemplate[]>(`/companies/${companyId}/report-templates`),
  updateTemplate: (companyId: string, templateId: string, data: UpdateReportTemplateInput) =>
    api.patch<ReportTemplate>(`/companies/${companyId}/report-templates/${encodeURIComponent(templateId)}`, data),
  previewData: (companyId: string, data: PreviewReportDataInput) =>
    api.post<ReportDataPreview>(`/companies/${companyId}/report-data/preview`, data),
};
