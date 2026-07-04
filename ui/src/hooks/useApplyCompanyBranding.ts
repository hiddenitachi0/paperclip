import { useEffect, useState } from "react";
import type { Company } from "@paperclipai/shared";
import {
  applyBrandColor,
  BRANDING_CHANGED_EVENT,
  isDefaultSkin,
} from "../lib/company-branding";

/**
 * Applies the selected company's `brandColor` as app theme overrides, unless
 * that company is pinned to the default Paperclip skin. Re-applies when the
 * company, its brand color, or the default-skin preference changes.
 */
export function useApplyCompanyBranding(company: Company | null): void {
  const [version, setVersion] = useState(0);
  const companyId = company?.id ?? null;
  const brandColor = company?.brandColor ?? null;

  // The default-skin toggle lives in localStorage; bump a version to re-run.
  useEffect(() => {
    const bump = () => setVersion((v) => v + 1);
    window.addEventListener(BRANDING_CHANGED_EVENT, bump);
    window.addEventListener("storage", bump);
    return () => {
      window.removeEventListener(BRANDING_CHANGED_EVENT, bump);
      window.removeEventListener("storage", bump);
    };
  }, []);

  useEffect(() => {
    const useBrand = Boolean(brandColor) && !isDefaultSkin(companyId);
    applyBrandColor(useBrand ? brandColor : null);
    return () => applyBrandColor(null);
  }, [companyId, brandColor, version]);
}
