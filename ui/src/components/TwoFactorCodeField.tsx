import { useId } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * One box for the code, with a link to switch between the 6-digit code from the phone app
 * and a one-time backup code.
 */
export function TwoFactorCodeField({
  value,
  onChange,
  useBackupCode,
  onToggleBackupCode,
  allowBackupCode = true,
  error,
  autoFocus,
}: {
  value: string;
  onChange: (value: string) => void;
  useBackupCode: boolean;
  onToggleBackupCode: () => void;
  allowBackupCode?: boolean;
  error?: string | null;
  autoFocus?: boolean;
}) {
  const inputId = useId();
  const errorId = `${inputId}-error`;
  return (
    <div className="space-y-2">
      <Label htmlFor={inputId}>{useBackupCode ? "Backup code" : "6-digit code from your app"}</Label>
      <Input
        id={inputId}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        inputMode={useBackupCode ? "text" : "numeric"}
        autoComplete="one-time-code"
        autoCapitalize="off"
        spellCheck={false}
        autoFocus={autoFocus}
        placeholder={useBackupCode ? "Paste one of your backup codes" : "123456"}
        className="font-mono tracking-widest"
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
      />
      {error ? (
        <p id={errorId} role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {allowBackupCode ? (
        <button
          type="button"
          className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
          onClick={onToggleBackupCode}
        >
          {useBackupCode ? "Use the code from my app instead" : "I lost my phone — use a backup code"}
        </button>
      ) : null}
    </div>
  );
}
