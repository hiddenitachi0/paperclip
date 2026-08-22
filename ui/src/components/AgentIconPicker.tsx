import { useState, useMemo, type ChangeEvent } from "react";
import {
  type LucideIcon,
} from "lucide-react";
import { AGENT_ICON_NAMES, type AgentIconName } from "@paperclipai/shared";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { AGENT_ICONS, getAgentIcon } from "../lib/agent-icons";
import { AGENT_AVATAR_HINT } from "../lib/agent-avatar-errors";

const DEFAULT_ICON: AgentIconName = "bot";

interface AgentIconProps {
  icon: string | null | undefined;
  className?: string;
}

export function AgentIcon({ icon, className }: AgentIconProps) {
  const Icon = getAgentIcon(icon);
  return <Icon className={className} />;
}

interface AgentIconPickerProps {
  value: string | null | undefined;
  onChange: (icon: string) => void;
  children: React.ReactNode;
  /** When provided, an extra "Picture" section is shown above "Symbol". */
  avatarUrl?: string | null;
  onUploadAvatar?: (file: File) => void;
  onRemoveAvatar?: () => void;
  avatarUploadPending?: boolean;
  avatarRemovePending?: boolean;
  avatarError?: string | null;
}

export function AgentIconPicker({
  value,
  onChange,
  children,
  avatarUrl,
  onUploadAvatar,
  onRemoveAvatar,
  avatarUploadPending = false,
  avatarRemovePending = false,
  avatarError = null,
}: AgentIconPickerProps) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const showPictureSection = typeof onUploadAvatar === "function";
  const avatarBusy = avatarUploadPending || avatarRemovePending;

  const filtered = useMemo(() => {
    const entries = AGENT_ICON_NAMES.map((name) => [name, AGENT_ICONS[name]] as const);
    if (!search) return entries;
    const q = search.toLowerCase();
    return entries.filter(([name]) => name.includes(q));
  }, [search]);

  function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0] ?? null;
    event.currentTarget.value = "";
    if (file) onUploadAvatar?.(file);
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent className="w-72 p-3 space-y-3" align="start">
        {showPictureSection && (
          <div className="space-y-2">
            <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              Picture
            </div>
            <div className="flex items-center gap-2">
              <label
                className={cn(
                  "flex-1 cursor-pointer rounded-md border border-border bg-transparent px-2.5 py-1.5 text-center text-xs hover:bg-accent transition-colors",
                  avatarBusy && "pointer-events-none opacity-60"
                )}
              >
                {avatarUploadPending ? "Uploading..." : "Upload picture"}
                <input
                  type="file"
                  accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml"
                  className="hidden"
                  disabled={avatarBusy}
                  onChange={handleFileChange}
                />
              </label>
              {avatarUrl && onRemoveAvatar && (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="text-xs"
                  disabled={avatarBusy}
                  onClick={onRemoveAvatar}
                >
                  {avatarRemovePending ? "Removing..." : "Remove picture"}
                </Button>
              )}
            </div>
            <p className="text-[11px] text-muted-foreground">{AGENT_AVATAR_HINT}</p>
            {avatarError && <p className="text-[11px] text-destructive">{avatarError}</p>}
          </div>
        )}
        <div className="space-y-2">
          {showPictureSection && (
            <div className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              Symbol
            </div>
          )}
          <Input
            placeholder="Search icons..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-8 text-sm"
            autoFocus={!showPictureSection}
          />
          <div className="grid grid-cols-7 gap-1 max-h-48 overflow-y-auto">
            {filtered.map(([name, Icon]) => (
              <button
                key={name}
                onClick={() => {
                  onChange(name);
                  setOpen(false);
                  setSearch("");
                }}
                className={cn(
                  "flex items-center justify-center h-8 w-8 rounded hover:bg-accent transition-colors",
                  (value ?? DEFAULT_ICON) === name && "bg-accent ring-1 ring-primary"
                )}
                title={name}
              >
                <Icon className="h-4 w-4" />
              </button>
            ))}
            {filtered.length === 0 && (
              <p className="col-span-7 text-xs text-muted-foreground text-center py-2">No icons match</p>
            )}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
