import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Clapperboard, Copy, EyeOff, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import {
  bragVideosApi,
  type BragFormat,
  type BragJob,
  type BragOptions,
  type BragScene,
} from "../api/bragVideos";
import { useToastActions } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { cn } from "@/lib/utils";

const TONES = ["Confident", "Playful", "Calm and clear", "Bold"] as const;
const FORMATS: { value: BragFormat; label: string; hint: string }[] = [
  { value: "landscape", label: "Wide", hint: "For websites and slides" },
  { value: "vertical", label: "Tall", hint: "For phones and stories" },
  { value: "square", label: "Square", hint: "For social feeds" },
];

export function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : "Something went wrong. Please try again.";
}

export function BragVideoSection({ companyId, projectId }: { companyId: string; projectId: string }) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [toneToChange, setToneToChange] = useState<BragJob | null>(null);
  const jobsQuery = useQuery({
    queryKey: queryKeys.projects.bragJobs(companyId, projectId),
    queryFn: () => bragVideosApi.list(companyId, projectId),
    refetchInterval: (query) => {
      const latest = query.state.data?.[0];
      return latest && (latest.status === "planning" || latest.status === "rendering") ? 5000 : false;
    },
  });
  const jobs = jobsQuery.data ?? [];
  const latest = jobs.find((job) => job.status !== "cancelled") ?? null;

  const openNew = () => {
    setToneToChange(null);
    setDialogOpen(true);
  };

  return (
    <Card data-testid="brag-video-section">
      <CardHeader className="flex flex-row items-start justify-between gap-3">
        <div className="space-y-1">
          <CardTitle className="flex items-center gap-2 text-base">
            <Clapperboard className="h-4 w-4" aria-hidden="true" />
            Launch video
          </CardTitle>
          <CardDescription>
            A short video that shows off this project, made from its code or its website.
          </CardDescription>
        </div>
        <Button size="sm" onClick={openNew}>
          Make a launch video
        </Button>
      </CardHeader>
      <CardContent className="space-y-3">
        {jobsQuery.isLoading ? <p className="text-sm text-muted-foreground">Loading…</p> : null}
        {jobsQuery.error ? (
          <p role="alert" className="text-sm text-destructive">
            We could not load your videos. {errorMessage(jobsQuery.error)}
          </p>
        ) : null}
        {!jobsQuery.isLoading && !jobsQuery.error && !latest ? (
          <p className="text-sm text-muted-foreground">
            No video yet. Press “Make a launch video” to start. You will see a preview of each scene
            before anything is made.
          </p>
        ) : null}
        {latest ? (
          <BragJobView
            companyId={companyId}
            projectId={projectId}
            job={latest}
            onMakeAnother={openNew}
            onChangeTone={() => {
              setToneToChange(latest);
              setDialogOpen(true);
            }}
          />
        ) : null}
      </CardContent>
      <BragVideoDialog
        key={`${dialogOpen}-${toneToChange?.id ?? "new"}`}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        companyId={companyId}
        projectId={projectId}
        startFrom={toneToChange}
      />
    </Card>
  );
}

export function BragVideoDialog({
  open,
  onOpenChange,
  companyId,
  projectId,
  startFrom,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  companyId: string;
  projectId: string;
  startFrom: BragJob | null;
}) {
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const [useWebsite, setUseWebsite] = useState(Boolean(startFrom?.sourceUrl));
  const [websiteUrl, setWebsiteUrl] = useState(startFrom?.sourceUrl ?? "");
  const [tone, setTone] = useState(startFrom?.tone ?? "Confident");
  const [format, setFormat] = useState<BragFormat>(startFrom?.format ?? "landscape");
  const [music, setMusic] = useState(startFrom?.music ?? false);
  const [note, setNote] = useState(startFrom?.note ?? "");

  const options: BragOptions = {
    sourceUrl: useWebsite ? websiteUrl.trim() || null : null,
    tone: tone.trim() || null,
    format,
    lengthSeconds: 20,
    music,
    note: note.trim() || null,
  };
  const websiteMissing = useWebsite && !options.sourceUrl;

  const estimateQuery = useQuery({
    queryKey: [...queryKeys.projects.bragJobs(companyId, projectId), "estimate", options],
    queryFn: () => bragVideosApi.estimate(companyId, projectId, options),
    enabled: open && !websiteMissing,
    retry: false,
  });

  const create = useMutation({
    mutationFn: () => bragVideosApi.create(companyId, projectId, options),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: queryKeys.projects.bragJobs(companyId, projectId) });
      pushToast({ title: "We are planning your video. You will see a preview of each scene next.", tone: "success" });
      onOpenChange(false);
    },
  });

  const estimateReady = estimateQuery.data !== undefined;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{startFrom ? "Change the tone" : "Make a launch video"}</DialogTitle>
          <DialogDescription>
            Pick how it should look and sound. You will approve a preview of every scene before the
            video is made.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <Label htmlFor="brag-use-website">Use a website instead of the code</Label>
              <p className="text-xs text-muted-foreground">
                By default the video is made from this project’s code.
              </p>
            </div>
            <ToggleSwitch
              id="brag-use-website"
              checked={useWebsite}
              onCheckedChange={setUseWebsite}
              aria-label="Use a website instead of the code"
            />
          </div>
          {useWebsite ? (
            <div className="space-y-1">
              <Label htmlFor="brag-website">Website address</Label>
              <Input
                id="brag-website"
                type="url"
                placeholder="https://example.com"
                value={websiteUrl}
                onChange={(event) => setWebsiteUrl(event.target.value)}
              />
            </div>
          ) : null}
          <div className="space-y-1">
            <Label htmlFor="brag-tone">Tone</Label>
            <div className="flex flex-wrap gap-2">
              {TONES.map((preset) => (
                <Button
                  key={preset}
                  type="button"
                  size="sm"
                  variant={tone === preset ? "default" : "outline"}
                  aria-pressed={tone === preset}
                  onClick={() => setTone(preset)}
                >
                  {preset}
                </Button>
              ))}
            </div>
            <Input
              id="brag-tone"
              placeholder="Or describe it in your own words"
              value={tone}
              onChange={(event) => setTone(event.target.value)}
            />
          </div>
          <fieldset className="space-y-1">
            <legend className="text-sm font-medium">Shape</legend>
            <div className="grid grid-cols-3 gap-2">
              {FORMATS.map((item) => (
                <button
                  key={item.value}
                  type="button"
                  aria-pressed={format === item.value}
                  onClick={() => setFormat(item.value)}
                  className={cn(
                    "rounded-md border p-2 text-left text-sm",
                    format === item.value ? "border-primary bg-primary/10" : "border-border",
                  )}
                >
                  <span className="block font-medium">{item.label}</span>
                  <span className="block text-xs text-muted-foreground">{item.hint}</span>
                </button>
              ))}
            </div>
          </fieldset>
          <p className="text-sm text-muted-foreground">Length: about 20 seconds.</p>
          <div className="flex items-center justify-between gap-3">
            <Label htmlFor="brag-music">Add background music</Label>
            <ToggleSwitch
              id="brag-music"
              checked={music}
              onCheckedChange={setMusic}
              aria-label="Add background music"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="brag-note">Anything we should know? (optional)</Label>
            <Textarea
              id="brag-note"
              rows={2}
              value={note}
              onChange={(event) => setNote(event.target.value)}
            />
          </div>
          <div className="rounded-md border border-border bg-muted/40 p-3 text-sm" aria-live="polite">
            {websiteMissing ? (
              "Enter the website address to see the price."
            ) : estimateQuery.isLoading ? (
              "Working out the price…"
            ) : estimateQuery.error ? (
              <span role="alert" className="text-destructive">
                We could not work out the price, so we cannot start yet. {errorMessage(estimateQuery.error)}
              </span>
            ) : estimateReady ? (
              <>
                Expected price: <strong>{formatCents(estimateQuery.data!.estimatedCostCents)}</strong>. You
                can still stop before the video is made.
              </>
            ) : null}
          </div>
          {create.error ? (
            <p role="alert" className="text-sm text-destructive">
              We could not start the video. {errorMessage(create.error)}
            </p>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={!estimateReady || websiteMissing || create.isPending}
            onClick={() => create.mutate()}
          >
            {create.isPending ? "Starting…" : "Start"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function BragJobView({
  companyId,
  projectId,
  job,
  onMakeAnother,
  onChangeTone,
}: {
  companyId: string;
  projectId: string;
  job: BragJob;
  onMakeAnother: () => void;
  onChangeTone: () => void;
}) {
  if (job.status === "planning" || job.status === "draft") {
    return <Working text="We are planning your video. This can take a few minutes." />;
  }
  if (job.status === "rendering") {
    return <Working text="We are making your video. This can take a few minutes." />;
  }
  if (job.status === "awaiting_approval") {
    return <ContactSheet companyId={companyId} projectId={projectId} job={job} />;
  }
  if (job.status === "failed") {
    return (
      <div className="space-y-3">
        <p role="alert" className="text-sm text-destructive">
          The video could not be made. {job.failureReason ?? "Please try again."}
        </p>
        <Button size="sm" variant="outline" onClick={onMakeAnother}>
          Try again
        </Button>
      </div>
    );
  }
  return <ResultView job={job} onMakeAnother={onMakeAnother} onChangeTone={onChangeTone} />;
}

function Working({ text }: { text: string }) {
  return (
    <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
      <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
      {text}
    </p>
  );
}

function ContactSheet({ companyId, projectId, job }: { companyId: string; projectId: string; job: BragJob }) {
  const queryClient = useQueryClient();
  const { pushToast } = useToastActions();
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: queryKeys.projects.bragJobs(companyId, projectId) });
  const scenes = [...job.scenes].sort((a, b) => a.sceneOrder - b.sceneOrder);
  const kept = scenes.filter((scene) => scene.approvalStatus !== "rejected");
  const allApproved = kept.length > 0 && kept.every((scene) => scene.approvalStatus === "approved");

  const render = useMutation({
    mutationFn: () => bragVideosApi.startRender(companyId, projectId, job.id),
    onSuccess: async () => {
      await refresh();
      pushToast({ title: "Making your video now.", tone: "success" });
    },
  });

  return (
    <div className="space-y-3">
      <p className="text-sm">
        Here is a preview of each scene. Approve the ones you like, change the wording, or leave a scene
        out. Nothing is made until you press “Make the video”.
      </p>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {scenes.map((scene) => (
          <SceneCard key={scene.id} companyId={companyId} projectId={projectId} jobId={job.id} scene={scene} onChanged={refresh} />
        ))}
      </div>
      {render.error ? (
        <p role="alert" className="text-sm text-destructive">
          We could not start making the video. {errorMessage(render.error)}
        </p>
      ) : null}
      <div className="flex items-center gap-3">
        <Button size="sm" disabled={!allApproved || render.isPending} onClick={() => render.mutate()}>
          {render.isPending ? "Starting…" : "Make the video"}
        </Button>
        <span className="text-xs text-muted-foreground">
          {allApproved
            ? `Expected price: ${formatCents(job.estimatedCostCents)}`
            : "Approve every scene you want to keep first."}
        </span>
      </div>
    </div>
  );
}

function SceneCard({
  companyId,
  projectId,
  jobId,
  scene,
  onChanged,
}: {
  companyId: string;
  projectId: string;
  jobId: string;
  scene: BragScene;
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(scene.description ?? "");
  useEffect(() => setText(scene.description ?? ""), [scene.description]);

  const update = useMutation({
    mutationFn: (patch: { approvalStatus?: BragScene["approvalStatus"]; description?: string }) =>
      bragVideosApi.updateScene(companyId, projectId, jobId, scene.id, patch),
    onSuccess: () => {
      setEditing(false);
      onChanged();
    },
  });
  const leftOut = scene.approvalStatus === "rejected";

  return (
    <div className={cn("space-y-2 rounded-md border border-border p-2", leftOut && "opacity-60")}>
      {scene.stillUrl ? (
        <img src={scene.stillUrl} alt={scene.description ?? `Scene ${scene.sceneOrder + 1}`} className="aspect-video w-full rounded object-cover" />
      ) : (
        <div className="flex aspect-video w-full items-center justify-center rounded bg-muted text-xs text-muted-foreground">
          Preview not ready
        </div>
      )}
      {editing ? (
        <Textarea aria-label={`Wording for scene ${scene.sceneOrder + 1}`} rows={3} value={text} onChange={(event) => setText(event.target.value)} />
      ) : (
        <p className="text-sm">{scene.description}</p>
      )}
      {leftOut ? <p className="text-xs text-muted-foreground">Left out of the video</p> : null}
      {update.error ? (
        <p role="alert" className="text-xs text-destructive">
          Could not save that change. {errorMessage(update.error)}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {editing ? (
          <>
            <Button size="sm" disabled={update.isPending} onClick={() => update.mutate({ description: text })}>
              Save wording
            </Button>
            <Button size="sm" variant="outline" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </>
        ) : (
          <>
            <Button
              size="sm"
              variant={scene.approvalStatus === "approved" ? "default" : "outline"}
              disabled={update.isPending}
              onClick={() => update.mutate({ approvalStatus: "approved" })}
            >
              <Check className="h-3.5 w-3.5" aria-hidden="true" />
              {scene.approvalStatus === "approved" ? "Approved" : "Approve"}
            </Button>
            <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
              Change wording
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={update.isPending}
              onClick={() => update.mutate({ approvalStatus: leftOut ? "pending" : "rejected" })}
            >
              <EyeOff className="h-3.5 w-3.5" aria-hidden="true" />
              {leftOut ? "Put back" : "Leave out"}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

function ResultView({ job, onMakeAnother, onChangeTone }: { job: BragJob; onMakeAnother: () => void; onChangeTone: () => void }) {
  const { pushToast } = useToastActions();
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(job.shareCopy ?? "");
      pushToast({ title: "Copied. You can paste it anywhere.", tone: "success" });
    } catch {
      pushToast({ title: "Could not copy. Select the text and copy it by hand.", tone: "error" });
    }
  };
  return (
    <div className="space-y-3">
      {job.videoUrl ? (
        <video
          controls
          preload="metadata"
          poster={job.posterUrl ?? undefined}
          src={job.videoUrl}
          className="max-h-[420px] w-full rounded-md bg-black"
        />
      ) : (
        <p role="alert" className="text-sm text-destructive">
          The video is finished but we cannot find the file. Please make it again.
        </p>
      )}
      {job.shareCopy ? (
        <div className="space-y-1">
          <Label>Text to post with it</Label>
          <p className="whitespace-pre-wrap rounded-md border border-border bg-muted/40 p-2 text-sm">{job.shareCopy}</p>
          <Button size="sm" variant="outline" onClick={copy}>
            <Copy className="h-3.5 w-3.5" aria-hidden="true" />
            Copy text
          </Button>
        </div>
      ) : null}
      <p className="text-xs text-muted-foreground">Nothing is posted anywhere for you. Share it yourself when you are ready.</p>
      <div className="flex gap-2">
        <Button size="sm" onClick={onMakeAnother}>Make another</Button>
        <Button size="sm" variant="outline" onClick={onChangeTone}>Change the tone</Button>
      </div>
    </div>
  );
}
