import { useEffect, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  BRAG_MAX_LENGTH_SECONDS,
  BRAG_MIN_LENGTH_SECONDS,
  BRAG_OVERRUN_ABORT_MULTIPLIER,
  BRAG_TONES,
  type BragFormat,
} from "@paperclipai/shared";
import { ApiError } from "../api/client";
import { bragApi, bragFilePath, bragSceneStillPath, type BragJob, type BragScene } from "../api/brag";
import { useToastActions } from "../context/ToastContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * "Make a brag video" on a project page. Three steps: pick the options and see
 * the price, check a picture of every scene, then watch the finished video.
 * Nothing is posted anywhere; the video is only saved and shown here.
 */

const DEFAULT_LENGTH_SECONDS = 20;
const TONE_LABELS: Record<(typeof BRAG_TONES)[number], string> = {
  hype: "Hype",
  calm: "Calm and professional",
  playful: "Fun and playful",
  serious: "Serious",
  technical: "Technical",
};
const FORMATS: { value: BragFormat; label: string }[] = [
  { value: "landscape", label: "Wide" },
  { value: "vertical", label: "Tall (phone)" },
  { value: "square", label: "Square" },
];

function dollars(cents: number) {
  return `$${(cents / 100).toFixed(2)}`;
}

function errorText(err: unknown, fallback: string) {
  return err instanceof ApiError ? err.message : fallback;
}

export function BragVideoDialog({
  open,
  onOpenChange,
  companyId,
  projectId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  companyId: string;
  projectId: string;
}) {
  const { pushToast } = useToastActions();
  const [useWebsite, setUseWebsite] = useState(false);
  const [website, setWebsite] = useState("");
  const [tone, setTone] = useState<(typeof BRAG_TONES)[number] | undefined>(BRAG_TONES[0]);
  const [format, setFormat] = useState<BragFormat>("landscape");
  const [lengthSeconds, setLengthSeconds] = useState(DEFAULT_LENGTH_SECONDS);
  const [music, setMusic] = useState(false);
  const [note, setNote] = useState("");
  const [job, setJob] = useState<BragJob | null>(null);
  const [scenes, setScenes] = useState<BragScene[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [editingScene, setEditingScene] = useState<{ id: string; text: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const reset = () => {
    setJob(null);
    setScenes([]);
    setError(null);
    setEditingScene(null);
    setCopied(false);
  };

  useEffect(() => {
    if (!open) reset();
  }, [open]);

  const estimate = useQuery({
    queryKey: ["brag-estimate", companyId, lengthSeconds, music],
    queryFn: () => bragApi.estimate(companyId, { lengthSeconds, music }),
    enabled: open && !job,
  });

  const create = useMutation({
    mutationFn: async () => {
      const created = await bragApi.createJob(companyId, {
        projectId,
        sourceUrl: useWebsite ? website.trim() : undefined,
        tone,
        format,
        lengthSeconds,
        music,
        note: note.trim() || undefined,
      });
      return bragApi.planJob(companyId, created.id);
    },
    onSuccess: (planned) => {
      setError(null);
      setJob(planned.job);
      setScenes(planned.scenes);
    },
    onError: (err) => setError(errorText(err, "Could not start the video. Please try again.")),
  });

  const updateScene = useMutation({
    mutationFn: (v: { sceneId: string; action: "approve" | "edit" | "leave_out"; description?: string }) =>
      bragApi.updateScene(companyId, job!.id, v.sceneId, { action: v.action, description: v.description }),
    onSuccess: (updated) => {
      setError(null);
      setEditingScene(null);
      setScenes(updated);
    },
    onError: (err) => setError(errorText(err, "Could not change that scene. Please try again.")),
  });

  const render = useMutation({
    mutationFn: () => bragApi.render(companyId, job!.id),
    onSuccess: (done) => {
      setError(null);
      setJob(done.job);
      setScenes(done.scenes);
      pushToast({ title: "Your video is ready", tone: "success" });
    },
    onError: (err) => setError(errorText(err, "The video could not be finished. Please try again.")),
  });

  const websiteValid = !useWebsite || /^https:\/\/\S+\.\S+/.test(website.trim());
  const keptScenes = scenes.filter((s) => s.approvalStatus !== "rejected");
  const allApproved = keptScenes.length > 0 && keptScenes.every((s) => s.approvalStatus === "approved");
  const busy = create.isPending || updateScene.isPending || render.isPending;
  const result = job?.status === "completed" ? job : null;
  const shareText = result?.options.shareCopy ?? "";

  const copyShare = async () => {
    try {
      await navigator.clipboard.writeText(shareText);
      setCopied(true);
    } catch {
      setError("Could not copy the text. Please select it and copy it by hand.");
    }
  };

  const makeAnother = () => {
    reset();
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Make a brag video</DialogTitle>
          <DialogDescription>
            {result
              ? "Your short video is ready. It is saved to your files and has not been posted anywhere."
              : job
                ? "Check the picture for each scene. Keep the ones you like, change a few words, or leave one out."
                : "A short video that shows off this project. You will see a picture of every scene before the video is made."}
          </DialogDescription>
        </DialogHeader>

        {error ? (
          <div role="alert" className="rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-sm text-red-300">
            {error}
          </div>
        ) : null}

        {result ? (
          <div className="space-y-4">
            <video
              data-testid="brag-video"
              controls
              poster={result.options.posterFileId ? bragFilePath(result.options.posterFileId) : undefined}
              src={result.options.videoFileId ? bragFilePath(result.options.videoFileId) : undefined}
              className="w-full rounded-md bg-black"
            />
            <div className="space-y-1.5">
              <Label htmlFor="brag-share">Text to share with it</Label>
              <Textarea id="brag-share" readOnly value={shareText} />
              <Button type="button" variant="outline" size="sm" onClick={copyShare}>
                {copied ? "Copied" : "Copy text"}
              </Button>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={makeAnother}>
                Make another
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  reset();
                  setTone(undefined);
                }}
              >
                Change the tone
              </Button>
              <Button type="button" onClick={() => onOpenChange(false)}>
                Done
              </Button>
            </DialogFooter>
          </div>
        ) : job ? (
          <div className="space-y-4">
            <ul className="grid gap-3 sm:grid-cols-2">
              {scenes.map((scene) => {
                const left = scene.approvalStatus === "rejected";
                return (
                  <li key={scene.id} className={`rounded-md border border-border p-2 space-y-2 ${left ? "opacity-50" : ""}`}>
                    {scene.stillRef ? (
                      <img
                        src={bragSceneStillPath(companyId, job.id, scene.id)}
                        alt={`Scene ${scene.sceneOrder}`}
                        className="w-full rounded"
                      />
                    ) : (
                      <div className="flex h-24 items-center justify-center rounded bg-muted text-xs text-muted-foreground">
                        No picture yet
                      </div>
                    )}
                    {editingScene?.id === scene.id ? (
                      <div className="space-y-2">
                        <Textarea
                          aria-label={`Describe scene ${scene.sceneOrder}`}
                          value={editingScene.text}
                          onChange={(e) => setEditingScene({ id: scene.id, text: e.target.value })}
                        />
                        <div className="flex gap-2">
                          <Button
                            type="button"
                            size="sm"
                            disabled={busy || !editingScene.text.trim()}
                            onClick={() => updateScene.mutate({ sceneId: scene.id, action: "edit", description: editingScene.text.trim() })}
                          >
                            Save change
                          </Button>
                          <Button type="button" size="sm" variant="ghost" onClick={() => setEditingScene(null)}>
                            Cancel
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <>
                        <p className="text-sm">{scene.description}</p>
                        <p className="text-xs text-muted-foreground">
                          {left ? "Left out" : scene.approvalStatus === "approved" ? "Approved" : "Waiting for you"}
                        </p>
                        <div className="flex flex-wrap gap-2">
                          {left ? (
                            <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => updateScene.mutate({ sceneId: scene.id, action: "approve" })}>
                              Put back
                            </Button>
                          ) : (
                            <>
                              {scene.approvalStatus !== "approved" ? (
                                <Button type="button" size="sm" disabled={busy || !scene.stillRef} onClick={() => updateScene.mutate({ sceneId: scene.id, action: "approve" })}>
                                  Approve
                                </Button>
                              ) : null}
                              <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => setEditingScene({ id: scene.id, text: scene.description ?? "" })}>
                                Change
                              </Button>
                              <Button type="button" size="sm" variant="ghost" disabled={busy} onClick={() => updateScene.mutate({ sceneId: scene.id, action: "leave_out" })}>
                                Leave out
                              </Button>
                            </>
                          )}
                        </div>
                      </>
                    )}
                  </li>
                );
              })}
            </ul>
            <DialogFooter>
              <p className="mr-auto self-center text-xs text-muted-foreground">
                {allApproved ? "Every scene is approved." : "Approve every scene you want to keep."}
              </p>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={render.isPending}>
                Close
              </Button>
              <Button type="button" disabled={busy || !allApproved} onClick={() => render.mutate()}>
                {render.isPending ? "Making your video…" : "Make the video"}
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label>What should the video show?</Label>
              <div className="flex gap-2">
                <Button type="button" size="sm" variant={useWebsite ? "outline" : "default"} onClick={() => setUseWebsite(false)}>
                  This project's files
                </Button>
                <Button type="button" size="sm" variant={useWebsite ? "default" : "outline"} onClick={() => setUseWebsite(true)}>
                  A website
                </Button>
              </div>
              {useWebsite ? (
                <>
                  <Input
                    aria-label="Website address"
                    value={website}
                    onChange={(e) => setWebsite(e.target.value)}
                    placeholder="https://example.com"
                  />
                  {website && !websiteValid ? (
                    <p className="text-xs text-red-400">The address must start with https://</p>
                  ) : null}
                </>
              ) : null}
            </div>

            <div className="space-y-1.5">
              <Label>How should it feel?</Label>
              <div className="flex flex-wrap gap-2">
                {BRAG_TONES.map((t) => (
                  <Button key={t} type="button" size="sm" variant={tone === t ? "default" : "outline"} onClick={() => setTone(t)}>
                    {TONE_LABELS[t]}
                  </Button>
                ))}
              </div>
            </div>

            <div className="space-y-1.5">
              <Label>Shape</Label>
              <div className="flex flex-wrap gap-2">
                {FORMATS.map((f) => (
                  <Button key={f.value} type="button" size="sm" variant={format === f.value ? "default" : "outline"} onClick={() => setFormat(f.value)}>
                    {f.label}
                  </Button>
                ))}
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="brag-length">How long (seconds)</Label>
              <Input
                id="brag-length"
                type="number"
                min={BRAG_MIN_LENGTH_SECONDS}
                max={BRAG_MAX_LENGTH_SECONDS}
                value={lengthSeconds}
                onChange={(e) =>
                  setLengthSeconds(
                    Math.max(BRAG_MIN_LENGTH_SECONDS, Math.min(BRAG_MAX_LENGTH_SECONDS, Math.round(Number(e.target.value) || DEFAULT_LENGTH_SECONDS))),
                  )
                }
              />
            </div>

            <div className="flex items-center justify-between">
              <Label htmlFor="brag-music">Add music</Label>
              <ToggleSwitch id="brag-music" checked={music} onCheckedChange={setMusic} aria-label="Add music" />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="brag-note">Anything we should mention? (optional)</Label>
              <Textarea id="brag-note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} />
            </div>

            <p className="text-sm" data-testid="brag-cost">
              {estimate.isError
                ? "We could not work out the price. Please try again."
                : estimate.data
                  ? `Expected price: about ${dollars(estimate.data.estimatedCostCents)}. It will never go past ${dollars(estimate.data.estimatedCostCents * BRAG_OVERRUN_ABORT_MULTIPLIER)}.`
                  : "Working out the price…"}
            </p>

            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="button" disabled={busy || !estimate.data || !websiteValid || (useWebsite && !website.trim())} onClick={() => create.mutate()}>
                {create.isPending ? "Preparing pictures…" : "Show me the pictures"}
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
