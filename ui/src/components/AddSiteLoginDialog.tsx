import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ApiError } from "../api/client";
import { secretsApi } from "../api/secrets";
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
 * Connections → "Add website login" (DUR-4020). The username and password go
 * into the secret's opaque `value` (never re-displayed); the site is not
 * secret on its own, so it is kept in `providerMetadata` for the list.
 */
export function AddSiteLoginDialog({
  open,
  onOpenChange,
  companyId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  companyId: string;
}) {
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const [label, setLabel] = useState("");
  const [site, setSite] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setLabel("");
    setSite("");
    setUsername("");
    setPassword("");
    setError(null);
  };

  const canSubmit =
    label.trim().length > 0 && site.trim().length > 0 && username.trim().length > 0 && password.length > 0;

  const mutation = useMutation({
    mutationFn: () =>
      secretsApi.create(companyId, {
        name: label.trim(),
        kind: "site_login",
        value: JSON.stringify({ username: username.trim(), password }),
        providerMetadata: { site: site.trim() },
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.secrets.list(companyId) });
      pushToast({ title: "Website login saved", tone: "success" });
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
          <DialogTitle>Add website login</DialogTitle>
          <DialogDescription>
            Save the sign-in for an account you already have, so an agent can log in as you on a site you've
            approved. It never sees the password after this — only Paperclip does. If the site asks for 2FA or
            BankID, that always goes to you, never the agent.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="login-label">Label</Label>
            <Input
              id="login-label"
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              placeholder="E.g. Hotel account"
              maxLength={120}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="login-site">Site</Label>
            <Input
              id="login-site"
              value={site}
              onChange={(event) => setSite(event.target.value)}
              placeholder="example.com"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="login-username">Username</Label>
            <Input
              id="login-username"
              autoComplete="off"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="login-password">Password</Label>
            <Input
              id="login-password"
              type="password"
              autoComplete="off"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </div>

          <p className="text-xs text-muted-foreground">
            The password is never shown again once saved — only the label and site.
          </p>

          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={mutation.isPending}>
            Cancel
          </Button>
          <Button onClick={() => mutation.mutate()} disabled={!canSubmit || mutation.isPending}>
            {mutation.isPending ? "Saving…" : "Save login"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
