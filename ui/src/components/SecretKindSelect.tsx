/**
 * DUR-3997: "What kind of key is this?"
 *
 * One grouped dropdown over the shared taxonomy (packages/shared/src/
 * secret-kinds.ts), used by the New secret dialog, the Add integration token
 * dialog and the secret detail sheet. Plain labels, grouped by category, with
 * a one-line explanation of the chosen kind underneath. "Not sure" is always
 * available: a secret without a kind keeps working exactly as before, it
 * just cannot be tested.
 */
import { getSecretKind, secretKindsByCategory, type SecretKind } from "@paperclipai/shared";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export const NO_SECRET_KIND = "__none__";

const GROUPS = secretKindsByCategory();

interface SecretKindSelectProps {
  id?: string;
  value: SecretKind | null;
  onChange: (kind: SecretKind | null) => void;
  disabled?: boolean;
  /** Hide the one-line description under the field. */
  compact?: boolean;
  className?: string;
}

export function SecretKindSelect({ id, value, onChange, disabled, compact, className }: SecretKindSelectProps) {
  const descriptor = getSecretKind(value);
  return (
    <div className={className}>
      <Select
        value={value ?? NO_SECRET_KIND}
        onValueChange={(next) => onChange(next === NO_SECRET_KIND ? null : (next as SecretKind))}
        disabled={disabled}
      >
        <SelectTrigger id={id} className="w-full">
          <SelectValue placeholder="Not sure" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NO_SECRET_KIND}>Not sure</SelectItem>
          {GROUPS.map((group) => (
            <SelectGroup key={group.category}>
              <SelectLabel>{group.label}</SelectLabel>
              {group.kinds.map((kind) => (
                <SelectItem key={kind.id} value={kind.id}>
                  {kind.label}
                </SelectItem>
              ))}
            </SelectGroup>
          ))}
        </SelectContent>
      </Select>
      {!compact && (
        <p className="mt-1 text-[11px] text-muted-foreground">
          {descriptor
            ? descriptor.testable
              ? `${descriptor.description} Paperclip can test it.`
              : descriptor.description
            : "Optional. Telling Paperclip what the key is lets it offer the key where it fits and test AI provider keys."}
        </p>
      )}
    </div>
  );
}
