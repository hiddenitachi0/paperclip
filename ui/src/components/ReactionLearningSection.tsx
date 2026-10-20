import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { agentMemoriesApi, type AgentMemoryNote } from "../api/agentMemories";
import { agentReactionsApi, type AgentReaction } from "../api/agentReactions";
import { agentsApi } from "../api/agents";
import { ApiError } from "../api/client";
import { queryKeys } from "../lib/queryKeys";
import { timeAgo } from "../lib/timeAgo";
import { useToastActions } from "../context/ToastContext";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { SettingsSection } from "./SettingsSection";

/**
 * "What <agent> has learned from your reactions", on a quick agent's page:
 * the short notes the agent wrote for itself after you reacted to its Telegram
 * messages with an emoji. You can reword or delete any of them; every change
 * saves at once.
 *
 * The notes live in the same notebook as the Memory card (they are the ones
 * marked as learned from reactions), so editing and deleting use the same
 * routes. A switch turns the learning off for this agent, and a list shows the
 * latest reactions. When the server refuses, the card says so in one sentence.
 */
const REACTIONS_PAGE = 25;

export function ReactionLearningSection({
  agentId,
  agentName,
  companyId,
}: {
  agentId: string;
  agentName: string;
  companyId?: string;
}) {
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [reactionLimit, setReactionLimit] = useState(REACTIONS_PAGE);

  const reactionsQuery = useQuery({
    queryKey: queryKeys.agentReactions.list(agentId, reactionLimit),
    queryFn: () => agentReactionsApi.list(agentId, reactionLimit),
    retry: false,
    placeholderData: (previous) => previous,
  });

  const listQuery = useQuery({
    queryKey: queryKeys.agentMemories.list(agentId),
    queryFn: () => agentMemoriesApi.list(agentId),
    retry: false,
  });

  const refresh = () => queryClient.invalidateQueries({ queryKey: queryKeys.agentMemories.list(agentId) });
  const failed = (fallback: string) => (err: unknown) => setError(err instanceof ApiError ? err.message : fallback);

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

  const switchMutation = useMutation({
    mutationFn: (enabled: boolean) => agentsApi.update(agentId, { reactionLearningEnabled: enabled }, companyId),
    onSuccess: (_agent, enabled) => {
      setError(null);
      void queryClient.invalidateQueries({ queryKey: ["agent-reactions", agentId] });
      void queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(agentId) });
      pushToast({
        title: enabled ? `${agentName} is learning from your reactions` : `${agentName} has stopped learning from your reactions`,
        tone: "success",
      });
    },
    onError: failed("Could not change this setting"),
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

  const refused = listQuery.error instanceof ApiError && listQuery.error.status === 403;
  const data = listQuery.data;
  const notes = (data?.notes ?? []).filter((note) => note.source === "reaction");
  const maxLength = data?.maxLength ?? 500;
  const busy = updateMutation.isPending || removeMutation.isPending;
  const reactions = reactionsQuery.data;
  const learningOn = reactions?.reactionLearningEnabled ?? true;

  return (
    <SettingsSection
      title={`What ${agentName} has learned from your reactions`}
      description={`When you react to a message in Telegram with an emoji, ${agentName} notes what you liked or did not like and uses it in later answers. Reword or delete any note here. Changes save at once.`}
      summary={data ? (notes.length === 1 ? "1 note" : `${notes.length} notes`) : undefined}
      storageKey="agent.quickAgent.reactionLearning"
      data-testid="reaction-learning"
      contentClassName="space-y-3"
    >
      {listQuery.isLoading ? (
        <p className="text-xs text-muted-foreground">Loading notes…</p>
      ) : refused ? (
        <p className="text-xs text-muted-foreground" data-testid="reaction-learning-refused">
          Only people who can change this agent's settings can see and change what it has learned.
        </p>
      ) : listQuery.error ? (
        <p className="text-xs text-destructive">
          {listQuery.error instanceof ApiError ? listQuery.error.message : "Could not load the notes."}
        </p>
      ) : (
        <>
          <div className="flex items-center justify-between gap-4 text-sm" data-testid="reaction-learning-switch">
            <div className="space-y-1">
              <div>Learn from my reactions</div>
              <p className="text-xs text-muted-foreground">
                {learningOn
                  ? `${agentName} notes what you liked or did not like.`
                  : `Off. ${agentName} ignores new reactions and adds no new notes. Notes it already has are kept.`}
              </p>
            </div>
            <ToggleSwitch
              checked={learningOn}
              onCheckedChange={(next) => switchMutation.mutate(next)}
              disabled={!reactions || switchMutation.isPending}
              aria-label="Learn from my reactions"
            />
          </div>

          {notes.length === 0 ? (
            <p className="text-sm text-muted-foreground" data-testid="reaction-learning-empty">
              {learningOn
                ? `Nothing yet. React to one of ${agentName}'s messages in Telegram and it will learn from it.`
                : "Nothing learned yet."}
            </p>
          ) : (
            <ul className="space-y-2" data-testid="reaction-learning-list">
              {notes.map((note) => (
                <li key={note.id} className="rounded-md border border-border p-2 space-y-1.5" data-testid="reaction-learning-note">
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
                        <span className="text-xs text-muted-foreground">{describeWhen(note)}</span>
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

          <div className="space-y-2 pt-1" data-testid="recent-reactions">
            <h4 className="text-sm font-medium">Recent reactions</h4>
            {reactionsQuery.isLoading ? (
              <p className="text-xs text-muted-foreground">Loading reactions…</p>
            ) : reactionsQuery.error ? (
              <p className="text-xs text-destructive">Could not load your recent reactions.</p>
            ) : !reactions || reactions.items.length === 0 ? (
              <p className="text-sm text-muted-foreground" data-testid="recent-reactions-empty">
                No reactions yet.
              </p>
            ) : (
              <>
                <ul className="space-y-1.5">
                  {reactions.items.map((item) => (
                    <li
                      key={item.id}
                      className="flex items-start gap-2 rounded-md border border-border p-2"
                      data-testid="recent-reaction"
                    >
                      <span className="text-lg leading-none" aria-hidden="true">
                        {item.emoji}
                      </span>
                      <div className="min-w-0 flex-1 space-y-0.5">
                        <p className="text-sm break-words">{describeTarget(item)}</p>
                        <p className="text-xs text-muted-foreground">{describeReaction(item)}</p>
                      </div>
                    </li>
                  ))}
                </ul>
                {reactions.hasMore && reactionLimit < 100 && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setReactionLimit((current) => Math.min(100, current + REACTIONS_PAGE))}
                    disabled={reactionsQuery.isFetching}
                  >
                    Show more
                  </Button>
                )}
              </>
            )}
          </div>

          {error && (
            <p className="text-xs text-destructive" role="alert">
              {error}
            </p>
          )}
        </>
      )}
    </SettingsSection>
  );
}

/** "Learned 2d ago" / "Learned 2d ago (edited)". */
function describeWhen(note: AgentMemoryNote): string {
  const edited = note.updatedAt !== note.createdAt ? " (edited)" : "";
  return `Learned ${timeAgo(note.createdAt)}${edited}`;
}

const MEANING_LABEL = { positive: "Liked", negative: "Did not like", neutral: "Reacted" } as const;

/** What the reaction was on: the picture or the reply. */
function describeTarget(item: AgentReaction): string {
  if (item.picture) {
    const what = item.picture.look ?? item.picture.promptExcerpt;
    return what ? `Picture: ${what}` : "A picture";
  }
  return item.message.excerpt ? `“${item.message.excerpt}”` : "A message that is no longer available";
}

/** "Liked · 2d ago" / "Liked · taken back 1h ago". */
function describeReaction(item: AgentReaction): string {
  const label = item.meaning ? MEANING_LABEL[item.meaning] : "Reacted";
  if (!item.active && item.removedAt) return `${label} · taken back ${timeAgo(item.removedAt)}`;
  return `${label} · ${timeAgo(item.reactedAt)}`;
}
