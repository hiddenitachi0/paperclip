import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { KeyRound, LogIn, MoreVertical, Pencil, Plug, Plus, Trash2, X } from "lucide-react";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToastActions } from "../context/ToastContext";
import {
  mcpOAuthApi,
  mcpToolLibraryApi,
  type McpToolConnection,
  type McpToolLibraryEntry,
} from "../api/mcpToolLibrary";
import { secretsApi } from "../api/secrets";
import { ApiError } from "../api/client";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { EmptyState } from "../components/EmptyState";
import { PageSkeleton } from "../components/PageSkeleton";

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return fallback;
}

type CredentialRow = {
  id: string;
  key: string;
  secretId: string;
};

type ToolDraft = {
  name: string;
  description: string;
  kind: "command" | "url";
  target: string;
  credentialRows: CredentialRow[];
};

function emptyDraft(): ToolDraft {
  return { name: "", description: "", kind: "url", target: "", credentialRows: [] };
}

function draftFromTool(tool: McpToolLibraryEntry): ToolDraft {
  const connection = tool.connection ?? {};
  const kind: "command" | "url" = connection.command ? "command" : "url";
  const field = kind === "command" ? connection.env : connection.headers;
  // Every row here is a secret_ref — the tool library never stores a plain
  // credential value, so there is nothing else to reconstruct into a row.
  const credentialRows: CredentialRow[] = Object.entries(field ?? {})
    .filter((entry): entry is [string, { type: "secret_ref"; secretId: string }] => {
      const binding = entry[1];
      return typeof binding === "object" && binding !== null && binding.type === "secret_ref";
    })
    .map(([key, binding]) => ({ id: key, key, secretId: binding.secretId ?? "" }));
  return {
    name: tool.name,
    description: tool.description,
    kind,
    target: kind === "command" ? connection.command ?? "" : connection.url ?? "",
    credentialRows,
  };
}

function draftToConnection(draft: ToolDraft): McpToolConnection {
  const field: Record<string, { type: "secret_ref"; secretId: string; version: "latest" }> = {};
  for (const row of draft.credentialRows) {
    const key = row.key.trim();
    if (!key || !row.secretId) continue;
    field[key] = { type: "secret_ref", secretId: row.secretId, version: "latest" };
  }
  const hasField = Object.keys(field).length > 0;
  return draft.kind === "command"
    ? { command: draft.target.trim(), ...(hasField ? { env: field } : {}) }
    : { url: draft.target.trim(), ...(hasField ? { headers: field } : {}) };
}

export function CompanyMcpTools() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToastActions();
  const queryClient = useQueryClient();

  const [formOpen, setFormOpen] = useState(false);
  const [editingToolId, setEditingToolId] = useState<string | null>(null);
  const [deletingTool, setDeletingTool] = useState<McpToolLibraryEntry | null>(null);

  useEffect(() => {
    setBreadcrumbs([{ label: "Tools" }]);
  }, [setBreadcrumbs]);

  const toolsQuery = useQuery({
    queryKey: selectedCompanyId ? queryKeys.mcpTools.list(selectedCompanyId) : ["mcp-tools", "__none__"],
    queryFn: () => mcpToolLibraryApi.list(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });
  const tools = toolsQuery.data ?? [];

  const invalidateTools = () => {
    if (selectedCompanyId) {
      queryClient.invalidateQueries({ queryKey: queryKeys.mcpTools.list(selectedCompanyId) });
    }
  };

  const createTool = useMutation({
    mutationFn: (draft: ToolDraft) =>
      mcpToolLibraryApi.create(selectedCompanyId!, {
        name: draft.name,
        description: draft.description,
        connection: draftToConnection(draft),
      }),
    onSuccess: () => {
      invalidateTools();
      setFormOpen(false);
      pushToast({ title: "Tool added", tone: "success" });
    },
    onError: (error) => pushToast({ title: "Could not add tool", body: errorMessage(error, ""), tone: "error" }),
  });

  const updateTool = useMutation({
    mutationFn: ({ id, draft }: { id: string; draft: ToolDraft }) =>
      mcpToolLibraryApi.update(id, {
        name: draft.name,
        description: draft.description,
        connection: draftToConnection(draft),
      }),
    onSuccess: () => {
      invalidateTools();
      setFormOpen(false);
      setEditingToolId(null);
      pushToast({ title: "Tool saved", tone: "success" });
    },
    onError: (error) => pushToast({ title: "Could not save tool", body: errorMessage(error, ""), tone: "error" }),
  });

  const deleteTool = useMutation({
    mutationFn: (id: string) => mcpToolLibraryApi.remove(id),
    onSuccess: () => {
      invalidateTools();
      setDeletingTool(null);
      pushToast({ title: "Tool removed", tone: "success" });
    },
    onError: (error) => pushToast({ title: "Could not remove tool", body: errorMessage(error, ""), tone: "error" }),
  });

  const editingTool = tools.find((tool) => tool.id === editingToolId) ?? null;

  function openCreate() {
    setEditingToolId(null);
    setFormOpen(true);
  }

  function openEdit(tool: McpToolLibraryEntry) {
    setEditingToolId(tool.id);
    setFormOpen(true);
  }

  function handleSubmit(draft: ToolDraft) {
    if (editingToolId) {
      updateTool.mutate({ id: editingToolId, draft });
    } else {
      createTool.mutate(draft);
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-lg font-semibold">Tools</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Add a tool once — give it a name, say what it does, and connect it. Then check it on for any agent from
            that agent's page. Keys always go through Secrets, never typed here in the open.
          </p>
        </div>
        <Button onClick={openCreate}>
          <Plus className="mr-1.5 h-3.5 w-3.5" />
          Add tool
        </Button>
      </div>

      {toolsQuery.isLoading ? (
        <PageSkeleton variant="list" />
      ) : toolsQuery.error ? (
        <div className="py-6 text-sm text-destructive">{errorMessage(toolsQuery.error, "Could not load tools.")}</div>
      ) : tools.length === 0 ? (
        <EmptyState
          icon={Plug}
          message="No tools yet. Add one — an image generator, a calendar, anything with an MCP server — and hand it to an agent."
          action="Add tool"
          onAction={openCreate}
        />
      ) : (
        <ul className="divide-y divide-border border border-border rounded-lg">
          {tools.map((tool) => (
            <li key={tool.id} className="flex items-start justify-between gap-4 px-4 py-3">
              <div className="min-w-0">
                <div className="font-medium">{tool.name}</div>
                <p className="mt-0.5 text-sm text-muted-foreground">{tool.description}</p>
              </div>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon-sm">
                    <MoreVertical className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onSelect={() => openEdit(tool)}>
                    <Pencil className="mr-2 h-4 w-4" />
                    Edit
                  </DropdownMenuItem>
                  <DropdownMenuItem onSelect={() => setDeletingTool(tool)} variant="destructive">
                    <Trash2 className="mr-2 h-4 w-4" />
                    Delete
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </li>
          ))}
        </ul>
      )}

      <ToolFormDialog
        open={formOpen}
        onOpenChange={(open) => {
          setFormOpen(open);
          if (!open) setEditingToolId(null);
        }}
        initialDraft={editingTool ? draftFromTool(editingTool) : emptyDraft()}
        title={editingTool ? "Edit tool" : "Add tool"}
        toolId={editingTool?.id ?? null}
        onSubmit={handleSubmit}
        isPending={createTool.isPending || updateTool.isPending}
      />

      <AlertDialog open={deletingTool !== null} onOpenChange={(open) => !open && setDeletingTool(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete "{deletingTool?.name}"?</AlertDialogTitle>
            <AlertDialogDescription>
              Agents that had this checked on lose access to it. This only removes the tool itself — it never
              touches the underlying secret.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => deletingTool && deleteTool.mutate(deletingTool.id)}
              disabled={deleteTool.isPending}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function ToolFormDialog({
  open,
  onOpenChange,
  initialDraft,
  title,
  toolId,
  onSubmit,
  isPending,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialDraft: ToolDraft;
  title: string;
  toolId: string | null;
  onSubmit: (draft: ToolDraft) => void;
  isPending: boolean;
}) {
  const { selectedCompanyId } = useCompany();
  const { pushToast } = useToastActions();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<ToolDraft>(initialDraft);
  const [connectState, setConnectState] = useState<"idle" | "connecting" | "connected">("idle");

  useEffect(() => {
    if (open) {
      setDraft(initialDraft);
      setConnectState("idle");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const secretsQuery = useQuery({
    queryKey: selectedCompanyId ? queryKeys.secrets.list(selectedCompanyId) : ["secrets", "__none__"],
    queryFn: () => secretsApi.list(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId) && open,
  });
  const secrets = secretsQuery.data ?? [];

  // DUR-3909: run the OAuth handshake in a popup, then poll the session
  // until the operator finishes (or abandons) it in that window. Only
  // available once the tool has been saved (start() needs a real toolId to
  // redirect back to) and only for URL-connected servers.
  async function handleConnect() {
    if (!toolId) return;
    setConnectState("connecting");
    try {
      const { sessionId, authorizeUrl } = await mcpOAuthApi.start(toolId);
      const popup = window.open(authorizeUrl, "_blank", "width=520,height=680");
      const poll = window.setInterval(async () => {
        try {
          const session = await mcpOAuthApi.status(toolId, sessionId);
          if (session.status === "pending") return;
          window.clearInterval(poll);
          if (session.status === "completed" && session.resultSecretId) {
            popup?.close();
            setConnectState("connected");
            setDraft((prev) => ({
              ...prev,
              credentialRows: [
                ...prev.credentialRows.filter((row) => row.key !== "Authorization"),
                { id: "row-oauth-authorization", key: "Authorization", secretId: session.resultSecretId! },
              ],
            }));
            queryClient.invalidateQueries({
              queryKey: selectedCompanyId ? queryKeys.secrets.list(selectedCompanyId) : ["secrets", "__none__"],
            });
            pushToast({ title: "Connected", tone: "success" });
          } else {
            setConnectState("idle");
            pushToast({
              title: "Could not connect",
              body: session.errorMessage ?? "The sign-in did not complete.",
              tone: "error",
            });
          }
        } catch {
          window.clearInterval(poll);
          setConnectState("idle");
        }
      }, 1500);
    } catch (error) {
      setConnectState("idle");
      pushToast({ title: "Could not start sign-in", body: errorMessage(error, ""), tone: "error" });
    }
  }

  const credentialFieldLabel = draft.kind === "command" ? "Environment variables" : "Headers";
  const canSubmit = draft.name.trim().length > 0 && draft.description.trim().length > 0 && draft.target.trim().length > 0;

  function addCredentialRow() {
    setDraft((prev) => ({
      ...prev,
      credentialRows: [
        ...prev.credentialRows,
        { id: `row-${Date.now()}-${Math.random().toString(36).slice(2)}`, key: "", secretId: "" },
      ],
    }));
  }

  function updateCredentialRow(id: string, patch: Partial<CredentialRow>) {
    setDraft((prev) => ({
      ...prev,
      credentialRows: prev.credentialRows.map((row) => (row.id === id ? { ...row, ...patch } : row)),
    }));
  }

  function removeCredentialRow(id: string) {
    setDraft((prev) => ({ ...prev, credentialRows: prev.credentialRows.filter((row) => row.id !== id) }));
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            Name, description, and connection — no JSON. Any key goes through a saved secret, picked below.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <label className="text-xs text-muted-foreground">Name</label>
            <Input
              placeholder="e.g. Fal.ai"
              value={draft.name}
              onChange={(event) => setDraft((prev) => ({ ...prev, name: event.target.value }))}
              autoFocus
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-xs text-muted-foreground">What it does</label>
            <Textarea
              placeholder="e.g. Makes images"
              value={draft.description}
              onChange={(event) => setDraft((prev) => ({ ...prev, description: event.target.value }))}
              rows={2}
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-xs text-muted-foreground">Connection</label>
            <div className="flex gap-1.5 text-xs">
              <button
                type="button"
                className={`rounded-md border px-2 py-1 ${draft.kind === "url" ? "border-primary text-foreground" : "border-border text-muted-foreground"}`}
                onClick={() => setDraft((prev) => ({ ...prev, kind: "url" }))}
                disabled={isPending}
              >
                Connects to a URL
              </button>
              <button
                type="button"
                className={`rounded-md border px-2 py-1 ${draft.kind === "command" ? "border-primary text-foreground" : "border-border text-muted-foreground"}`}
                onClick={() => setDraft((prev) => ({ ...prev, kind: "command" }))}
                disabled={isPending}
              >
                Runs a command
              </button>
            </div>
            <Input
              className="mt-2"
              placeholder={draft.kind === "url" ? "https://example.com/mcp" : "Command to run"}
              value={draft.target}
              onChange={(event) => setDraft((prev) => ({ ...prev, target: event.target.value }))}
              disabled={isPending}
            />
            {draft.kind === "url" ? (
              toolId ? (
                <div className="mt-2 flex items-center gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={handleConnect}
                    disabled={isPending || connectState === "connecting" || !draft.target.trim()}
                  >
                    <LogIn className="mr-1.5 h-3.5 w-3.5" />
                    {connectState === "connecting"
                      ? "Waiting for sign-in…"
                      : connectState === "connected"
                        ? "Connected"
                        : "Connect & sign in"}
                  </Button>
                  <p className="text-xs text-muted-foreground">
                    For servers with a browser sign-in instead of a pasted key.
                  </p>
                </div>
              ) : (
                <p className="mt-2 text-xs text-muted-foreground">
                  Save the tool first if it needs "Connect & sign in" instead of a pasted key.
                </p>
              )
            ) : null}
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <label className="text-xs text-muted-foreground">{credentialFieldLabel} (optional)</label>
              <Button type="button" variant="outline" size="sm" onClick={addCredentialRow} disabled={isPending}>
                <Plus className="mr-1 h-3 w-3" />
                Add
              </Button>
            </div>
            {draft.credentialRows.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                Nothing to send yet. Add one if this tool needs a key — e.g. "Authorization".
              </p>
            ) : (
              <ul className="space-y-2">
                {draft.credentialRows.map((row) => (
                  <li key={row.id} className="flex items-center gap-1.5">
                    <Input
                      className="w-32 shrink-0"
                      placeholder="Authorization"
                      value={row.key}
                      onChange={(event) => updateCredentialRow(row.id, { key: event.target.value })}
                      disabled={isPending}
                    />
                    <Select
                      value={row.secretId}
                      onValueChange={(secretId) => updateCredentialRow(row.id, { secretId })}
                      disabled={isPending}
                    >
                      <SelectTrigger className="min-w-0 flex-1">
                        <SelectValue placeholder="Pick a saved secret" />
                      </SelectTrigger>
                      <SelectContent>
                        {secrets.length === 0 ? (
                          <div className="px-2 py-1.5 text-xs text-muted-foreground">
                            No secrets yet — add one in Settings → Secrets first.
                          </div>
                        ) : (
                          secrets.map((secret) => (
                            <SelectItem key={secret.id} value={secret.id}>
                              <KeyRound className="mr-1.5 inline h-3 w-3" />
                              {secret.name}
                            </SelectItem>
                          ))
                        )}
                      </SelectContent>
                    </Select>
                    <button
                      type="button"
                      className="shrink-0 text-muted-foreground hover:text-foreground"
                      onClick={() => removeCredentialRow(row.id)}
                      disabled={isPending}
                      aria-label="Remove"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={isPending}>
            Cancel
          </Button>
          <Button onClick={() => onSubmit(draft)} disabled={!canSubmit || isPending}>
            {isPending ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
