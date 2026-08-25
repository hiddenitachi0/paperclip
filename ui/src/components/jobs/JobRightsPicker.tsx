import type { PermissionKey } from "@paperclipai/shared";
import { Checkbox } from "@/components/ui/checkbox";
import { permissionLabel, permissionDescription, selectablePermissionKeys } from "../../lib/permission-labels";
import type { RightGrant } from "../../api/jobs";

/**
 * Checkboxes over the company's permission keys, always rendered as plain
 * language (see permission-labels.ts). Never lists a deploy/merge *approve*
 * key — only "ask to deploy/merge" keys are ever selectable here, and only
 * once the backend has actually added them to PERMISSION_KEYS.
 */
export function JobRightsPicker({
  value,
  onChange,
  disabled,
}: {
  value: RightGrant[];
  onChange: (next: RightGrant[]) => void;
  disabled?: boolean;
}) {
  const keys = selectablePermissionKeys();
  const selected = new Set(value.map((grant) => grant.permissionKey));

  function toggle(key: PermissionKey, checked: boolean) {
    if (checked) {
      onChange([...value, { permissionKey: key, scope: null }]);
    } else {
      onChange(value.filter((grant) => grant.permissionKey !== key));
    }
  }

  if (keys.length === 0) {
    return <p className="text-xs text-muted-foreground">No rights are configurable yet.</p>;
  }

  return (
    <ul className="space-y-2">
      {keys.map((key) => {
        const description = permissionDescription(key);
        return (
          <li key={key} className="flex items-start gap-2.5">
            <Checkbox
              id={`job-right-${key}`}
              checked={selected.has(key)}
              onCheckedChange={(checked) => toggle(key, checked === true)}
              disabled={disabled}
              className="mt-0.5"
            />
            <label htmlFor={`job-right-${key}`} className="cursor-pointer text-sm">
              <div>{permissionLabel(key)}</div>
              {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
            </label>
          </li>
        );
      })}
    </ul>
  );
}
