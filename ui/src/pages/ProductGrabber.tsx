import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, ShoppingCart, X } from "lucide-react";
import type { ProductGrabberStagedItemSummary, ProductGrabberStagingStatus } from "@paperclipai/shared";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToastActions } from "../context/ToastContext";
import { useCompanyRole } from "../hooks/useCompanyRole";
import { productGrabberApi } from "../api/productGrabber";
import { ApiError } from "../api/client";
import { queryKeys } from "../lib/queryKeys";
import { timeAgo } from "../lib/timeAgo";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";

/**
 * Product grabber (DUR-4188): the staging-list approval view. An owner or
 * admin pastes a product page's web address, the tool fetches its details
 * and pictures into a waiting list, and a person approves or rejects each
 * one. Nothing here ever pushes a product anywhere by itself.
 */

type Tab = "pending" | "approved" | "rejected" | "all";

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return fallback;
}

/** Scraped addresses are untrusted: only ever link to or load plain http(s) URLs. */
function safeWebUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.href : null;
  } catch {
    return null;
  }
}

function firstTextField(rawFields: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = rawFields[key];
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  return null;
}

function StagedProductRow({
  item,
  canManage,
  busy,
  onApprove,
  onReject,
}: {
  item: ProductGrabberStagedItemSummary;
  canManage: boolean;
  busy: boolean;
  onApprove: () => void;
  onReject: () => void;
}) {
  const title = firstTextField(item.rawFields, ["title", "name"]) ?? item.vendor;
  const price = firstTextField(item.rawFields, ["price", "priceText"]);
  const thumbnail = safeWebUrl(item.imageUrls[0]);
  const sourceHref = safeWebUrl(item.sourceUrl);

  return (
    <li className="flex items-start gap-4 px-4 py-3" data-testid="product-grabber-row">
      {thumbnail ? (
        <img src={thumbnail} alt="" referrerPolicy="no-referrer" className="h-16 w-16 shrink-0 rounded-md border border-border object-cover" />
      ) : (
        <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-md border border-border bg-muted">
          <ShoppingCart className="h-5 w-5 text-muted-foreground" />
        </div>
      )}
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="flex flex-wrap items-center gap-2 font-medium">
          {title}
          {item.status !== "pending" ? (
            <span className="rounded bg-muted px-1.5 py-0.5 text-xs font-normal text-muted-foreground">
              {item.status === "approved" ? "Approved" : "Rejected"}
            </span>
          ) : null}
        </div>
        <p className="truncate text-sm text-muted-foreground">
          {item.vendor}
          {price ? ` · ${price}` : ""}
        </p>
        {sourceHref ? (
          <a
            href={sourceHref}
            target="_blank"
            rel="noopener noreferrer"
            className="block truncate text-xs text-muted-foreground underline-offset-2 hover:underline"
          >
            {item.sourceUrl}
          </a>
        ) : (
          <p className="truncate text-xs text-muted-foreground">{item.sourceUrl}</p>
        )}
        <p className="text-xs text-muted-foreground">Fetched {timeAgo(item.createdAt)}</p>
      </div>
      {canManage && item.status === "pending" ? (
        <div className="flex shrink-0 items-center gap-2">
          <Button variant="outline" size="sm" onClick={onReject} disabled={busy}>
            <X className="mr-1.5 h-3.5 w-3.5" />
            Reject
          </Button>
          <Button size="sm" onClick={onApprove} disabled={busy}>
            <Check className="mr-1.5 h-3.5 w-3.5" />
            Approve
          </Button>
        </div>
      ) : null}
    </li>
  );
}

export function ProductGrabber() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToastActions();
  const queryClient = useQueryClient();
  const role = useCompanyRole(selectedCompanyId);
  const canManage = role.canManageConnections;

  const [tab, setTab] = useState<Tab>("pending");
  const [url, setUrl] = useState("");

  useEffect(() => {
    setBreadcrumbs([{ label: "Product grabber" }]);
  }, [setBreadcrumbs]);

  const settingsQuery = useQuery({
    queryKey: selectedCompanyId ? queryKeys.productGrabber.settings(selectedCompanyId) : ["product-grabber", "__none__"],
    queryFn: () => productGrabberApi.getSettings(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });
  const enabled = settingsQuery.data?.enabled === true;

  const statusFilter = tab === "all" ? undefined : (tab as ProductGrabberStagingStatus);
  const itemsQuery = useQuery({
    queryKey: selectedCompanyId
      ? queryKeys.productGrabber.stagedItems(selectedCompanyId, statusFilter)
      : ["product-grabber", "__none__"],
    queryFn: () => productGrabberApi.listStagedItems(selectedCompanyId!, statusFilter),
    enabled: Boolean(selectedCompanyId) && enabled,
  });
  const items = itemsQuery.data ?? [];

  const invalidateItems = () => {
    if (selectedCompanyId) {
      queryClient.invalidateQueries({ queryKey: ["product-grabber", "staged-items", selectedCompanyId] });
    }
  };

  const toggleEnabled = useMutation({
    mutationFn: (next: boolean) => productGrabberApi.setEnabled(selectedCompanyId!, next),
    onSuccess: (settings) => {
      if (selectedCompanyId) queryClient.setQueryData(queryKeys.productGrabber.settings(selectedCompanyId), settings);
      pushToast({ title: settings.enabled ? "Product grabber turned on" : "Product grabber turned off", tone: "success" });
    },
    onError: (error) => pushToast({ title: "Could not change that setting", body: errorMessage(error, ""), tone: "error" }),
  });

  const extract = useMutation({
    mutationFn: (input: string) => productGrabberApi.extract(selectedCompanyId!, input),
    onSuccess: () => {
      invalidateItems();
      setUrl("");
      setTab("pending");
      pushToast({ title: "Product added to the waiting list", tone: "success" });
    },
    onError: (error) =>
      pushToast({ title: "Could not fetch that product", body: errorMessage(error, "Check the web address and try again."), tone: "error" }),
  });

  const review = useMutation({
    mutationFn: ({ id, status }: { id: string; status: "approved" | "rejected" }) =>
      productGrabberApi.review(selectedCompanyId!, id, status),
    onSuccess: (_result, variables) => {
      invalidateItems();
      pushToast({ title: variables.status === "approved" ? "Product approved" : "Product rejected", tone: "success" });
    },
    onError: (error) => pushToast({ title: "Could not update that product", body: errorMessage(error, ""), tone: "error" }),
  });

  if (settingsQuery.isLoading) {
    return <PageSkeleton variant="list" />;
  }

  if (!enabled) {
    return (
      <div className="mx-auto max-w-3xl space-y-6">
        <div>
          <h1 className="text-lg font-semibold">Product grabber</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Fetch a product's details and pictures from a vendor's web page into a waiting list, then approve or reject
            each one by hand. Nothing is sent anywhere else by this tool.
          </p>
        </div>
        <EmptyState
          icon={ShoppingCart}
          message={
            canManage
              ? "This isn't turned on yet. Turn it on to start adding products."
              : "This isn't turned on yet. Ask a company owner or admin to turn it on."
          }
          action={canManage ? "Turn on product grabber" : undefined}
          onAction={canManage ? () => toggleEnabled.mutate(true) : undefined}
        />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold">Product grabber</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Fetch a product's details and pictures from a vendor's web page, then approve or reject each one by hand.
          </p>
        </div>
        {canManage ? (
          <div className="flex shrink-0 items-center gap-2">
            <span className="text-sm text-muted-foreground">On</span>
            <ToggleSwitch
              aria-label="Turn off product grabber"
              checked={enabled}
              onCheckedChange={(next) => toggleEnabled.mutate(next)}
              disabled={toggleEnabled.isPending}
            />
          </div>
        ) : null}
      </div>

      {canManage ? (
        <form
          className="flex items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (url.trim()) extract.mutate(url.trim());
          }}
        >
          <Input
            type="url"
            placeholder="Paste a product page's web address"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            disabled={extract.isPending}
            aria-label="Product web address"
          />
          <Button type="submit" disabled={extract.isPending || !url.trim()}>
            {extract.isPending ? "Fetching…" : "Add product"}
          </Button>
        </form>
      ) : null}

      <Tabs value={tab} onValueChange={(value) => setTab(value as Tab)}>
        <TabsList variant="line" className="p-0">
          <TabsTrigger value="pending" className="px-3">
            Waiting
          </TabsTrigger>
          <TabsTrigger value="approved" className="px-3">
            Approved
          </TabsTrigger>
          <TabsTrigger value="rejected" className="px-3">
            Rejected
          </TabsTrigger>
          <TabsTrigger value="all" className="px-3">
            All
          </TabsTrigger>
        </TabsList>
      </Tabs>

      {itemsQuery.isLoading ? (
        <PageSkeleton variant="list" />
      ) : itemsQuery.error ? (
        <div className="py-6 text-sm text-destructive">{errorMessage(itemsQuery.error, "Could not load the products.")}</div>
      ) : items.length === 0 ? (
        <EmptyState
          icon={ShoppingCart}
          message={
            tab === "pending"
              ? "Nothing waiting for review right now."
              : `No ${tab === "all" ? "" : tab} products yet.`
          }
        />
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {items.map((item) => (
            <StagedProductRow
              key={item.id}
              item={item}
              canManage={canManage}
              busy={review.isPending}
              onApprove={() => review.mutate({ id: item.id, status: "approved" })}
              onReject={() => review.mutate({ id: item.id, status: "rejected" })}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
