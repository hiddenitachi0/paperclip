import { useEffect, useRef, useState } from "react";
import { Upload } from "lucide-react";
import { useCompany } from "../context/CompanyContext";
import { useToastActions } from "../context/ToastContext";
import type { CreatePersonaInput, Persona, UpdatePersonaInput } from "../api/personas";
import { assetsApi } from "../api/assets";
import { ApiError } from "../api/client";
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
import { PersonaAvatar } from "./PersonaAvatar";

// DUR-4000: the one place a persona -- a person -- is created or edited. No
// agent is picked here: a persona exists on its own and is attached to jobs
// (agents) afterwards, from the persona page or the agent's settings. Used by
// the Personas list (create + edit) and the persona page (edit).

export type PersonaDraft = {
  displayName: string;
  pronouns: string;
  handle: string;
  traits: string;
  backstory: string;
  voice: string;
  avatarAssetId: string;
};

export function emptyPersonaDraft(): PersonaDraft {
  return { displayName: "", pronouns: "", handle: "", traits: "", backstory: "", voice: "", avatarAssetId: "" };
}

export function draftFromPersona(persona: Persona): PersonaDraft {
  return {
    displayName: persona.displayName,
    pronouns: persona.pronouns ?? "",
    handle: persona.handle ?? "",
    traits: persona.traits ?? "",
    backstory: persona.backstory ?? "",
    voice: persona.voice ?? "",
    avatarAssetId: persona.avatarAssetId ?? "",
  };
}

/** What a new persona sends: blanks are left out. */
export function createInputFromDraft(draft: PersonaDraft): CreatePersonaInput {
  return {
    displayName: draft.displayName.trim(),
    pronouns: draft.pronouns.trim() || undefined,
    handle: draft.handle.trim() || undefined,
    traits: draft.traits.trim() || undefined,
    backstory: draft.backstory.trim() || undefined,
    voice: draft.voice.trim() || undefined,
    avatarAssetId: draft.avatarAssetId || undefined,
    status: "active",
  };
}

/** What an edit sends: blanks clear the field. */
export function updateInputFromDraft(draft: PersonaDraft): UpdatePersonaInput {
  return {
    displayName: draft.displayName.trim(),
    pronouns: draft.pronouns.trim() || null,
    handle: draft.handle.trim() || null,
    traits: draft.traits.trim() || null,
    backstory: draft.backstory.trim() || null,
    voice: draft.voice.trim() || null,
    avatarAssetId: draft.avatarAssetId || null,
  };
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return fallback;
}

export function PersonaFormDialog({
  open,
  onOpenChange,
  initialDraft,
  title,
  isEditing,
  onSubmit,
  isPending,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialDraft: PersonaDraft;
  title: string;
  isEditing: boolean;
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

  const canSubmit = draft.displayName.trim().length > 0;
  const name = draft.displayName.trim() || "this persona";

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
              ? "Name, pronouns, face, backstory and voice -- the things that make this persona recognisable."
              : "A person, not a job. Create the persona here, then attach it to one or more agents from its page or from an agent's settings."}
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
              <p className="text-xs text-muted-foreground">Optional. Shown wherever {name} is mentioned.</p>
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-[1fr_minmax(0,9rem)]">
            <div className="space-y-1.5">
              <label htmlFor="persona-name" className="text-xs text-muted-foreground">
                Name
              </label>
              <Input
                id="persona-name"
                placeholder="e.g. Maja"
                value={draft.displayName}
                onChange={(event) => setDraft((prev) => ({ ...prev, displayName: event.target.value }))}
                disabled={isPending}
                autoFocus
              />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="persona-pronouns" className="text-xs text-muted-foreground">
                Pronouns (optional)
              </label>
              <Input
                id="persona-pronouns"
                placeholder="they/them"
                value={draft.pronouns}
                onChange={(event) => setDraft((prev) => ({ ...prev, pronouns: event.target.value }))}
                disabled={isPending}
                maxLength={40}
              />
            </div>
          </div>
          <p className="-mt-2 text-xs text-muted-foreground">
            Pronouns are free text: she/her, he/him, they/them, or whatever fits. Nothing is assumed when left blank.
          </p>

          <div className="space-y-1.5">
            <label htmlFor="persona-handle" className="text-xs text-muted-foreground">
              Handle (optional)
            </label>
            <Input
              id="persona-handle"
              placeholder="e.g. maja"
              value={draft.handle}
              onChange={(event) => setDraft((prev) => ({ ...prev, handle: event.target.value }))}
              disabled={isPending}
            />
          </div>

          <div className="space-y-1.5">
            <label htmlFor="persona-traits" className="text-xs text-muted-foreground">
              Traits (optional)
            </label>
            <Textarea
              id="persona-traits"
              placeholder="A few words or lines on character: curious, dry humour, never rushes an answer."
              value={draft.traits}
              onChange={(event) => setDraft((prev) => ({ ...prev, traits: event.target.value }))}
              rows={2}
              disabled={isPending}
            />
          </div>

          <div className="space-y-1.5">
            <label htmlFor="persona-backstory" className="text-xs text-muted-foreground">
              Who they are (optional)
            </label>
            <Textarea
              id="persona-backstory"
              placeholder="Backstory, age, interests -- whatever makes this persona feel like someone."
              value={draft.backstory}
              onChange={(event) => setDraft((prev) => ({ ...prev, backstory: event.target.value }))}
              rows={3}
              disabled={isPending}
            />
          </div>

          <div className="space-y-1.5">
            <label htmlFor="persona-voice" className="text-xs text-muted-foreground">
              How they write (optional)
            </label>
            <Textarea
              id="persona-voice"
              placeholder="Tone, vocabulary, things this persona would never say."
              value={draft.voice}
              onChange={(event) => setDraft((prev) => ({ ...prev, voice: event.target.value }))}
              rows={3}
              disabled={isPending}
              maxLength={600}
            />
            <p className="text-xs text-muted-foreground">
              A few sentences. On every job this persona holds, this replaces the agent's own tone.
            </p>
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
