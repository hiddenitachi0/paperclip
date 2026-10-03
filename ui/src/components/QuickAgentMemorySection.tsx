import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { agentMemoriesApi, type AgentMemoryList, type AgentMemoryNote } from "../api/agentMemories";
import { ApiError } from "../api/client";
import { queryKeys } from "../lib/queryKeys";
import { timeAgo } from "../lib/timeAgo";
import { useToastActions } from "../context/ToastContext";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";

/**
 * Quick-agent memory notebook, on the quick agent's page: the notes it was
 * asked to remember in chat, and notes the operator adds here. Every change
 * saves at once. When the agent has a persona, the notebook is that person's
 * and is shared by every job they hold; the card says so.
 *
 * The server decides who may see and change it (the same people who may
 * change the agent's quick settings); when it refuses, the card says so in
 * one sentence instead of showing an error.
 */
export function QuickAgentMemorySection({ agentId }: { agentId: string }) {
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const [draft, setDraft] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const [confirmClear, setConfirmClear] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const listQuery = useQuery({
    queryKey: queryKeys.agentMemories.list(agentId),
    queryFn: () => agentMemoriesApi.list(agentId),
    retry: false,
  });

  const refresh = () => queryClient.invalidateQueries({ queryKey: queryKeys.agentMemories.list(agentId) });
  const failed = (fallback: string) => (err: unknown) => setError(err instanceof ApiError ? err.message : fallback);

  const addMutation = useMutation({
    mutationFn: (text: string) => agentMemoriesApi.add(agentId, text),
    onSuccess: () => {
      setDraft("");
      setError(null);
      void refresh();
      pushToast({ title: "Note saved", tone: "success" });
    },
    onError: failed("Could not save the note"),
  });

  const updateMutation = useMutation({
    mutationFn: (input: { id: string; text: string }) => agentMemoriesApi.update(agentId, input.id, input.text),
    onSuccess: () => {
      setEditingId(null);
      setError(null);
      void refresh();
      pushToast({ title: "Note saved", tone: "success" });
    },
    onError: failed("Could not save the note"),
  });

  const removeMutation = useMutation({
    mutationFn: (id: string) => agentMemoriesApi.remove(agentId, id),
    onSuccess: () => {
      setError(null);
      void refresh();
      pushToast({ title: "Note deleted", tone: "success" });
    },
    onError: failed("Could not delete the note"),
  });

  const clearMutation = useMutation({
    mutationFn: () => agentMemoriesApi.clear(agentId),
    onSuccess: (result) => {
      setConfirmClear(false);
      setError(null);
      void refresh();
      pushToast({ title: result.deleted === 1 ? "1 note deleted" : `${result.deleted} notes deleted`, tone: "success" });
    },
    onError: failed("Could not delete the notes"),
  });

  const refused = listQuery.error instanceof ApiError && listQuery.error.status === 403;
  const data: AgentMemoryList | undefined = listQuery.data;
  const notes = data?.notes ?? [];
  const maxLength = data?.maxLength ?? 500;
  const maxNotes = data?.maxNotes ?? 100;
  const full = notes.length >= maxNotes;
  const busy = addMutation.isPending || updateMutation.isPending || removeMutation.isPending || clearMutation.isPending;

  const whose =
    data?.owner.kind === "persona"
      ? `These notes belong to ${data.owner.name ?? "the person attached to this agent"} and are shared by every job they hold.`
      : "These notes belong to this agent.";

  return (
    <Card data-testid="quick-agent-memory">
      <CardHeader>
        <CardTitle>Memory</CardTitle>
        <CardDescription>
          Things this quick agent was asked to remember. It reads them at the start of every conversation. Ask it in chat
          to remember or forget something, or change the notes here. Changes save at once.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {listQuery.isLoading ? (
          <p className="text-xs text-muted-foreground">Loading notes…</p>
        ) : refused ? (
          <p className="text-xs text-muted-foreground" data-testid="memory-refused">
            Only people who can change this agent's settings can see and change its memory.
          </p>
        ) : listQuery.error ? (
          <p className="text-xs text-destructive">
            {listQuery.error instanceof ApiError ? listQuery.error.message : "Could not load the notes."}
          </p>
        ) : (
          <>
            <p className="text-xs text-muted-foreground">
              {whose} {notes.length} of {maxNotes} notes used.
            </p>

            {notes.length === 0 ? (
              <p className="text-sm text-muted-foreground" data-testid="memory-empty">
                Nothing yet. Say "remember that …" in a chat, or add a note below.
              </p>
            ) : (
              <ul className="space-y-2" data-testid="memory-list">
                {notes.map((note) => (
                  <li key={note.id} className="rounded-md border border-border p-2 space-y-1.5" data-testid="memory-note">
                    {editingId === note.id ? (
                      <>
                        <Textarea
                          value={editText}
                          onChange={(event) => setEditText(event.target.value)}
                          maxLength={maxLength}
                          rows={2}
                          aria-label="Edit note"
                        />
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-xs text-muted-foreground">{editText.trim().length} / {maxLength}</span>
                          <div className="flex gap-2">
                            <Button variant="ghost" size="sm" onClick={() => setEditingId(null)} disabled={busy}>
                              Cancel
                            </Button>
                            <Button
                              size="sm"
                              onClick={() => updateMutation.mutate({ id: note.id, text: editText })}
                              disabled={busy || !editText.trim() || editText.trim() === note.text}
                            >
                              Save
                            </Button>
                          </div>
                        </div>
                      </>
                    ) : (
                      <>
                        <p className="text-sm whitespace-pre-wrap break-words">{note.text}</p>
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-xs text-muted-foreground">{describeOrigin(note)}</span>
                          <div className="flex gap-1">
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => {
                                setEditingId(note.id);
                                setEditText(note.text);
                                setError(null);
                              }}
                              disabled={busy}
                              aria-label={`Edit note: ${note.text}`}
                            >
                              Edit
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => removeMutation.mutate(note.id)}
                              disabled={busy}
                              aria-label={`Delete note: ${note.text}`}
                            >
                              Delete
                            </Button>
                          </div>
                        </div>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            )}

            <div className="space-y-1.5">
              <Textarea
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                maxLength={maxLength}
                rows={2}
                placeholder={full ? "The memory is full. Delete a note to add another." : "Add a note, e.g. I prefer short answers in Norwegian."}
                disabled={full}
                aria-label="New note"
              />
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs text-muted-foreground">{draft.trim().length} / {maxLength}</span>
                <Button size="sm" onClick={() => addMutation.mutate(draft)} disabled={busy || full || !draft.trim()}>
                  Add note
                </Button>
              </div>
            </div>

            {notes.length > 0 && (
              <div className="flex items-center justify-end gap-2" data-testid="memory-clear">
                {confirmClear ? (
                  <>
                    <span className="text-xs text-destructive">
                      Delete all {notes.length} {notes.length === 1 ? "note" : "notes"}? This cannot be undone.
                    </span>
                    <Button variant="ghost" size="sm" onClick={() => setConfirmClear(false)} disabled={busy}>
                      Cancel
                    </Button>
                    <Button variant="destructive" size="sm" onClick={() => clearMutation.mutate()} disabled={busy}>
                      Yes, delete all
                    </Button>
                  </>
                ) : (
                  <Button variant="outline" size="sm" onClick={() => setConfirmClear(true)} disabled={busy}>
                    Clear all
                  </Button>
                )}
              </div>
            )}

            {error && (
              <p className="text-xs text-destructive" role="alert">
                {error}
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

/** "Saved in chat, asked by Filip, 2d ago" / "Added here by Filip, just now". */
function describeOrigin(note: AgentMemoryNote): string {
  const who = note.createdByName ?? null;
  const when = timeAgo(note.createdAt);
  const edited = note.updatedAt !== note.createdAt ? " (edited)" : "";
  if (note.source === "agent") return `Saved in chat${who ? `, asked by ${who}` : ""}, ${when}${edited}`;
  return `Added here${who ? ` by ${who}` : ""}, ${when}${edited}`;
}
