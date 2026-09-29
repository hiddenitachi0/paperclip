import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2, KeyRound } from "lucide-react";
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

interface AddSiteLoginDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  companyId: string;
}

/** A bare domain, no scheme and no path — e.g. "example.com", not "https://example.com/login". */
const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

/**
 * "Add website login" — a saved username and password an agent with browser
 * access may sign in with. Stored as an ordinary company secret (kind
 * `site_login`), with domain/username/password packed into the secret's one
 * encrypted value field, same as the payment card form — see that file and
 * DUR-4015 for why this needed no server change for this step.
 *
 * The password is never shown again once saved — only the label and the
 * website appear in Connections afterwards. Paperclip fills it in only on
 * the matching website, and never shows it to the agent.
 */
export function AddSiteLoginDialog({ open, onOpenChange, companyId }: AddSiteLoginDialogProps) {
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const [label, setLabel] = useState("");
  const [domain, setDomain] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [touched, setTouched] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const domainValid = DOMAIN_RE.test(domain.trim());
  const domainError = touched && domain.trim().length > 0 && !domainValid
    ? "Enter just the website, like example.com — no https:// or page path."
    : null;

  const canSubmit =
    label.trim().length > 0 && domainValid && username.trim().length > 0 && password.length > 0;

  function reset() {
    setLabel("");
    setDomain("");
    setUsername("");
    setPassword("");
    setTouched(false);
    setError(null);
  }

  const mutation = useMutation({
    mutationFn: () => {
      const value = JSON.stringify({
        domain: domain.trim().toLowerCase(),
        username: username.trim(),
        password,
      });
      return secretsApi.create(companyId, {
        name: `${label.trim()} (${domain.trim().toLowerCase()})`,
        value,
        kind: "site_login",
        provider: "local_encrypted",
        description: "A saved website login an agent with browser access may sign in with.",
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.secrets.list(companyId) });
      pushToast({ title: "Login saved", tone: "success" });
      reset();
      onOpenChange(false);
    },
    onError: (err) => {
      setError(err instanceof ApiError ? err.message : "Could not save the login");
    },
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <KeyRound className="h-4 w-4" /> Add website login
          </DialogTitle>
          <DialogDescription>
            Lets an agent with browser access sign in on your behalf. Once saved, the password is never shown again —
            only the label and website appear afterwards.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="login-label">Label</Label>
            <Input
              id="login-label"
              placeholder="e.g. Foodora account"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="login-domain">Website</Label>
            <Input
              id="login-domain"
              placeholder="example.com"
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
              onBlur={() => setTouched(true)}
              aria-invalid={domainError !== null}
            />
            {domainError && <p className="text-xs text-destructive">{domainError}</p>}
            <p className="text-xs text-muted-foreground">
              This login is only ever used on this website, never anywhere else.
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="login-username">Username or email</Label>
            <Input
              id="login-username"
              autoComplete="off"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="login-password">Password</Label>
            <Input
              id="login-password"
              type="password"
              autoComplete="off"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={mutation.isPending}>
            Cancel
          </Button>
          <Button onClick={() => mutation.mutate()} disabled={!canSubmit || mutation.isPending}>
            {mutation.isPending && <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" />}
            Save login
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
