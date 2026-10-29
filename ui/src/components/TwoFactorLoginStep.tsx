import { useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { LoaderCircle } from "lucide-react";
import { twoFactorApi } from "../api/twoFactor";
import { describeTwoFactorFailure } from "../lib/two-factor-copy";
import { Button } from "@/components/ui/button";
import { TwoFactorCodeField } from "./TwoFactorCodeField";

/** The second screen of signing in: the code from the phone app, or a backup code. */
export function TwoFactorLoginStep({
  onVerified,
  onBack,
}: {
  onVerified: () => void;
  /** Go back to the password screen. `message` is set when the sign-in ran out of time. */
  onBack: (message?: string) => void;
}) {
  const [code, setCode] = useState("");
  const [useBackup, setUseBackup] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [waitSeconds, setWaitSeconds] = useState(0);

  useEffect(() => {
    if (waitSeconds <= 0) return;
    const timer = window.setTimeout(() => setWaitSeconds((current) => current - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [waitSeconds]);

  const mutation = useMutation({
    mutationFn: () => twoFactorApi.verifyLogin({ totpCode: code, isRecoveryCode: useBackup }),
    onSuccess: () => onVerified(),
    onError: (err) => {
      const failure = describeTwoFactorFailure(err, "Could not check your code. Please try again.");
      if (failure.signInAgain) {
        onBack(failure.message);
        return;
      }
      setError(failure.message);
      if (failure.waitSeconds) setWaitSeconds(failure.waitSeconds);
    },
  });

  const blocked = waitSeconds > 0;
  return (
    <>
      <h1 className="text-xl font-semibold">Enter your sign-in code</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        Open the authenticator app on your phone and type the 6-digit code for Paperclip.
      </p>
      <form
        className="mt-6 space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          if (!code.trim() || mutation.isPending || blocked) return;
          setError(null);
          mutation.mutate();
        }}
      >
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
        <Button type="submit" className="w-full" disabled={!code.trim() || mutation.isPending || blocked}>
          {mutation.isPending ? <LoaderCircle className="size-4 animate-spin" /> : null}
          {blocked ? `Wait ${waitSeconds}s` : "Continue"}
        </Button>
      </form>
      <div className="mt-5 text-sm text-muted-foreground">
        <button
          type="button"
          className="font-medium text-foreground underline underline-offset-2"
          onClick={() => onBack()}
        >
          Back to sign in
        </button>
      </div>
    </>
  );
}
