import { ArrowRightLeft } from "lucide-react";
import { Link } from "@/lib/router";
import { useCompany } from "../../context/CompanyContext";

/**
 * Shown on every page of a company that an owner/admin marked as moved to
 * another Paperclip ("Mark as migrated", Company settings → Moving this
 * company). The company still works here; its agents and routines are paused.
 */
export function CompanyMovedBanner() {
  const { selectedCompany } = useCompany();
  const url = selectedCompany?.migratedToUrl;
  if (!url) return null;
  return (
    <div
      className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-amber-500/30 bg-amber-500/10 px-4 py-2 text-sm text-amber-800 dark:text-amber-300"
      role="status"
      data-testid="company-moved-banner"
    >
      <ArrowRightLeft className="h-4 w-4 shrink-0" />
      <span>
        This company has moved to{" "}
        <a href={url} target="_blank" rel="noreferrer" className="font-medium underline">
          {url}
        </a>
        . Its agents and routines are paused here.
      </span>
      <Link to="/company/settings" className="underline">
        Undo or details
      </Link>
    </div>
  );
}
