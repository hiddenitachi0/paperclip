import { useEffect } from "react";
import { Shield } from "lucide-react";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useCompany } from "@/context/CompanyContext";
import { Button } from "@/components/ui/button";
import { Link, Navigate } from "@/lib/router";
import { usePluginSlots } from "@/plugins/slots";

export function CompanyAccessLegacyRoute() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { slots, isLoading, errorMessage } = usePluginSlots({
    slotTypes: ["companySettingsPage"],
    companyId: selectedCompanyId,
    enabled: !!selectedCompanyId,
  });

  useEffect(() => {
    setBreadcrumbs([
      { label: "Settings", href: "/company/settings" },
      { label: "Access" },
    ]);
  }, [setBreadcrumbs]);

  const permissionsSlot = slots.find((slot) => slot.routePath === "permissions");
  if (permissionsSlot) {
    return <Navigate to="/company/settings/permissions" replace />;
  }

  if (isLoading) {
    return <div className="text-sm text-muted-foreground">Checking for advanced permission extensions...</div>;
  }

  return (
    <div className="max-w-2xl space-y-5">
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <Shield className="h-5 w-5 text-muted-foreground" />
          <h1 className="text-lg font-semibold">Advanced Permissions</h1>
        </div>
        <p className="text-sm text-muted-foreground">
          Advanced access, scoped assignment, and explicit grant controls are provided by installed company settings extensions.
        </p>
      </div>

      <div className="space-y-4 rounded-xl border border-border px-5 py-5">
        <div className="space-y-2">
          <h2 className="text-sm font-semibold">Advanced permissions unavailable</h2>
          <p className="text-sm text-muted-foreground">
            Core Paperclip keeps enforcing company boundaries and any existing restrictive policy data, but editing advanced permissions requires an installed extension.
          </p>
          {errorMessage ? (
            <p className="text-sm text-destructive">Plugin extensions unavailable: {errorMessage}</p>
          ) : null}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button asChild>
            <Link to="/company/settings/people">Open People</Link>
          </Button>
        </div>
      </div>
    </div>
  );
}
