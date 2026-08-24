import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@/lib/router";
import { MoreVertical, Pause, Pencil, Play, Plus, Trash2, Upload, UserRound } from "lucide-react";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToastActions } from "../context/ToastContext";
import { personasApi, type Persona } from "../api/personas";
import { agentsApi } from "../api/agents";
import { assetsApi } from "../api/assets";
import { ApiError } from "../api/client";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
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
import { PersonaAvatar } from "../components/PersonaAvatar";
import { PersonaMcpToolsPanel } from "../components/PersonaMcpToolsPanel";

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return fallback;
}

type PersonaDraft = {
  agentId: string;
  displayName: string;
  handle: string;
  bio: string;
  voice: string;
  avatarAssetId: string;
};

function emptyDraft(): PersonaDraft {
  return { agentId: "", displayName: "", handle: "", bio: "", voice: "", avatarAssetId: "" };
}

function draftFromPersona(persona: Persona): PersonaDraft {
  return {
    agentId: persona.agentId,
    displayName: persona.displayName,
    handle: persona.handle ?? "",
    bio: persona.bio ?? "",
    voice: persona.voice ?? "",
    avatarAssetId: persona.avatarAssetId ?? "",
  };
}

// DUR-184 item 14: the Personas page -- list, create, edit. Deliberately does
// NOT include a global posting-mode toggle: per-account disclosure/autonomy
// settings attach later per DUR-134, once a persona actually has a connected
// account/channel to post through. Pausing here (item 14's "disconnect/
// delete/pause") stops her generation queue without touching her identity or
// her underlying agent's run history.
export function Personas() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToastActions();
  const queryClient = useQueryClient();

  const [formOpen, setFormOpen] = useState(false);
  const [editingPersonaId, setEditingPersonaId] = useState<string | null>(null);
  const [deletingPersona, setDeletingPersona] = useState<Persona | null>(null);

  useEffect(() => {
    setBreadcrumbs([{ label: "Personas" }]);
  }, [setBreadcrumbs]);

  const personasQuery = useQuery({
    queryKey: selectedCompanyId ? queryKeys.personas.list(selectedCompanyId) : ["personas", "__none__"],
    queryFn: () => personasApi.list(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });
  const personas = personasQuery.data ?? [];

  const agentsQuery = useQuery({
    queryKey: selectedCompanyId ? queryKeys.agents.list(selectedCompanyId) : ["agents", "__none__"],
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId) && formOpen,
  });

  const invalidatePersonas = () => {
    if (selectedCompanyId) {
      queryClient.invalidateQueries({ queryKey: queryKeys.personas.list(selectedCompanyId) });
    }
  };

  const createPersona = useMutation({
    mutationFn: (draft: PersonaDraft) =>
      personasApi.create(selectedCompanyId!, {
        agentId: draft.agentId,
        displayName: draft.displayName.trim(),
        handle: draft.handle.trim() || undefined,
        bio: draft.bio.trim() || undefined,
        voice: draft.voice.trim() || undefined,
        avatarAssetId: draft.avatarAssetId || undefined,
      }),
    onSuccess: () => {
      invalidatePersonas();
      setFormOpen(false);
      pushToast({ title: "Persona created", tone: "success" });
    },
    onError: (error) => pushToast({ title: "Could not create persona", body: errorMessage(error, ""), tone: "error" }),
  });

  const updatePersona = useMutation({
    mutationFn: ({ id, draft }: { id: string; draft: PersonaDraft }) =>
      personasApi.update(id, {
        displayName: draft.displayName.trim(),
        handle: draft.handle.trim() || null,
        bio: draft.bio.trim() || null,
        voice: draft.voice.trim() || null,
        avatarAssetId: draft.avatarAssetId || null,
      }),
    onSuccess: () => {
      invalidatePersonas();
      setFormOpen(false);
      setEditingPersonaId(null);
      pushToast({ title: "Persona saved", tone: "success" });
    },
    onError: (error) => pushToast({ title: "Could not save persona", body: errorMessage(error, ""), tone: "error" }),
  });

  const setStatus = useMutation({
    mutationFn: ({ id, status }: { id: string; status: "active" | "paused" }) =>
      personasApi.update(id, { status }),
    onSuccess: (_persona, { status }) => {
      invalidatePersonas();
      pushToast({ title: status === "paused" ? "Persona paused" : "Persona resumed", tone: "success" });
    },
    onError: (error) => pushToast({ title: "Could not change status", body: errorMessage(error, ""), tone: "error" }),
  });

  const deletePersona = useMutation({
    mutationFn: (id: string) => personasApi.remove(id),
    onSuccess: () => {
      invalidatePersonas();
      setDeletingPersona(null);
      pushToast({ title: "Persona deleted", tone: "success" });
    },
    onError: (error) => pushToast({ title: "Could not delete persona", body: errorMessage(error, ""), tone: "error" }),
  });

  const editingPersona = personas.find((persona) => persona.id === editingPersonaId) ?? null;
  const availableAgents = (agentsQuery.data ?? []).filter(
    (agent) => !personas.some((persona) => persona.agentId === agent.id && persona.id !== editingPersonaId),
  );

  function openCreate() {
    setEditingPersonaId(null);
    setFormOpen(true);
  }

  function openEdit(persona: Persona) {
    setEditingPersonaId(persona.id);
    setFormOpen(true);
  }

  function handleSubmit(draft: PersonaDraft) {
    if (editingPersonaId) {
      updatePersona.mutate({ id: editingPersonaId, draft });
    } else {
      createPersona.mutate(draft);
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold">Personas</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            A persona is who an agent is to the outside world -- her name, her face, how she writes. Give an
            agent a persona to have her make and share her own pictures.
          </p>
        </div>
        <Button onClick={openCreate}>
          <Plus className="mr-1.5 h-3.5 w-3.5" />
          New persona
        </Button>
      </div>

      {personasQuery.isLoading ? (
        <PageSkeleton variant="list" />
      ) : personasQuery.error ? (
        <div className="py-6 text-sm text-destructive">{errorMessage(personasQuery.error, "Could not load personas.")}</div>
      ) : personas.length === 0 ? (
        <EmptyState
          icon={UserRound}
          message="No personas yet. Create one to give an agent a name, a face, and her own picture tools."
          action="New persona"
          onAction={openCreate}
        />
      ) : (
        <ul className="divide-y divide-border border border-border rounded-lg">
          {personas.map((persona) => (
            <li key={persona.id} className="flex items-start justify-between gap-4 px-4 py-3">
              <Link to={`/personas/${persona.id}`} className="flex min-w-0 items-start gap-3 text-inherit no-underline">
                <PersonaAvatar persona={persona} size="sm" />
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{persona.displayName}</span>
                    {persona.status === "paused" ? <Badge variant="secondary">Paused</Badge> : null}
                  </div>
                  {persona.handle ? <p className="text-sm text-muted-foreground">@{persona.handle}</p> : null}
                </div>
              </Link>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon-sm">
                    <MoreVertical className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onSelect={() => openEdit(persona)}>
                    <Pencil className="mr-2 h-4 w-4" />
                    Edit
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onSelect={() =>
                      setStatus.mutate({ id: persona.id, status: persona.status === "active" ? "paused" : "active" })
                    }
                  >
                    {persona.status === "active" ? (
                      <>
                        <Pause className="mr-2 h-4 w-4" />
                        Pause
                      </>
                    ) : (
                      <>
                        <Play className="mr-2 h-4 w-4" />
                        Resume
                      </>
                    )}
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => setDeletingPersona(persona)} variant="destructive">
                    <Trash2 className="mr-2 h-4 w-4" />
                    Delete
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </li>
          ))}
        </ul>
      )}

      <PersonaFormDialog
        open={formOpen}
        onOpenChange={(open) => {
          setFormOpen(open);
          if (!open) setEditingPersonaId(null);
        }}
        initialDraft={editingPersona ? draftFromPersona(editingPersona) : emptyDraft()}
        title={editingPersona ? "Edit persona" : "New persona"}
        isEditing={Boolean(editingPersona)}
        availableAgents={availableAgents}
        agentsLoading={agentsQuery.isLoading}
        onSubmit={handleSubmit}
        isPending={createPersona.isPending || updatePersona.isPending}
      />

      <AlertDialog open={deletingPersona !== null} onOpenChange={(open) => !open && setDeletingPersona(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete "{deletingPersona?.displayName}"?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes her identity -- name, face, bio, voice. It never touches her underlying agent, its run
              history, or its budget.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deletingPersona && deletePersona.mutate(deletingPersona.id)}
              disabled={deletePersona.isPending}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function PersonaFormDialog({
  open,
  onOpenChange,
  initialDraft,
  title,
  isEditing,
  availableAgents,
  agentsLoading,
  onSubmit,
  isPending,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialDraft: PersonaDraft;
  title: string;
  isEditing: boolean;
  availableAgents: { id: string; name: string }[];
  agentsLoading: boolean;
  onSubmit: (draft: PersonaDraft) => void;
  isPending: boolean;
}) {
  const { selectedCompanyId } = useCompany();
  const { pushToast } = useToastActions();
  const [draft, setDraft] = useState<PersonaDraft>(initialDraft);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) setDraft(initialDraft);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const canSubmit = draft.displayName.trim().length > 0 && (isEditing || draft.agentId.length > 0);

  async function handleFileChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file || !selectedCompanyId) return;
    setUploading(true);
    try {
      const asset = await assetsApi.uploadImage(selectedCompanyId, file, "personas");
      setDraft((prev) => ({ ...prev, avatarAssetId: asset.assetId }));
    } catch (error) {
      pushToast({ title: "Could not upload picture", body: errorMessage(error, ""), tone: "error" });
    } finally {
      setUploading(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {isEditing
              ? "Her name, face, bio, and voice -- the things that make her recognizable."
              : "Pick an existing agent to give a persona to. Her identity lives here; her budget and adapter stay on the agent."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="flex items-center gap-3">
            <PersonaAvatar persona={draft} size="lg" />
            <div className="space-y-1">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => fileInputRef.current?.click()}
                disabled={isPending || uploading}
              >
                <Upload className="mr-1.5 h-3.5 w-3.5" />
                {uploading ? "Uploading…" : "Upload picture"}
              </Button>
              <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={handleFileChange} />
              <p className="text-xs text-muted-foreground">Optional. Shown wherever she's mentioned.</p>
            </div>
          </div>

          {!isEditing && (
            <div className="space-y-1.5">
              <label className="text-xs text-muted-foreground">Agent</label>
              <Select
                value={draft.agentId}
                onValueChange={(agentId) => setDraft((prev) => ({ ...prev, agentId }))}
                disabled={isPending || agentsLoading}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder={agentsLoading ? "Loading agents…" : "Pick an agent"} />
                </SelectTrigger>
                <SelectContent>
                  {availableAgents.length === 0 ? (
                    <div className="px-2 py-1.5 text-xs text-muted-foreground">
                      No agents without a persona yet. Every agent already has one, or there are no agents.
                    </div>
                  ) : (
                    availableAgents.map((agent) => (
                      <SelectItem key={agent.id} value={agent.id}>
                        {agent.name}
                      </SelectItem>
                    ))
                  )}
                </SelectContent>
              </Select>
            </div>
          )}

          <div className="space-y-1.5">
            <label className="text-xs text-muted-foreground">Name</label>
            <Input
              placeholder="e.g. Maja"
              value={draft.displayName}
              onChange={(event) => setDraft((prev) => ({ ...prev, displayName: event.target.value }))}
              disabled={isPending}
              autoFocus={isEditing}
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-xs text-muted-foreground">Handle (optional)</label>
            <Input
              placeholder="e.g. maja"
              value={draft.handle}
              onChange={(event) => setDraft((prev) => ({ ...prev, handle: event.target.value }))}
              disabled={isPending}
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-xs text-muted-foreground">Who she is (optional)</label>
            <Textarea
              placeholder="Backstory, age, interests -- whatever makes her feel like someone."
              value={draft.bio}
              onChange={(event) => setDraft((prev) => ({ ...prev, bio: event.target.value }))}
              rows={3}
              disabled={isPending}
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-xs text-muted-foreground">How she writes (optional)</label>
            <Textarea
              placeholder="Tone, vocabulary, things she'd never say."
              value={draft.voice}
              onChange={(event) => setDraft((prev) => ({ ...prev, voice: event.target.value }))}
              rows={3}
              disabled={isPending}
            />
          </div>

          {draft.agentId && (
            <div className="space-y-1.5">
              <label className="text-xs text-muted-foreground">Picture tools</label>
              <PersonaMcpToolsPanel agentId={draft.agentId} />
            </div>
          )}
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
