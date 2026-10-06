import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { CompanySecret } from "@paperclipai/shared";
import { Loader2 } from "lucide-react";
import { secretsApi } from "../api/secrets";
import { ApiError } from "../api/client";
import { queryKeys } from "../lib/queryKeys";
import { useToastActions } from "../context/ToastContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * DUR-4448: one-step "connect Hugging Face".
 *
 * The server checks the token with Hugging Face BEFORE it stores anything
 * (create and replace both do), so this dialog only has to show what came
 * back: a refused token (422) reads as "that token did not work", Hugging
 * Face being down (503) reads as "try again", and success only appears once
 * the server has accepted and saved the token.
 *
 * The token lives only in this input's state. It is never put in a toast,
 * an error message, a query key or the console, and it is cleared the
 * moment the dialog closes. The server stores it as a company secret; no
 * agent is changed.
 *
 * Later: if Hugging Face offers "Sign in with Hugging Face" for inference,
 * replace the paste field with that button. Everything outside the input
 * (the secret kind, the checking, the toasts) can stay as it is.
 */

const TOKENS_URL = "https://huggingface.co/settings/tokens";
const SIGN_UP_URL = "https://huggingface.co/join";

export function huggingFaceErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 503) return "Could not reach Hugging Face. Try again in a minute.";
    if (error.status === 422 || error.status === 401 || error.status === 403) {
      return error.message || "Hugging Face did not accept that token. Check it and try again.";
    }
  }
  return "Could not save the token. Try again.";
}

export function HuggingFaceConnectDialog({
  open,
  onOpenChange,
  companyId,
  existing,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  companyId: string;
  /** The company's current Hugging Face token, if any; it is replaced, not duplicated. */
  existing: CompanySecret | null;
}) {
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);

  function close() {
    setToken("");
    setError(null);
    onOpenChange(false);
  }

  const mutation = useMutation({
    mutationFn: async () => {
      const value = token.trim();
      if (existing) return secretsApi.rotate(existing.id, { value });
      return secretsApi.create(companyId, {
        name: "Hugging Face token",
        key: "hf_token",
        provider: "local_encrypted",
        value,
        description: "Lets quick agents use models from Hugging Face.",
        kind: "huggingface_api_key",
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.secrets.list(companyId) });
      pushToast({ tone: "success", title: "Hugging Face is connected" });
      close();
    },
    onError: (e) => setError(huggingFaceErrorMessage(e)),
  });

  const canSave = token.trim().length > 0 && !mutation.isPending;

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{existing ? "Replace your Hugging Face token" : "Connect Hugging Face"}</DialogTitle>
          <DialogDescription>
            Hugging Face gives quick agents access to thousands of models. You need a free account and one token.
          </DialogDescription>
        </DialogHeader>

        <ol className="list-decimal space-y-1.5 pl-5 text-sm" data-testid="hf-guide">
          <li>
            Make a Hugging Face account if you do not have one.{" "}
            <a className="underline" href={SIGN_UP_URL} target="_blank" rel="noreferrer">
              Open the sign-up page
            </a>
          </li>
          <li>
            <a className="underline" href={TOKENS_URL} target="_blank" rel="noreferrer">
              Open your token page
            </a>{" "}
            (Settings, then Access Tokens) and choose to create a new token.
          </li>
          <li>Pick the "Fine-grained" type.</li>
          <li>Tick only "Make calls to Inference Providers". Leave everything else unticked.</li>
          <li>Copy the token and paste it below.</li>
        </ol>

        <div className="space-y-1.5">
          <Label htmlFor="hf-token">Your Hugging Face token</Label>
          <Input
            id="hf-token"
            type="password"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            data-1p-ignore
            data-lpignore="true"
            placeholder="Paste the token here"
            value={token}
            onChange={(e) => {
              setToken(e.target.value);
              setError(null);
            }}
            aria-invalid={error !== null}
          />
          <p className="text-xs text-muted-foreground">
            Paperclip checks it with Hugging Face before saving. After that it is never shown again.
          </p>
          {error && (
            <p role="alert" className="text-sm text-destructive" data-testid="hf-error">
              {error}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={close} disabled={mutation.isPending}>
            Cancel
          </Button>
          <Button onClick={() => mutation.mutate()} disabled={!canSave}>
            {mutation.isPending && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
            {mutation.isPending ? "Checking…" : "Check and save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
