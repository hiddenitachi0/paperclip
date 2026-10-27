import { useEffect, useMemo, useState } from "react";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, CalendarClock, FileWarning, Plus, Scale } from "lucide-react";
import { CONTRACT_STATUSES, CONTRACT_TYPES, type ContractStatus, type ContractType } from "@paperclipai/shared";
import { contractsApi, type Contract, type ContractDeadline, type ContractDetail } from "../api/contracts";
import { ApiError } from "../api/client";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToastActions } from "../context/ToastContext";
import { useCanUseContracts } from "../hooks/useCanUseContracts";
import { queryKeys } from "../lib/queryKeys";
import {
  CONTRACT_STATUS_LABELS,
  CONTRACT_TYPE_LABELS,
  DEADLINE_KIND_LABELS,
  DEADLINE_SOON_DAYS,
  addDaysIso,
  daysUntil,
  describeDaysUntil,
  formatDay,
  partyDisplayName,
} from "../lib/contract-labels";
import { Link, useNavigate, useSearchParams } from "@/lib/router";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { ContractUploadDialog, type ContractUploadValues } from "../components/legal/ContractUploadDialog";

/**
 * Legal: every contract on file, with the dates you must not miss. Board
 * members of the company can open it; the server refuses everyone else.
 */

const selectClass = "h-9 rounded-md border border-input bg-background px-2 text-sm";
const SOON_CHOICES = [30, 60, 90] as const;
/** The default view hides contracts a newer version has replaced. */
const NOT_REPLACED = "current";
const ALL_STATUSES = "all";

export function errorText(error: unknown, fallback: string): string {
  if (error instanceof ApiError) {
    if (error.status === 403) return "You do not have access to contracts in this company.";
    return error.message;
  }
  if (error instanceof Error) return error.message;
  return fallback;
}

export interface ContractFilters {
  type: ContractType | "";
  status: ContractStatus | typeof NOT_REPLACED | typeof ALL_STATUSES;
  party: string;
  soonDays: number | null;
  search: string;
}

export function nextOpenDeadline(deadlines: ContractDeadline[]): ContractDeadline | null {
  const open = deadlines.filter((deadline) => deadline.state === "open");
  return open.sort((a, b) => a.dueDate.localeCompare(b.dueDate))[0] ?? null;
}

export function filterContracts(
  contracts: Contract[],
  filters: ContractFilters,
  partyNames: Map<string, string[]>,
  openDeadlines: Map<string, ContractDeadline[]>,
  now: Date = new Date(),
): Contract[] {
  const search = filters.search.trim().toLowerCase();
  const soonLimit = filters.soonDays === null ? null : addDaysIso(filters.soonDays, now);
  return contracts.filter((contract) => {
    if (filters.type && contract.type !== filters.type) return false;
    if (filters.status === NOT_REPLACED) {
      if (contract.status === "superseded") return false;
    } else if (filters.status !== ALL_STATUSES && contract.status !== filters.status) {
      return false;
    }
    const parties = partyNames.get(contract.id) ?? [];
    if (filters.party && !parties.includes(filters.party)) return false;
    if (soonLimit !== null) {
      const next = nextOpenDeadline(openDeadlines.get(contract.id) ?? []);
      if (!next || next.dueDate > soonLimit) return false;
    }
    if (search) {
      const haystack = [contract.title, ...parties].join(" ").toLowerCase();
      if (!haystack.includes(search)) return false;
    }
    return true;
  });
}

function DeadlineBadge({ deadline, now }: { deadline: ContractDeadline; now?: Date }) {
  const days = daysUntil(deadline.dueDate, now);
  const urgent = days <= 7;
  return (
    <Badge
      variant="outline"
      className={
        urgent
          ? "border-destructive/50 text-destructive"
          : "border-amber-500/50 text-amber-700 dark:text-amber-400"
      }
      data-testid="contract-deadline-badge"
    >
      <CalendarClock />
      {DEADLINE_KIND_LABELS[deadline.kind]}: {formatDay(deadline.dueDate)} ({describeDaysUntil(deadline.dueDate, now)})
    </Badge>
  );
}

export function ContractRow({
  contract,
  parties,
  nextDeadline,
}: {
  contract: Contract;
  parties: string[];
  nextDeadline: ContractDeadline | null;
}) {
  const dueSoon = nextDeadline !== null && daysUntil(nextDeadline.dueDate) <= DEADLINE_SOON_DAYS;
  return (
    <li data-testid="contract-row">
      <Link to={`/legal/${contract.id}`} className="block px-4 py-3 hover:bg-accent/40 focus-visible:bg-accent/40">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{contract.title}</span>
          {contract.versionNo > 1 ? (
            <span className="text-xs text-muted-foreground">Version {contract.versionNo}</span>
          ) : null}
          <Badge variant="secondary">{CONTRACT_TYPE_LABELS[contract.type]}</Badge>
          {contract.status !== "active" ? (
            <Badge variant="outline">{CONTRACT_STATUS_LABELS[contract.status]}</Badge>
          ) : null}
          {contract.textStatus === "no_text_layer" ? (
            <Badge
              variant="outline"
              className="border-amber-500/50 text-amber-700 dark:text-amber-400"
              data-testid="contract-scan-badge"
            >
              <FileWarning />
              Scanned, no readable text
            </Badge>
          ) : null}
          {dueSoon && nextDeadline ? <DeadlineBadge deadline={nextDeadline} /> : null}
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          {parties.length > 0 ? parties.join(", ") : "No other party added yet"}
          {contract.expiryDate ? ` · ends ${formatDay(contract.expiryDate)}` : ""}
        </p>
      </Link>
    </li>
  );
}

export function Legal() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToastActions();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const canUse = useCanUseContracts(selectedCompanyId);
  const [searchParams, setSearchParams] = useSearchParams();
  const [uploadOpen, setUploadOpen] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  useEffect(() => {
    setBreadcrumbs([{ label: "Legal" }]);
  }, [setBreadcrumbs]);

  const typeParam = searchParams.get("type") ?? "";
  const statusParam = searchParams.get("status") ?? NOT_REPLACED;
  const soonParam = Number(searchParams.get("soon"));
  const filters: ContractFilters = {
    type: (CONTRACT_TYPES as readonly string[]).includes(typeParam) ? (typeParam as ContractType) : "",
    status: (CONTRACT_STATUSES as readonly string[]).includes(statusParam)
      ? (statusParam as ContractStatus)
      : statusParam === ALL_STATUSES
        ? ALL_STATUSES
        : NOT_REPLACED,
    party: searchParams.get("party") ?? "",
    soonDays: (SOON_CHOICES as readonly number[]).includes(soonParam) ? soonParam : null,
    search: searchParams.get("q") ?? "",
  };

  function setParam(name: string, value: string | null) {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (value) next.set(name, value);
        else next.delete(name);
        return next;
      },
      { replace: true },
    );
  }

  const enabled = Boolean(selectedCompanyId) && canUse;

  const contractsQuery = useQuery({
    queryKey: selectedCompanyId ? queryKeys.contracts.list(selectedCompanyId) : ["contracts", "__none__"],
    queryFn: () => contractsApi.list(selectedCompanyId!),
    enabled,
  });
  const contracts = contractsQuery.data ?? [];

  const deadlinesQuery = useQuery({
    queryKey: selectedCompanyId ? queryKeys.contracts.openDeadlines(selectedCompanyId) : ["contracts", "__none__", "d"],
    queryFn: () => contractsApi.listDeadlines(selectedCompanyId!, { state: "open" }),
    enabled,
  });

  const organisationsQuery = useQuery({
    queryKey: selectedCompanyId ? queryKeys.contracts.organisations(selectedCompanyId) : ["contracts", "__none__", "o"],
    queryFn: () => contractsApi.listOrganisations(selectedCompanyId!),
    enabled,
    retry: false,
  });

  // The list answer carries no parties, so each contract's own page data is
  // fetched (and cached for the contract page too).
  const detailQueries = useQueries({
    queries: contracts.map((contract) => ({
      queryKey: queryKeys.contracts.detail(selectedCompanyId ?? "", contract.id),
      queryFn: () => contractsApi.get(selectedCompanyId!, contract.id),
      enabled,
      staleTime: 60_000,
    })),
  });
  const details = detailQueries.map((query) => query.data).filter((data): data is ContractDetail => Boolean(data));

  const organisationNames = useMemo(
    () => new Map((organisationsQuery.data ?? []).map((org) => [org.id, org.name])),
    [organisationsQuery.data],
  );
  const partyNames = new Map<string, string[]>();
  for (const detail of details) {
    partyNames.set(detail.id, [...new Set(detail.parties.map((party) => partyDisplayName(party, organisationNames)))]);
  }
  const openDeadlines = useMemo(() => {
    const map = new Map<string, ContractDeadline[]>();
    for (const deadline of deadlinesQuery.data ?? []) {
      map.set(deadline.contractId, [...(map.get(deadline.contractId) ?? []), deadline]);
    }
    return map;
  }, [deadlinesQuery.data]);

  const allPartyNames = [...new Set([...partyNames.values()].flat())].sort((a, b) => a.localeCompare(b));
  const visible = filterContracts(contracts, filters, partyNames, openDeadlines);

  const create = useMutation({
    mutationFn: async (values: ContractUploadValues) => {
      const created = values.file
        ? await contractsApi.uploadFile(selectedCompanyId!, values.file, { title: values.title, type: values.type })
        : await contractsApi.create(selectedCompanyId!, { title: values.title, type: values.type, status: values.status });
      if (values.previousContractId) {
        await contractsApi.linkPreviousVersion(selectedCompanyId!, created.id, {
          previousContractId: values.previousContractId,
          changeSummary: values.changeSummary,
          carryDeadlines: values.carryDeadlines,
        });
      }
      return created;
    },
    onSuccess: (created) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.contracts.all(selectedCompanyId!) });
      setUploadOpen(false);
      pushToast({ title: "Contract added", tone: "success" });
      navigate(`/legal/${created.id}`);
    },
    onError: (error) => setUploadError(errorText(error, "The contract could not be added.")),
  });

  if (!canUse) {
    return (
      <div className="mx-auto max-w-3xl py-10">
        <EmptyState icon={Scale} message="Legal is only open to people who can make changes in this company." />
      </div>
    );
  }

  const failed = contractsQuery.error;
  const noFilters = !filters.type && !filters.party && filters.soonDays === null && !filters.search && filters.status === NOT_REPLACED;
  const dueSoonCount = contracts.filter((contract) => {
    const next = nextOpenDeadline(openDeadlines.get(contract.id) ?? []);
    return next && daysUntil(next.dueDate) <= DEADLINE_SOON_DAYS && contract.status !== "superseded";
  }).length;

  return (
    <div className="mx-auto max-w-4xl space-y-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold">Legal</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Your contracts in one place: what they say, who is on them, and the dates you must not miss.
          </p>
        </div>
        <Button
          onClick={() => {
            setUploadError(null);
            setUploadOpen(true);
          }}
        >
          <Plus className="mr-1.5 h-3.5 w-3.5" />
          Add contract
        </Button>
      </div>

      {dueSoonCount > 0 ? (
        <p
          className="flex items-center gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-sm"
          data-testid="legal-due-soon-summary"
        >
          <AlertTriangle className="h-4 w-4 shrink-0 text-amber-600" />
          {dueSoonCount === 1
            ? `1 contract has a date coming up in the next ${DEADLINE_SOON_DAYS} days.`
            : `${dueSoonCount} contracts have a date coming up in the next ${DEADLINE_SOON_DAYS} days.`}
        </p>
      ) : null}

      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-[12rem] flex-1">
          <label className="mb-1 block text-xs text-muted-foreground" htmlFor="legal-search">
            Search
          </label>
          <Input
            id="legal-search"
            value={filters.search}
            placeholder="Contract name or other party"
            onChange={(event) => setParam("q", event.target.value || null)}
          />
        </div>
        <div>
          <label className="mb-1 block text-xs text-muted-foreground" htmlFor="legal-type">
            Kind
          </label>
          <select
            id="legal-type"
            className={selectClass}
            value={filters.type}
            onChange={(event) => setParam("type", event.target.value || null)}
          >
            <option value="">All kinds</option>
            {CONTRACT_TYPES.map((value) => (
              <option key={value} value={value}>
                {CONTRACT_TYPE_LABELS[value]}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="mb-1 block text-xs text-muted-foreground" htmlFor="legal-party">
            Other party
          </label>
          <select
            id="legal-party"
            className={selectClass}
            value={filters.party}
            onChange={(event) => setParam("party", event.target.value || null)}
          >
            <option value="">Anyone</option>
            {allPartyNames.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="mb-1 block text-xs text-muted-foreground" htmlFor="legal-status">
            Status
          </label>
          <select
            id="legal-status"
            className={selectClass}
            value={filters.status}
            onChange={(event) => setParam("status", event.target.value === NOT_REPLACED ? null : event.target.value)}
          >
            <option value={NOT_REPLACED}>Current contracts</option>
            <option value={ALL_STATUSES}>Everything, including older versions</option>
            {CONTRACT_STATUSES.filter((value) => value !== "superseded").map((value) => (
              <option key={value} value={value}>
                {CONTRACT_STATUS_LABELS[value]}
              </option>
            ))}
            <option value="superseded">{CONTRACT_STATUS_LABELS.superseded}</option>
          </select>
        </div>
        <div>
          <label className="mb-1 block text-xs text-muted-foreground" htmlFor="legal-soon">
            Dates coming up
          </label>
          <select
            id="legal-soon"
            className={selectClass}
            value={filters.soonDays ?? ""}
            onChange={(event) => setParam("soon", event.target.value || null)}
          >
            <option value="">Any time</option>
            {SOON_CHOICES.map((days) => (
              <option key={days} value={days}>
                In the next {days} days
              </option>
            ))}
          </select>
        </div>
      </div>

      {contractsQuery.isLoading ? (
        <PageSkeleton variant="list" />
      ) : failed ? (
        <div className="py-6 text-sm text-destructive" role="alert">
          {errorText(failed, "The contracts could not be loaded.")}
        </div>
      ) : contracts.length === 0 ? (
        <EmptyState
          icon={Scale}
          message="No contracts yet. Add your first one and the dates in it will be kept here."
          action="Add contract"
          onAction={() => {
            setUploadError(null);
            setUploadOpen(true);
          }}
        />
      ) : visible.length === 0 ? (
        <div className="py-10 text-center text-sm text-muted-foreground" data-testid="legal-no-matches">
          {noFilters ? "No current contracts." : "No contracts match these choices."}
          {!noFilters ? (
            <div className="mt-3">
              <Button variant="outline" size="sm" onClick={() => setSearchParams({}, { replace: true })}>
                Clear choices
              </Button>
            </div>
          ) : null}
        </div>
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border" data-testid="legal-contract-list">
          {visible.map((contract) => (
            <ContractRow
              key={contract.id}
              contract={contract}
              parties={partyNames.get(contract.id) ?? []}
              nextDeadline={nextOpenDeadline(openDeadlines.get(contract.id) ?? [])}
            />
          ))}
        </ul>
      )}

      <ContractUploadDialog
        open={uploadOpen}
        onOpenChange={setUploadOpen}
        existing={contracts}
        busy={create.isPending}
        errorMessage={uploadError}
        onSubmit={(values) => {
          setUploadError(null);
          create.mutate(values);
        }}
      />
    </div>
  );
}
