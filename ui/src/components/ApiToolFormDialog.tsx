import { useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Plus, X } from "lucide-react";
import { useCompany } from "../context/CompanyContext";
import { useToastActions } from "../context/ToastContext";
import {
  apiToolsApi,
  type ApiTool,
  type ApiToolAction,
  type ApiToolAuthKind,
  type ApiToolInput,
  type ApiToolInputType,
  type ApiToolMethod,
  type ApiToolTestResult,
} from "../api/apiTools";
import { ApiError } from "../api/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ADD_NEW_SECRET_LABEL, SecretBindingPicker } from "./SecretBindingPicker";

/**
 * DUR-4004: the "API with a key" form on the Tools page. A service that
 * gives you an API key and a web address: name, base address, the saved
 * secret that holds the key (picked, or added right here), how the key is
 * sent, and the actions an agent may call -- imported from an OpenAPI
 * address or typed in by hand. No JSON, no key typed in the open.
 */

const METHODS: ApiToolMethod[] = ["GET", "POST", "PUT", "PATCH", "DELETE"];
const INPUT_TYPES: Array<{ value: ApiToolInputType; label: string }> = [
  { value: "string", label: "text" },
  { value: "integer", label: "whole number" },
  { value: "number", label: "number" },
  { value: "boolean", label: "yes/no" },
  { value: "json", label: "JSON" },
];

const selectClass = "h-8 rounded-md border border-input bg-background px-2 text-sm";

function newId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export interface ApiToolInputDraft {
  id: string;
  name: string;
  type: ApiToolInputType;
  required: boolean;
  description: string;
}

export interface ApiToolActionDraft {
  id: string;
  include: boolean;
  name: string;
  method: ApiToolMethod;
  path: string;
  description: string;
  inputs: ApiToolInputDraft[];
}

export interface ApiToolDraft {
  name: string;
  description: string;
  baseUrl: string;
  secretId: string;
  authKind: ApiToolAuthKind;
  authName: string;
  authPrefix: string;
  dailyCap: string;
  status: "active" | "disabled";
  openapiUrl: string;
  actions: ApiToolActionDraft[];
}

export function emptyApiToolDraft(): ApiToolDraft {
  return {
    name: "",
    description: "",
    baseUrl: "",
    secretId: "",
    authKind: "bearer",
    authName: "",
    authPrefix: "",
    dailyCap: "300",
    status: "active",
    openapiUrl: "",
    actions: [],
  };
}

function actionToDraft(action: ApiToolAction, include = true): ApiToolActionDraft {
  return {
    id: newId(),
    include,
    name: action.name,
    method: action.method,
    path: action.path,
    description: action.description ?? "",
    inputs: action.inputs.map((input) => ({
      id: newId(),
      name: input.name,
      type: input.type,
      required: input.required,
      description: input.description ?? "",
    })),
  };
}

export function apiToolToDraft(tool: ApiTool): ApiToolDraft {
  return {
    name: tool.name,
    description: tool.description,
    baseUrl: tool.baseUrl,
    secretId: tool.auth?.secretId ?? "",
    authKind: tool.auth?.kind ?? "bearer",
    authName: tool.auth?.name ?? "",
    authPrefix: tool.auth?.prefix ?? "",
    dailyCap: String(tool.dailyCap),
    status: tool.status,
    openapiUrl: tool.openapiUrl ?? "",
    actions: tool.actions.map((action) => actionToDraft(action)),
  };
}

function emptyAction(): ApiToolActionDraft {
  return { id: newId(), include: true, name: "", method: "GET", path: "/", description: "", inputs: [] };
}

function emptyInput(): ApiToolInputDraft {
  return { id: newId(), name: "", type: "string", required: false, description: "" };
}

/** What the server is sent. Only the actions still ticked are kept. */
export function draftToInput(draft: ApiToolDraft): ApiToolInput {
  const auth: ApiToolInput["auth"] = { kind: draft.authKind, secretId: draft.secretId };
  if (draft.authKind === "header" || draft.authKind === "query") auth.name = draft.authName.trim();
  if (draft.authKind === "header" && draft.authPrefix) auth.prefix = draft.authPrefix;
  const dailyCap = Number.parseInt(draft.dailyCap, 10);
  return {
    name: draft.name.trim(),
    description: draft.description.trim(),
    baseUrl: draft.baseUrl.trim(),
    auth,
    actions: draft.actions
      .filter((action) => action.include && action.name.trim())
      .map((action) => ({
        name: action.name.trim(),
        method: action.method,
        path: action.path.trim(),
        description: action.description.trim(),
        inputs: action.inputs
          .filter((input) => input.name.trim())
          .map((input) => ({
            name: input.name.trim(),
            type: input.type,
            required: input.required,
            ...(input.description.trim() ? { description: input.description.trim() } : {}),
          })),
      })),
    openapiUrl: draft.openapiUrl.trim() ? draft.openapiUrl.trim() : null,
    dailyCap: Number.isFinite(dailyCap) && dailyCap > 0 ? dailyCap : 300,
    status: draft.status,
  };
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return fallback;
}

function describeLastTest(tool: Pick<ApiTool, "lastTestAt" | "lastTestOk" | "lastTestMessage"> | null): string | null {
  if (!tool?.lastTestAt || !tool.lastTestMessage) return null;
  const when = new Date(tool.lastTestAt).toLocaleString();
  return `Last test ${tool.lastTestOk ? "passed" : "failed"} (${when}): ${tool.lastTestMessage}`;
}

export function ApiToolFormDialog({
  open,
  onOpenChange,
  tool,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The tool being edited, or null to add one. */
  tool: ApiTool | null;
  onSaved: (tool: ApiTool) => void;
}) {
  const { selectedCompanyId } = useCompany();
  const { pushToast } = useToastActions();
  const [draft, setDraft] = useState<ApiToolDraft>(emptyApiToolDraft());
  const [lastTest, setLastTest] = useState<ApiToolTestResult | null>(null);
  const [importUrl, setImportUrl] = useState("");

  useEffect(() => {
    if (open) {
      setDraft(tool ? apiToolToDraft(tool) : emptyApiToolDraft());
      setLastTest(null);
      setImportUrl(tool?.openapiUrl ?? "");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const save = useMutation({
    mutationFn: (input: ApiToolInput) =>
      tool ? apiToolsApi.update(selectedCompanyId!, tool.id, input) : apiToolsApi.create(selectedCompanyId!, input),
    onSuccess: (saved) => {
      pushToast({ title: tool ? "Tool saved" : "Tool added", tone: "success" });
      onSaved(saved);
      onOpenChange(false);
    },
    onError: (error) => pushToast({ title: tool ? "Could not save tool" : "Could not add tool", body: errorMessage(error, ""), tone: "error" }),
  });

  const test = useMutation({
    mutationFn: () => apiToolsApi.test(selectedCompanyId!, tool!.id),
    onSuccess: (result) => setLastTest(result),
    onError: (error) => setLastTest({ ok: false, status: 0, message: errorMessage(error, "The test could not run.") }),
  });

  const importOpenApi = useMutation({
    mutationFn: (url: string) => apiToolsApi.importOpenApi(selectedCompanyId!, url),
    onSuccess: (result, url) => {
      setDraft((prev) => ({
        ...prev,
        openapiUrl: url,
        name: prev.name.trim() ? prev.name : result.title ?? prev.name,
        baseUrl: prev.baseUrl.trim() ? prev.baseUrl : result.baseUrl ?? prev.baseUrl,
        actions: [...prev.actions, ...result.actions.map((action) => actionToDraft(action))],
      }));
      pushToast({
        title: `${result.actions.length} action${result.actions.length === 1 ? "" : "s"} imported`,
        body: `${result.skipped > 0 ? `${result.skipped} could not be imported. ` : ""}Untick the ones the agent should not have, then save.`,
        tone: "success",
      });
    },
    onError: (error) => pushToast({ title: "Could not import", body: errorMessage(error, ""), tone: "error" }),
  });

  const busy = save.isPending || test.isPending || importOpenApi.isPending;
  const needsName = draft.authKind === "header" || draft.authKind === "query";
  const canSubmit =
    draft.name.trim().length > 0 &&
    draft.baseUrl.trim().length > 0 &&
    draft.secretId.length > 0 &&
    (!needsName || draft.authName.trim().length > 0);

  function updateAction(id: string, patch: Partial<ApiToolActionDraft>) {
    setDraft((prev) => ({ ...prev, actions: prev.actions.map((action) => (action.id === id ? { ...action, ...patch } : action)) }));
  }

  function updateInput(actionId: string, inputId: string, patch: Partial<ApiToolInputDraft>) {
    setDraft((prev) => ({
      ...prev,
      actions: prev.actions.map((action) =>
        action.id === actionId
          ? { ...action, inputs: action.inputs.map((input) => (input.id === inputId ? { ...input, ...patch } : input)) }
          : action,
      ),
    }));
  }

  const authHint =
    draft.authKind === "bearer"
      ? "Sent as “Authorization: Bearer <key>”. Fiken and most modern APIs use this."
      : draft.authKind === "header"
        ? "Sent as “<header name>: <text before the key><key>”. Fal.ai: header “Authorization”, text before the key “Key ” (with the space)."
        : "Added to the address as “?<parameter name>=<key>”.";

  const lastTestLine = lastTest
    ? `${lastTest.ok ? "Test passed" : "Test failed"}: ${lastTest.message}`
    : describeLastTest(tool);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{tool ? "Edit API with a key" : "Add API with a key"}</DialogTitle>
          <DialogDescription>
            A service that gives you an API key and a web address. The key lives in Secrets and Paperclip adds it to
            every call; agents only see the actions you list here, never the key.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <label className="text-xs text-muted-foreground" htmlFor="api-tool-name">Name</label>
            <Input
              id="api-tool-name"
              placeholder="e.g. Fal.ai"
              value={draft.name}
              onChange={(event) => setDraft((prev) => ({ ...prev, name: event.target.value }))}
              autoFocus
              disabled={busy}
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-xs text-muted-foreground" htmlFor="api-tool-description">What it does</label>
            <Textarea
              id="api-tool-description"
              placeholder="e.g. Makes images from a text prompt"
              value={draft.description}
              onChange={(event) => setDraft((prev) => ({ ...prev, description: event.target.value }))}
              rows={2}
              disabled={busy}
            />
          </div>

          <div className="space-y-1.5">
            <label className="text-xs text-muted-foreground" htmlFor="api-tool-base-url">Base address</label>
            <Input
              id="api-tool-base-url"
              placeholder="https://fal.run"
              value={draft.baseUrl}
              onChange={(event) => setDraft((prev) => ({ ...prev, baseUrl: event.target.value }))}
              disabled={busy}
            />
            <p className="text-xs text-muted-foreground">
              Must start with https://. Fal.ai: https://fal.run — Fiken: https://api.fiken.no/api/v2
            </p>
          </div>

          <SecretBindingPicker
            label="Key"
            placeholder="Pick the saved secret that holds the key"
            allowVersionSelector={false}
            value={draft.secretId ? { secretId: draft.secretId, version: "latest" } : null}
            onChange={(next) => setDraft((prev) => ({ ...prev, secretId: next?.secretId ?? "" }))}
            disabled={busy}
            emptyHint={`No secrets yet. Pick "${ADD_NEW_SECRET_LABEL}" to paste the key without leaving this page.`}
          />

          <div className="space-y-1.5">
            <label className="text-xs text-muted-foreground">How the key is sent</label>
            <div className="flex flex-wrap gap-1.5 text-xs" role="group" aria-label="How the key is sent">
              {(
                [
                  ["bearer", "Authorization: Bearer"],
                  ["header", "A header"],
                  ["query", "A query parameter"],
                ] as Array<[ApiToolAuthKind, string]>
              ).map(([kind, label]) => (
                <button
                  key={kind}
                  type="button"
                  className={`rounded-md border px-2 py-1 ${draft.authKind === kind ? "border-primary text-foreground" : "border-border text-muted-foreground"}`}
                  onClick={() => setDraft((prev) => ({ ...prev, authKind: kind }))}
                  disabled={busy}
                  aria-pressed={draft.authKind === kind}
                >
                  {label}
                </button>
              ))}
            </div>
            {draft.authKind === "header" ? (
              <div className="mt-2 flex gap-2">
                <Input
                  aria-label="Header name"
                  placeholder="Header name, e.g. Authorization"
                  value={draft.authName}
                  onChange={(event) => setDraft((prev) => ({ ...prev, authName: event.target.value }))}
                  disabled={busy}
                />
                <Input
                  aria-label="Text before the key"
                  placeholder='Text before the key, e.g. "Key "'
                  value={draft.authPrefix}
                  onChange={(event) => setDraft((prev) => ({ ...prev, authPrefix: event.target.value }))}
                  disabled={busy}
                />
              </div>
            ) : draft.authKind === "query" ? (
              <Input
                className="mt-2"
                aria-label="Parameter name"
                placeholder="Parameter name, e.g. api_key"
                value={draft.authName}
                onChange={(event) => setDraft((prev) => ({ ...prev, authName: event.target.value }))}
                disabled={busy}
              />
            ) : null}
            <p className="text-xs text-muted-foreground">{authHint}</p>
          </div>

          <div className="flex items-end gap-4">
            <div className="space-y-1.5">
              <label className="text-xs text-muted-foreground" htmlFor="api-tool-daily-cap">Calls per day</label>
              <Input
                id="api-tool-daily-cap"
                type="number"
                min={1}
                className="w-28"
                value={draft.dailyCap}
                onChange={(event) => setDraft((prev) => ({ ...prev, dailyCap: event.target.value }))}
                disabled={busy}
              />
            </div>
            {tool ? (
              <label className="mb-2 flex items-center gap-2 text-sm">
                <Checkbox
                  checked={draft.status === "active"}
                  onCheckedChange={(checked) => setDraft((prev) => ({ ...prev, status: checked === true ? "active" : "disabled" }))}
                  disabled={busy}
                />
                Switched on
              </label>
            ) : null}
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <label className="text-xs text-muted-foreground">Actions the agent may call</label>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setDraft((prev) => ({ ...prev, actions: [...prev.actions, emptyAction()] }))}
                disabled={busy}
              >
                <Plus className="mr-1 h-3 w-3" />
                Add action
              </Button>
            </div>
            <div className="flex gap-2">
              <Input
                aria-label="OpenAPI address"
                placeholder="Import from an OpenAPI address, e.g. https://api.example.com/openapi.json"
                value={importUrl}
                onChange={(event) => setImportUrl(event.target.value)}
                disabled={busy}
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => importOpenApi.mutate(importUrl.trim())}
                disabled={busy || !importUrl.trim()}
              >
                {importOpenApi.isPending ? "Importing…" : "Import"}
              </Button>
            </div>
            {draft.actions.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                No actions yet. Import them from the service's OpenAPI address, or add one by hand: a name, the method,
                the path (with {"{placeholders}"} for inputs), one sentence about what it does, and its inputs.
              </p>
            ) : (
              <ul className="space-y-3">
                {draft.actions.map((action) => (
                  <li key={action.id} className="space-y-2 rounded-md border border-border p-3" data-testid="action-row">
                    <div className="flex items-start gap-2">
                      <Checkbox
                        checked={action.include}
                        onCheckedChange={(checked) => updateAction(action.id, { include: checked === true })}
                        disabled={busy}
                        aria-label="Keep this action"
                        className="mt-2"
                      />
                      <Input
                        className="w-40 shrink-0"
                        aria-label="Action name"
                        placeholder="make_image"
                        value={action.name}
                        onChange={(event) => updateAction(action.id, { name: event.target.value })}
                        disabled={busy}
                      />
                      <select
                        className={selectClass}
                        aria-label="Method"
                        value={action.method}
                        onChange={(event) => updateAction(action.id, { method: event.target.value as ApiToolMethod })}
                        disabled={busy}
                      >
                        {METHODS.map((method) => (
                          <option key={method} value={method}>{method}</option>
                        ))}
                      </select>
                      <Input
                        className="min-w-0 flex-1"
                        aria-label="Path"
                        placeholder="/fal-ai/flux/dev"
                        value={action.path}
                        onChange={(event) => updateAction(action.id, { path: event.target.value })}
                        disabled={busy}
                      />
                      <button
                        type="button"
                        className="mt-2.5 shrink-0 text-muted-foreground hover:text-foreground"
                        onClick={() => setDraft((prev) => ({ ...prev, actions: prev.actions.filter((entry) => entry.id !== action.id) }))}
                        disabled={busy}
                        aria-label="Remove action"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                    <Input
                      aria-label="What this action does"
                      placeholder="One sentence, e.g. Make an image from a text prompt"
                      value={action.description}
                      onChange={(event) => updateAction(action.id, { description: event.target.value })}
                      disabled={busy}
                    />
                    <div className="space-y-1.5">
                      <div className="flex items-center justify-between">
                        <span className="text-xs text-muted-foreground">Inputs</span>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => updateAction(action.id, { inputs: [...action.inputs, emptyInput()] })}
                          disabled={busy}
                        >
                          <Plus className="mr-1 h-3 w-3" />
                          Add input
                        </Button>
                      </div>
                      {action.inputs.length === 0 ? (
                        <p className="text-xs text-muted-foreground">No inputs: the action is called as is.</p>
                      ) : (
                        <ul className="space-y-1.5">
                          {action.inputs.map((input) => (
                            <li key={input.id} className="flex items-center gap-2" data-testid="input-row">
                              <Input
                                className="w-36 shrink-0"
                                aria-label="Input name"
                                placeholder="prompt"
                                value={input.name}
                                onChange={(event) => updateInput(action.id, input.id, { name: event.target.value })}
                                disabled={busy}
                              />
                              <select
                                className={selectClass}
                                aria-label="Input type"
                                value={input.type}
                                onChange={(event) => updateInput(action.id, input.id, { type: event.target.value as ApiToolInputType })}
                                disabled={busy}
                              >
                                {INPUT_TYPES.map((entry) => (
                                  <option key={entry.value} value={entry.value}>{entry.label}</option>
                                ))}
                              </select>
                              <label className="flex items-center gap-1.5 text-xs">
                                <Checkbox
                                  checked={input.required}
                                  onCheckedChange={(checked) => updateInput(action.id, input.id, { required: checked === true })}
                                  disabled={busy}
                                />
                                required
                              </label>
                              <Input
                                className="min-w-0 flex-1"
                                aria-label="Input description"
                                placeholder="What it means (optional)"
                                value={input.description}
                                onChange={(event) => updateInput(action.id, input.id, { description: event.target.value })}
                                disabled={busy}
                              />
                              <button
                                type="button"
                                className="shrink-0 text-muted-foreground hover:text-foreground"
                                onClick={() => updateAction(action.id, { inputs: action.inputs.filter((entry) => entry.id !== input.id) })}
                                disabled={busy}
                                aria-label="Remove input"
                              >
                                <X className="h-3.5 w-3.5" />
                              </button>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {tool ? (
            <div className="space-y-1.5">
              <div className="flex items-center gap-2">
                <Button type="button" variant="outline" size="sm" onClick={() => test.mutate()} disabled={busy}>
                  {test.isPending ? "Testing…" : "Test"}
                </Button>
                <p className="text-xs text-muted-foreground">
                  Makes one call with the key attached and tells you what came back. Save first if you changed anything.
                </p>
              </div>
              {lastTestLine ? (
                <p className={`text-xs ${(lastTest ? lastTest.ok : tool.lastTestOk) ? "text-muted-foreground" : "text-destructive"}`} data-testid="last-test-line">
                  {lastTestLine}
                </p>
              ) : (
                <p className="text-xs text-muted-foreground" data-testid="last-test-line">Not tested yet.</p>
              )}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">Save the tool, then open it again to test it.</p>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => save.mutate(draftToInput(draft))} disabled={!canSubmit || busy}>
            {save.isPending ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
