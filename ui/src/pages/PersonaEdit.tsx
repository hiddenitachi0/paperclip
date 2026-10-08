import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams } from "@/lib/router";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToastActions } from "../context/ToastContext";
import { personasApi } from "../api/personas";
import { ApiError } from "../api/client";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "@/components/ui/button";
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
import { PageSkeleton } from "../components/PageSkeleton";
import {
  PersonaFormFields,
  createInputFromDraft,
  draftFromPersona,
  emptyPersonaDraft,
  personaDraftChanged,
  updateInputFromDraft,
  type PersonaDraft,
} from "../components/PersonaForm";

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return fallback;
}

export const PERSONA_LEAVE_UNSAVED_MESSAGE = "Leave without saving? Your changes to this persona will be lost.";

/**
 * While the form has unsaved changes: the browser asks before the tab is
 * closed or reloaded, and a click on any link outside the form asks first
 * (the app's router cannot hold back a navigation on its own).
 */
function useUnsavedChangesGuard(dirty: boolean) {
  useEffect(() => {
    if (!dirty) return;
    const beforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    const linkClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) return;
      const anchor = (event.target as Element | null)?.closest?.("a[href]");
      if (!anchor || anchor.getAttribute("target") === "_blank") return;
      if (!window.confirm(PERSONA_LEAVE_UNSAVED_MESSAGE)) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    window.addEventListener("beforeunload", beforeUnload);
    document.addEventListener("click", linkClick, true);
    return () => {
      window.removeEventListener("beforeunload", beforeUnload);
      document.removeEventListener("click", linkClick, true);
    };
  }, [dirty]);
}

// A persona's own page for creating (/personas/new) or editing
// (/personas/:personaId/edit) it. It used to be a dialog; as a page the
// "Ask Paperclip" helper can be opened next to it and can fill traits,
// backstory and voice (see PersonaForm.tsx). Nothing is saved until Save.
export function PersonaEdit() {
  const { personaId } = useParams<{ personaId?: string }>();
  const isEditing = Boolean(personaId);
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToastActions();
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const personaQuery = useQuery({
    queryKey: personaId ? queryKeys.personas.detail(personaId) : ["personas", "detail", "__none__"],
    queryFn: () => personasApi.get(personaId!),
    enabled: isEditing,
  });
  const persona = personaQuery.data;

  // The draft starts from the persona once it has loaded, and is not reset
  // by a later refetch (that would wipe what the person is typing).
  const [initial, setInitial] = useState<PersonaDraft | null>(isEditing ? null : emptyPersonaDraft());
  const [draft, setDraft] = useState<PersonaDraft>(emptyPersonaDraft());
  useEffect(() => {
    if (!persona || initial) return;
    const loaded = draftFromPersona(persona);
    setInitial(loaded);
    setDraft(loaded);
  }, [persona, initial]);

  const [saved, setSaved] = useState(false);
  const dirty = useMemo(() => !saved && initial !== null && personaDraftChanged(draft, initial), [draft, initial, saved]);
  useUnsavedChangesGuard(dirty);
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  const displayName = persona?.displayName ?? "Persona";
  useEffect(() => {
    setBreadcrumbs(
      isEditing
        ? [
            { label: "Personas", href: "/personas" },
            { label: displayName, href: `/personas/${personaId}` },
            { label: "Edit" },
          ]
        : [{ label: "Personas", href: "/personas" }, { label: "New persona" }],
    );
  }, [setBreadcrumbs, isEditing, displayName, personaId]);

  const invalidate = (id: string) => {
    queryClient.invalidateQueries({ queryKey: queryKeys.personas.detail(id) });
    if (selectedCompanyId) {
      queryClient.invalidateQueries({ queryKey: queryKeys.personas.list(selectedCompanyId) });
      // Agent rows carry a persona summary; a rename or new picture shows there too.
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.list(selectedCompanyId) });
    }
  };

  const save = useMutation({
    mutationFn: (next: PersonaDraft) =>
      isEditing
        ? personasApi.update(personaId!, updateInputFromDraft(next))
        : personasApi.create(selectedCompanyId!, createInputFromDraft(next)),
    onSuccess: (result) => {
      setSaved(true);
      invalidate(result.id);
      pushToast({ title: isEditing ? "Persona saved" : "Persona created", tone: "success" });
      navigate(`/personas/${result.id}`);
    },
    onError: (error) =>
      pushToast({
        title: isEditing ? "Could not save persona" : "Could not create persona",
        body: errorMessage(error, ""),
        tone: "error",
      }),
  });

  const backTo = isEditing ? `/personas/${personaId}` : "/personas";
  const nameMissing = draft.displayName.trim().length === 0;
  const canSave = !nameMissing && !save.isPending && (isEditing ? dirty : true);

  function cancel() {
    if (dirty) setConfirmDiscard(true);
    else navigate(backTo);
  }

  if (isEditing && personaQuery.isLoading) return <PageSkeleton variant="detail" />;
  if (isEditing && (personaQuery.error || !persona)) {
    return <p className="py-6 text-sm text-destructive">Could not load this persona.</p>;
  }

  return (
    <div
      className="mx-auto max-w-2xl space-y-6"
      data-testid="persona-edit-page"
      {...(isEditing ? { "data-helper-entity": `persona:${personaId}` } : {})}
    >
      <div>
        <h1 className="text-lg font-semibold">{isEditing ? `Edit ${displayName}` : "New persona"}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {isEditing
            ? "Name, pronouns, face, backstory and voice -- the things that make this persona recognisable."
            : "A person, not a job. Create the persona here, then attach it to one or more agents from its page or from an agent's settings."}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          Tip: open Ask Paperclip to get help writing the traits, backstory or voice, then apply its answer to the
          field. Nothing is saved until you press Save.
        </p>
      </div>

      <form
        className="space-y-6"
        onSubmit={(event) => {
          event.preventDefault();
          if (canSave) save.mutate(draft);
        }}
      >
        <PersonaFormFields draft={draft} setDraft={setDraft} isPending={save.isPending} />

        {nameMissing ? (
          <p className="text-xs text-muted-foreground" data-testid="persona-name-required">
            Give the persona a name to save it.
          </p>
        ) : null}

        <div className="flex items-center justify-end gap-2 border-t border-border pt-4">
          {dirty ? <span className="mr-auto text-xs text-muted-foreground">Unsaved changes</span> : null}
          <Button type="button" variant="ghost" onClick={cancel} disabled={save.isPending}>
            Cancel
          </Button>
          <Button type="submit" disabled={!canSave}>
            {save.isPending ? "Saving…" : "Save"}
          </Button>
        </div>
      </form>

      <AlertDialog open={confirmDiscard} onOpenChange={setConfirmDiscard}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard your changes?</AlertDialogTitle>
            <AlertDialogDescription>
              What you changed on this persona has not been saved. If you leave now, it is lost.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep editing</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setSaved(true);
                navigate(backTo);
              }}
            >
              Discard changes
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
