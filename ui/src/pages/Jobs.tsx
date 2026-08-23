import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Briefcase, Copy, MoreVertical, Pencil, Plus, Trash2, Wrench, ShieldCheck } from "lucide-react";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToastActions } from "../context/ToastContext";
import { jobsApi, type Job, type JobDraft, type RightGrant } from "../api/jobs";
import { ApiError } from "../api/client";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { JobToolsPicker } from "../components/jobs/JobToolsPicker";
import { JobRightsPicker } from "../components/jobs/JobRightsPicker";
import { permissionLabel } from "../lib/permission-labels";

const queryKeysJobs = {
  list: (companyId: string) => ["jobs", companyId] as const,
};

function emptyDraft(): JobDraft {
  return { name: "", description: "", instructions: "", defaultTools: [], defaultRights: [] };
}

function draftFromJob(job: Job): JobDraft {
  return {
    name: job.name,
    description: job.description,
    instructions: job.instructions,
    defaultTools: job.defaultTools ?? [],
    defaultRights: job.defaultRights ?? [],
  };
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return fallback;
}

export function Jobs() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToastActions();
  const queryClient = useQueryClient();

  const [formOpen, setFormOpen] = useState(false);
  const [editingJobId, setEditingJobId] = useState<string | null>(null);
  const [deletingJob, setDeletingJob] = useState<Job | null>(null);
  const [duplicatingJob, setDuplicatingJob] = useState<Job | null>(null);

  useEffect(() => {
    setBreadcrumbs([{ label: "Jobs" }]);
  }, [setBreadcrumbs]);

  const { data: jobs, isLoading, error } = useQuery({
    queryKey: selectedCompanyId ? queryKeysJobs.list(selectedCompanyId) : ["jobs", "__none__"],
    queryFn: () => jobsApi.list(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });

  const invalidateJobs = () => {
    if (selectedCompanyId) {
      queryClient.invalidateQueries({ queryKey: queryKeysJobs.list(selectedCompanyId) });
    }
  };

  const createJob = useMutation({
    mutationFn: (data: JobDraft) => jobsApi.create(selectedCompanyId!, data),
    onSuccess: () => {
      invalidateJobs();
      setFormOpen(false);
      pushToast({ title: "Job created", tone: "success" });
    },
    onError: (error) => pushToast({ title: "Could not create job", body: errorMessage(error, ""), tone: "error" }),
  });

  const updateJob = useMutation({
    mutationFn: ({ id, data }: { id: string; data: JobDraft }) => jobsApi.update(id, data),
    onSuccess: () => {
      invalidateJobs();
      setFormOpen(false);
      setEditingJobId(null);
      pushToast({ title: "Job saved", tone: "success" });
    },
    onError: (error) => pushToast({ title: "Could not save job", body: errorMessage(error, ""), tone: "error" }),
  });

  const deleteJob = useMutation({
    mutationFn: (id: string) => jobsApi.remove(id),
    onSuccess: () => {
      invalidateJobs();
      setDeletingJob(null);
      pushToast({ title: "Job deleted", tone: "success" });
    },
    onError: (error) => pushToast({ title: "Could not delete job", body: errorMessage(error, ""), tone: "error" }),
  });

  const duplicateJob = useMutation({
    mutationFn: ({ id, targetCompanyId }: { id: string; targetCompanyId: string }) =>
      jobsApi.duplicateToCompany(id, targetCompanyId),
    onSuccess: () => {
      setDuplicatingJob(null);
      pushToast({ title: "Job copied", body: "A one-time copy — it will not stay in sync with the original.", tone: "success" });
    },
    onError: (error) => pushToast({ title: "Could not copy job", body: errorMessage(error, ""), tone: "error" }),
  });

  const editingJob = jobs?.find((job) => job.id === editingJobId) ?? null;

  function openCreate() {
    setEditingJobId(null);
    setFormOpen(true);
  }

  function openEdit(job: Job) {
    setEditingJobId(job.id);
    setFormOpen(true);
  }

  function handleSubmit(draft: JobDraft) {
    if (editingJobId) {
      updateJob.mutate({ id: editingJobId, data: draft });
    } else {
      createJob.mutate(draft);
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold">Jobs</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Set up a starting point for a job — instructions, tools, and rights — and hand it to any agent in one step.
            Assigning a job copies its defaults onto that agent once; it will not keep them in sync if you change the job later.
          </p>
        </div>
        <Button onClick={openCreate}>
          <Plus className="mr-1.5 h-3.5 w-3.5" />
          New job
        </Button>
      </div>

      {isLoading ? (
        <PageSkeleton variant="list" />
      ) : error ? (
        <div className="py-6 text-sm text-destructive">{errorMessage(error, "Could not load jobs.")}</div>
      ) : !jobs || jobs.length === 0 ? (
        <EmptyState
          icon={Briefcase}
          message="No jobs yet. Create one to give agents a ready-made starting point."
          action="New job"
          onAction={openCreate}
        />
      ) : (
        <ul className="divide-y divide-border border border-border rounded-lg">
          {jobs.map((job) => (
            <li key={job.id} className="flex items-start justify-between gap-4 px-4 py-3">
              <div className="min-w-0">
                <div className="font-medium">{job.name}</div>
                {job.description ? (
                  <p className="mt-0.5 text-sm text-muted-foreground">{job.description}</p>
                ) : null}
                <div className="mt-1.5 flex items-center gap-3 text-xs text-muted-foreground">
                  <span className="inline-flex items-center gap-1">
                    <Wrench className="h-3 w-3" />
                    {(job.defaultTools?.length ?? 0)} {(job.defaultTools?.length ?? 0) === 1 ? "tool" : "tools"}
                  </span>
                  <span className="inline-flex items-center gap-1">
                    <ShieldCheck className="h-3 w-3" />
                    {(job.defaultRights?.length ?? 0)} {(job.defaultRights?.length ?? 0) === 1 ? "right" : "rights"}
                  </span>
                </div>
              </div>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon-sm">
                    <MoreVertical className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onSelect={() => openEdit(job)}>
                    <Pencil className="mr-2 h-4 w-4" />
                    Edit
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => setDuplicatingJob(job)}>
                    <Copy className="mr-2 h-4 w-4" />
                    Duplicate to…
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => setDeletingJob(job)} variant="destructive">
                    <Trash2 className="mr-2 h-4 w-4" />
                    Delete
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </li>
          ))}
        </ul>
      )}

      <JobFormDialog
        open={formOpen}
        onOpenChange={(open) => {
          setFormOpen(open);
          if (!open) setEditingJobId(null);
        }}
        initialDraft={editingJob ? draftFromJob(editingJob) : emptyDraft()}
        title={editingJob ? "Edit job" : "New job"}
        onSubmit={handleSubmit}
        isPending={createJob.isPending || updateJob.isPending}
      />

      <AlertDialog open={deletingJob !== null} onOpenChange={(open) => !open && setDeletingJob(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete "{deletingJob?.name}"?</AlertDialogTitle>
            <AlertDialogDescription>
              Agents that were already assigned this job keep what they have. This only removes the job itself, so it can no
              longer be assigned to anyone new.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deletingJob && deleteJob.mutate(deletingJob.id)}
              disabled={deleteJob.isPending}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <DuplicateJobDialog
        job={duplicatingJob}
        onOpenChange={(open) => !open && setDuplicatingJob(null)}
        onConfirm={(targetCompanyId) =>
          duplicatingJob && duplicateJob.mutate({ id: duplicatingJob.id, targetCompanyId })
        }
        isPending={duplicateJob.isPending}
      />
    </div>
  );
}

function JobFormDialog({
  open,
  onOpenChange,
  initialDraft,
  title,
  onSubmit,
  isPending,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialDraft: JobDraft;
  title: string;
  onSubmit: (draft: JobDraft) => void;
  isPending: boolean;
}) {
  const [draft, setDraft] = useState<JobDraft>(initialDraft);

  useEffect(() => {
    if (open) setDraft(initialDraft);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const canSubmit = draft.name.trim().length > 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            Name and description are what people see. There's no internal ID to worry about.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <label className="text-xs text-muted-foreground">Name</label>
            <Input
              placeholder="e.g. Customer support rep"
              value={draft.name}
              onChange={(event) => setDraft((prev) => ({ ...prev, name: event.target.value }))}
              autoFocus
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-xs text-muted-foreground">Description</label>
            <Textarea
              placeholder="A short, plain-language description of what this job is for."
              value={draft.description}
              onChange={(event) => setDraft((prev) => ({ ...prev, description: event.target.value }))}
              rows={2}
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-xs text-muted-foreground">Starting instructions</label>
            <Textarea
              placeholder="The initial instructions an agent gets when it's assigned this job."
              value={draft.instructions}
              onChange={(event) => setDraft((prev) => ({ ...prev, instructions: event.target.value }))}
              rows={6}
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-xs text-muted-foreground">Default tools</label>
            <JobToolsPicker
              value={draft.defaultTools}
              onChange={(defaultTools) => setDraft((prev) => ({ ...prev, defaultTools }))}
              disabled={isPending}
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-xs text-muted-foreground">Default rights</label>
            <JobRightsPicker
              value={draft.defaultRights}
              onChange={(defaultRights) => setDraft((prev) => ({ ...prev, defaultRights }))}
              disabled={isPending}
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={isPending}>
            Cancel
          </Button>
          <Button onClick={() => onSubmit(draft)} disabled={!canSubmit || isPending}>
            {isPending ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DuplicateJobDialog({
  job,
  onOpenChange,
  onConfirm,
  isPending,
}: {
  job: Job | null;
  onOpenChange: (open: boolean) => void;
  onConfirm: (targetCompanyId: string) => void;
  isPending: boolean;
}) {
  const { companies, selectedCompanyId } = useCompany();
  const [targetCompanyId, setTargetCompanyId] = useState<string>("");
  const otherCompanies = useMemo(
    () => companies.filter((company) => company.id !== selectedCompanyId),
    [companies, selectedCompanyId],
  );

  useEffect(() => {
    if (job) setTargetCompanyId(otherCompanies[0]?.id ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job]);

  return (
    <Dialog open={job !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Copy "{job?.name}" to another company</DialogTitle>
          <DialogDescription>
            This makes a one-time copy. It will not stay in sync — editing one job later has no effect on the other.
          </DialogDescription>
        </DialogHeader>

        {otherCompanies.length === 0 ? (
          <p className="text-sm text-muted-foreground">You don't have any other companies to copy this into yet.</p>
        ) : (
          <Select value={targetCompanyId} onValueChange={setTargetCompanyId}>
            <SelectTrigger className="w-full">
              <SelectValue placeholder="Choose a company" />
            </SelectTrigger>
            <SelectContent>
              {otherCompanies.map((company) => (
                <SelectItem key={company.id} value={company.id}>
                  {company.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={isPending}>
            Cancel
          </Button>
          <Button
            onClick={() => targetCompanyId && onConfirm(targetCompanyId)}
            disabled={!targetCompanyId || isPending || otherCompanies.length === 0}
          >
            {isPending ? "Copying…" : "Copy"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function jobRightLabel(grant: RightGrant): string {
  return permissionLabel(grant.permissionKey);
}
