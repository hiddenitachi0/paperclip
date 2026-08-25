import { useState } from "react";
type McpServerConfig = { name: string; command?: string; args?: string[]; url?: string; transport?: string; env?: Record<string, string>; headers?: Record<string, string> };
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { X, Plus, Wrench } from "lucide-react";

/**
 * v1 tool picker for a job's default tools: a plain "name + remove" list.
 * DUR-115 explicitly allows this instead of a nicer connector picker or the
 * raw-JSON textarea DUR-51 shipped (`ui/src/adapters/mcp-servers-field.tsx`) —
 * "a plain list of 'tool name + remove' is fine for v1."
 */
export function JobToolsPicker({
  value,
  onChange,
  disabled,
}: {
  value: McpServerConfig[];
  onChange: (next: McpServerConfig[]) => void;
  disabled?: boolean;
}) {
  const [draftOpen, setDraftOpen] = useState(false);
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"command" | "url">("command");
  const [target, setTarget] = useState("");
  const [error, setError] = useState<string | null>(null);

  function resetDraft() {
    setName("");
    setTarget("");
    setKind("command");
    setError(null);
    setDraftOpen(false);
  }

  function addTool() {
    const trimmedName = name.trim();
    const trimmedTarget = target.trim();
    if (!trimmedName) {
      setError("Give the tool a name.");
      return;
    }
    if (value.some((tool) => tool.name === trimmedName)) {
      setError("A tool with that name is already in this list.");
      return;
    }
    if (!trimmedTarget) {
      setError(kind === "command" ? "Enter the command to run." : "Enter the server URL.");
      return;
    }
    const nextTool: McpServerConfig =
      kind === "command"
        ? { name: trimmedName, command: trimmedTarget }
        : { name: trimmedName, url: trimmedTarget };
    onChange([...value, nextTool]);
    resetDraft();
  }

  function removeTool(toolName: string) {
    onChange(value.filter((tool) => tool.name !== toolName));
  }

  return (
    <div className="space-y-2">
      {value.length === 0 ? (
        <p className="text-xs text-muted-foreground">No tools added yet.</p>
      ) : (
        <ul className="space-y-1.5">
          {value.map((tool) => (
            <li
              key={tool.name}
              className="flex items-center justify-between gap-2 rounded-md border border-border px-3 py-1.5 text-sm"
            >
              <span className="flex items-center gap-2 truncate">
                <Wrench className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate">{tool.name}</span>
              </span>
              <button
                type="button"
                className="shrink-0 text-muted-foreground hover:text-foreground disabled:opacity-50"
                onClick={() => removeTool(tool.name)}
                disabled={disabled}
                aria-label={`Remove ${tool.name}`}
              >
                <X className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}

      {draftOpen ? (
        <div className="space-y-2 rounded-md border border-border p-3">
          <Input
            placeholder="Tool name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            disabled={disabled}
            autoFocus
          />
          <div className="flex gap-1.5 text-xs">
            <button
              type="button"
              className={`rounded-md border px-2 py-1 ${kind === "command" ? "border-primary text-foreground" : "border-border text-muted-foreground"}`}
              onClick={() => setKind("command")}
              disabled={disabled}
            >
              Runs a command
            </button>
            <button
              type="button"
              className={`rounded-md border px-2 py-1 ${kind === "url" ? "border-primary text-foreground" : "border-border text-muted-foreground"}`}
              onClick={() => setKind("url")}
              disabled={disabled}
            >
              Connects to a URL
            </button>
          </div>
          <Input
            placeholder={kind === "command" ? "Command to run" : "Server URL"}
            value={target}
            onChange={(event) => setTarget(event.target.value)}
            disabled={disabled}
          />
          {error ? <p className="text-xs text-destructive">{error}</p> : null}
          <div className="flex gap-2">
            <Button type="button" size="sm" onClick={addTool} disabled={disabled}>
              Add tool
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={resetDraft} disabled={disabled}>
              Cancel
            </Button>
          </div>
        </div>
      ) : (
        <Button type="button" size="sm" variant="outline" onClick={() => setDraftOpen(true)} disabled={disabled}>
          <Plus className="mr-1.5 h-3.5 w-3.5" />
          Add a tool
        </Button>
      )}
    </div>
  );
}
