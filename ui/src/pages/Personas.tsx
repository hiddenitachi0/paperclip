import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@/lib/router";
import { MoreVertical, Pause, Pencil, Play, Plus, Trash2, UserRound } from "lucide-react";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToastActions } from "../context/ToastContext";
import { personasApi, type Persona } from "../api/personas";
import { ApiError } from "../api/client";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
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
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";
import { PersonaAvatar } from "../components/PersonaAvatar";
import {
  PersonaFormDialog,
  createInputFromDraft,
  draftFromPersona,
  emptyPersonaDraft,
  updateInputFromDraft,
  type PersonaDraft,
} from "../components/PersonaFormDialog";

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return fallback;
}

/** "No job yet" / "1 job" / "3 jobs" -- how many agents this persona works as. */
export function describePersonaJobs(agentIds: string[]): string {
  if (agentIds.length === 0) return "No job yet";
  return agentIds.length === 1 ? "1 job" : `${agentIds.length} jobs`;
}

// DUR-184 item 14 / DUR-4000: the Personas page -- list, create, edit. A
// persona is a person and is created on its own; the jobs it holds are
// attached from its page (PersonaDetail) or from an agent's settings.
// Deliberately does NOT include a global posting-mode toggle: per-account
// disclosure/autonomy settings attach per DUR-134 on the persona page once a
// persona has a connected account to post through. Pausing here stops the
// persona's publish queue without touching its identity or the run history
// of the jobs it holds.
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

  const invalidatePersonas = () => {
    if (selectedCompanyId) {
      queryClient.invalidateQueries({ queryKey: queryKeys.personas.list(selectedCompanyId) });
      // Agent rows carry a persona summary; a rename or new picture shows there too.
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(selectedCompanyId) });
    }
  };

  const createPersona = useMutation({
    mutationFn: (draft: PersonaDraft) => personasApi.create(selectedCompanyId!, createInputFromDraft(draft)),
    onSuccess: () => {
      invalidatePersonas();
      setFormOpen(false);
      pushToast({ title: "Persona created", tone: "success" });
    },
    onError: (error) => pushToast({ title: "Could not create persona", body: errorMessage(error, ""), tone: "error" }),
  });

  const updatePersona = useMutation({
    mutationFn: ({ id, draft }: { id: string; draft: PersonaDraft }) =>
      personasApi.update(id, updateInputFromDraft(draft)),
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
            A persona is a person: a name, a face, a backstory and a way of writing. An agent is a job. Attach a
            persona to a job and that agent works as that person -- the same persona can hold several jobs.
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
          message="No personas yet. Create one to give a job a name, a face and a voice of its own."
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
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{persona.displayName}</span>
                    {persona.pronouns ? (
                      <span className="text-xs text-muted-foreground">{persona.pronouns}</span>
                    ) : null}
                    {persona.status === "paused" ? <Badge variant="secondary">Paused</Badge> : null}
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {persona.handle ? `@${persona.handle} · ` : ""}
                    {describePersonaJobs(persona.agentIds)}
                  </p>
                </div>
              </Link>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${persona.displayName}`}>
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
        initialDraft={editingPersona ? draftFromPersona(editingPersona) : emptyPersonaDraft()}
        title={editingPersona ? "Edit persona" : "New persona"}
        isEditing={Boolean(editingPersona)}
        onSubmit={handleSubmit}
        isPending={createPersona.isPending || updatePersona.isPending}
      />

      <AlertDialog open={deletingPersona !== null} onOpenChange={(open) => !open && setDeletingPersona(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete "{deletingPersona?.displayName}"?</AlertDialogTitle>
            <AlertDialogDescription>
              This removes the person -- name, face, backstory, voice. The jobs {deletingPersona?.displayName ?? "this persona"}{" "}
              holds are kept, with their run history and budget; they simply no longer have a persona attached.
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
