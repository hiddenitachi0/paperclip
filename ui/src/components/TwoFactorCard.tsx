import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, LoaderCircle, ShieldCheck } from "lucide-react";
import { twoFactorApi, type TwoFactorEnrollStart } from "../api/twoFactor";
import { describeTwoFactorFailure } from "../lib/two-factor-copy";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { BackupCodesPanel } from "./BackupCodesPanel";
import { QrCode } from "./QrCode";
import { TwoFactorCodeField } from "./TwoFactorCodeField";

type View =
  | { kind: "closed" }
  | { kind: "setup"; start: TwoFactorEnrollStart }
  | { kind: "setup-done"; codes: string[] }
  | { kind: "renew" }
  | { kind: "renew-done"; codes: string[] }
  | { kind: "turn-off" };

function formatDate(iso: string | null) {
  if (!iso) return null;
  return new Date(iso).toLocaleDateString([], { year: "numeric", month: "long", day: "numeric" });
}

/**
 * Settings card for two-step sign-in. It hides itself completely while the feature is
 * switched off on the server.
 */
export function TwoFactorCard() {
  const queryClient = useQueryClient();
  const [view, setView] = useState<View>({ kind: "closed" });
  const [pageError, setPageError] = useState<string | null>(null);
  const statusQuery = useQuery({
    queryKey: queryKeys.auth.twoFactor,
    queryFn: () => twoFactorApi.getStatus(),
    retry: false,
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: queryKeys.auth.twoFactor });

  const startMutation = useMutation({
    mutationFn: () => twoFactorApi.startEnrollment(),
    onSuccess: (start) => {
      setPageError(null);
      setView({ kind: "setup", start });
    },
    onError: (err) => {
      setPageError(describeTwoFactorFailure(err, "Could not start the set-up. Please try again.").message);
      void refresh();
    },
  });

  const status = statusQuery.data;
  if (statusQuery.isLoading || !status) return null;

  const close = () => setView({ kind: "closed" });
  const since = formatDate(status.enabledAt);

  return (
    <div className="rounded-[28px] border border-border/70 bg-card p-6 shadow-sm" data-testid="two-factor-card">
      <div className="space-y-1">
        <h2 className="section-title">Two-step sign-in</h2>
        <p className="text-sm text-muted-foreground">
          Add a second lock. After your password, you also type a short code from an app on your phone.
        </p>
      </div>
      <div className="mt-4 space-y-3 text-sm">
        {status.enabled ? (
          <>
            <p className="flex items-center gap-2">
              <ShieldCheck className="size-4 text-emerald-600 dark:text-emerald-400" />
              <span>
                Turned on{since ? ` since ${since}` : ""}. You have {status.recoveryCodesRemaining} backup{" "}
                {status.recoveryCodesRemaining === 1 ? "code" : "codes"} left.
              </span>
            </p>
            {pageError ? <p className="text-destructive">{pageError}</p> : null}
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="outline" onClick={() => setView({ kind: "renew" })}>
                Get new backup codes
              </Button>
              <Button type="button" variant="outline" onClick={() => setView({ kind: "turn-off" })}>
                Turn off
              </Button>
            </div>
          </>
        ) : (
          <>
            <p className="text-muted-foreground">Two-step sign-in is off.</p>
            {pageError ? <p className="text-destructive">{pageError}</p> : null}
            <Button type="button" onClick={() => startMutation.mutate()} disabled={startMutation.isPending}>
              {startMutation.isPending ? <LoaderCircle className="size-4 animate-spin" /> : null}
              Turn on
            </Button>
          </>
        )}
      </div>

      <Dialog open={view.kind !== "closed"} onOpenChange={(open) => {
          // Backup codes are shown once, so only the "I have saved them" button closes that step.
          if (!open && view.kind !== "setup-done" && view.kind !== "renew-done") close();
        }}>
        <DialogContent className="sm:max-w-md">
          {view.kind === "setup" ? (
            <SetupStep
              start={view.start}
              onRestart={() => {
                close();
                startMutation.mutate();
              }}
              onDone={(codes) => {
                void refresh();
                setView({ kind: "setup-done", codes });
              }}
            />
          ) : null}
          {view.kind === "setup-done" ? (
            <CodesDoneStep title="Two-step sign-in is on" codes={view.codes} onClose={close} />
          ) : null}
          {view.kind === "renew" ? (
            <ProofStep
              title="Get new backup codes"
              description="Your old backup codes will stop working. Enter a code to confirm it is you."
              actionLabel="Get new codes"
              run={(proof) => twoFactorApi.regenerateRecoveryCodes(proof)}
              onSuccess={(result) => {
                void refresh();
                setView({ kind: "renew-done", codes: result.recoveryCodes });
              }}
              onCancel={close}
            />
          ) : null}
          {view.kind === "renew-done" ? (
            <CodesDoneStep title="Your new backup codes" codes={view.codes} onClose={close} />
          ) : null}
          {view.kind === "turn-off" ? (
            <ProofStep
              title="Turn off two-step sign-in"
              description="You will sign in with just your password. Enter a code to confirm it is you."
              actionLabel="Turn off"
              destructive
              run={(proof) => twoFactorApi.disable(proof)}
              onSuccess={() => {
                void refresh();
                close();
              }}
              onCancel={close}
            />
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function SetupStep({
  start,
  onDone,
  onRestart,
}: {
  start: TwoFactorEnrollStart;
  onDone: (codes: string[]) => void;
  onRestart: () => void;
}) {
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [restart, setRestart] = useState(false);
  const [copied, setCopied] = useState(false);
  const mutation = useMutation({
    mutationFn: () => twoFactorApi.finishEnrollment({ enrollmentToken: start.enrollmentToken, totpCode: code }),
    onSuccess: () => onDone(start.recoveryCodes),
    onError: (err) => {
      const failure = describeTwoFactorFailure(err, "Could not turn this on. Please try again.");
      setError(failure.message);
      setRestart(failure.restartSetup);
    },
  });
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(timer);
  }, [copied]);

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (!code.trim() || mutation.isPending) return;
        setError(null);
        mutation.mutate();
      }}
      className="space-y-4"
    >
      <DialogHeader>
        <DialogTitle>Turn on two-step sign-in</DialogTitle>
        <DialogDescription>
          Open an authenticator app on your phone, such as Google Authenticator or 1Password, and add a new account
          by scanning this picture.
        </DialogDescription>
      </DialogHeader>
      <div className="flex justify-center">
        <QrCode value={start.otpauthUri} label="Picture to scan with your authenticator app" />
      </div>
      <div className="space-y-1">
        <Label htmlFor="two-factor-setup-key">Can't scan? Type this key into your app instead</Label>
        <div className="flex gap-2">
          <Input id="two-factor-setup-key" readOnly value={start.secret} className="font-mono" />
          <Button
            type="button"
            variant="outline"
            size="icon"
            aria-label="Copy the key"
            onClick={() => {
              void navigator.clipboard.writeText(start.secret).then(() => setCopied(true));
            }}
          >
            <Copy className="size-4" />
          </Button>
        </div>
        {copied ? <p className="text-xs text-muted-foreground">Copied</p> : null}
      </div>
      <TwoFactorCodeField
        value={code}
        onChange={setCode}
        useBackupCode={false}
        onToggleBackupCode={() => undefined}
        allowBackupCode={false}
        error={error}
        autoFocus
      />
      <DialogFooter>
        {restart ? (
          <Button type="button" onClick={onRestart}>
            Start again
          </Button>
        ) : (
          <Button type="submit" disabled={!code.trim() || mutation.isPending}>
            {mutation.isPending ? <LoaderCircle className="size-4 animate-spin" /> : null}
            Turn on
          </Button>
        )}
      </DialogFooter>
    </form>
  );
}

function CodesDoneStep({ title, codes, onClose }: { title: string; codes: string[]; onClose: () => void }) {
  return (
    <div className="space-y-4">
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>Your backup codes are below.</DialogDescription>
      </DialogHeader>
      <BackupCodesPanel codes={codes} />
      <DialogFooter>
        <Button type="button" onClick={onClose}>
          I have saved them
        </Button>
      </DialogFooter>
    </div>
  );
}

function ProofStep<T>({
  title,
  description,
  actionLabel,
  destructive,
  run,
  onSuccess,
  onCancel,
}: {
  title: string;
  description: string;
  actionLabel: string;
  destructive?: boolean;
  run: (proof: { totpCode: string; isRecoveryCode: boolean }) => Promise<T>;
  onSuccess: (result: T) => void;
  onCancel: () => void;
}) {
  const [code, setCode] = useState("");
  const [useBackup, setUseBackup] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mutation = useMutation({
    mutationFn: () => run({ totpCode: code, isRecoveryCode: useBackup }),
    onSuccess,
    onError: (err) => setError(describeTwoFactorFailure(err, "Something went wrong. Please try again.").message),
  });
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (!code.trim() || mutation.isPending) return;
        setError(null);
        mutation.mutate();
      }}
      className="space-y-4"
    >
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>{description}</DialogDescription>
      </DialogHeader>
      <TwoFactorCodeField
        value={code}
        onChange={setCode}
        useBackupCode={useBackup}
        onToggleBackupCode={() => {
          setUseBackup((current) => !current);
          setCode("");
          setError(null);
        }}
        error={error}
        autoFocus
      />
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" variant={destructive ? "destructive" : "default"} disabled={!code.trim() || mutation.isPending}>
          {mutation.isPending ? <LoaderCircle className="size-4 animate-spin" /> : null}
          {actionLabel}
        </Button>
      </DialogFooter>
    </form>
  );
}
