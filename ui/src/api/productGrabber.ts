import type {
  ProductGrabberSettings,
  ProductGrabberStagedItemSummary,
  ProductGrabberStagingStatus,
} from "@paperclipai/shared";
import { api } from "./client";

// Product grabber (DUR-4187/DUR-4188): fetches a product's details and images
// from a vendor site into a staging list a person approves before anything
// else uses them. Nothing here ever pushes to a storefront.

export const productGrabberApi = {
  getSettings: (companyId: string) =>
    api.get<ProductGrabberSettings>(`/companies/${companyId}/product-grabber/settings`),
  setEnabled: (companyId: string, enabled: boolean) =>
    api.patch<ProductGrabberSettings>(`/companies/${companyId}/product-grabber/settings`, { enabled }),
  listStagedItems: (companyId: string, status?: ProductGrabberStagingStatus) =>
    api
      .get<{ items: ProductGrabberStagedItemSummary[] }>(
        `/companies/${companyId}/product-grabber/staged-items${status ? `?status=${status}` : ""}`,
      )
      .then((res) => res.items),
  extract: (companyId: string, url: string) =>
    api.post<ProductGrabberStagedItemSummary>(`/companies/${companyId}/product-grabber/extract`, { url }),
  review: (companyId: string, itemId: string, status: "approved" | "rejected") =>
    api.post<ProductGrabberStagedItemSummary>(
      `/companies/${companyId}/product-grabber/staged-items/${itemId}/review`,
      { status },
    ),
};
