import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export type WebhookSecretOption = { id: string; name: string; description?: string | null };

/**
 * Lets an owner or admin reuse a saved secret as a webhook's password
 * instead of making a new one. Only rendered for people allowed to do that.
 */
export function WebhookSecretChoice({
  mode,
  secretId,
  options,
  onModeChange,
  onSecretChange,
  disabled,
}: {
  mode: "generate" | "existing";
  secretId: string;
  options: WebhookSecretOption[];
  onModeChange: (mode: "generate" | "existing") => void;
  onSecretChange: (secretId: string) => void;
  disabled?: boolean;
}) {
  return (
    <div className="space-y-1.5 md:col-span-2">
      <Label className="text-xs">Password</Label>
      <Select
        value={mode}
        onValueChange={(value) => onModeChange(value === "existing" ? "existing" : "generate")}
        disabled={disabled}
      >
        <SelectTrigger aria-label="Password">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="generate">Make a new password</SelectItem>
          <SelectItem value="existing">Use a saved secret</SelectItem>
        </SelectContent>
      </Select>
      {mode === "existing" ? (
        options.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            You have no saved secrets yet. Add one on the Secrets page first.
          </p>
        ) : (
          <Select value={secretId} onValueChange={onSecretChange} disabled={disabled}>
            <SelectTrigger aria-label="Saved secret">
              <SelectValue placeholder="Choose a saved secret" />
            </SelectTrigger>
            <SelectContent>
              {options.map((option) => (
                <SelectItem key={option.id} value={option.id}>
                  {option.name}
                  {option.description ? ` — ${option.description}` : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )
      ) : null}
    </div>
  );
}
