import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { HelpCircle, Crop, X, Send, Eye, RotateCcw, Loader2, ImagePlus, FolderOpen, Search } from "lucide-react";
import {
  HELPER_INVESTIGATIONS_LIST_LIMIT,
  HELPER_MESSAGE_MAX_CHARS,
  HELPER_PICTURES_MAX,
  type HelperAskResponse,
  type HelperDroppedReference,
  type HelperInvestigationList,
  type HelperModelOption,
  type HelperPictureInput,
} from "@paperclipai/shared";
import { useLocation } from "@/lib/router";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useCompany } from "../../context/CompanyContext";
import { helperApi } from "../../api/helper";
import { queryKeys } from "../../lib/queryKeys";
import { captureHelperContext, rectFromPoints, viewportRect, type HelperCapture, type HelperRect } from "../../lib/helper-capture";
import { applyHelperAnswer, canApplyHelperAnswer, extractApplicableText, useHelperApplyTargets } from "../../lib/helper-apply";
import { groupEntries, type CatalogueItem } from "../../lib/model-catalogue";
import { MarkdownBody } from "../MarkdownBody";
import { HelperFilePicker } from "./HelperFilePicker";
import {
  HELPER_PICTURE_ACCEPT,
  companyFilePicture,
  filesToHelperPictures,
  picturesFromClipboard,
  type HelperAttachedPicture,
} from "./helper-pictures";
import { effectiveHelperModel, helperStatusText, isHelperStatusReady, sortByReadiness } from "./helper-model-status";
import {
  DroppedReferencesNotice,
  HELPER_INVESTIGATION_POLL_MS,
  InvestigateConfirm,
  MyInvestigations,
  isInvestigationActive,
  type InvestigationDraft,
} from "./HelperInvestigations";

/**
 * "Ask Paperclip" — the floating helper (Phase 1).
 *
 * Phase 2: the person can attach up to 4 pictures (upload, paste, or pick
 * one from the company's Files) to a question. Only a model that can see
 * pictures may answer it; otherwise the panel says so and offers those that
 * can. Each model in the picker shows whether it is ready.
 *
 * A small "Ask" button (and Ctrl/Cmd+Shift+H) opens a side panel. The
 * person can mark an area of the page (drag a rectangle, like a snipping
 * tool); the panel then shows exactly the text the helper will see before
 * anything is sent. Answers can be applied to an opted-in text field that was
 * inside the marked area; the person still presses the page's own Save.
 *
 * The panel and the marking layer carry data-helper-ignore so they are never
 * part of what is captured. Conversation turns live in this component only
 * (gone on reload); nothing is remembered on the server.
 *
 * Phase 3: "Investigate deeper" hands a question (typed, or one already
 * answered) to the company's investigation agent as a normal task, after the
 * person sees who will look, what it usually takes and costs, and that it is
 * advice only. The quick helper may suggest it; it never starts by itself.
 * "My investigations" is fetched from the server (so it survives a reload)
 * and polled while any is running.
 */

interface Turn {
  role: "user" | "assistant";
  content: string;
  meta?: Pick<HelperAskResponse, "modelLabel" | "costCents" | "truncated">;
  /** Fields the person marked when asking this question. */
  applyTargets?: string[];
  /** Pictures attached to this question (previews only; not sent again with later questions). */
  pictures?: Array<{ key: string; name: string; previewUrl: string }>;
  /** What was sent with this question, so "Investigate deeper" can hand the same to an agent. */
  context?: string | null;
  pageRoute?: string | null;
  references?: string[];
  pictureInputs?: HelperPictureInput[];
  /** The quick model said this needs a closer look (Phase 3). */
  suggestInvestigation?: boolean;
}

/** History text for an earlier question that had pictures: the model knows they existed, they are not resent. */
export function historyContentOf(turn: Pick<Turn, "content" | "pictures">): string {
  const n = turn.pictures?.length ?? 0;
  if (n === 0) return turn.content;
  return `${turn.content}\n\n[${n === 1 ? "1 picture was" : `${n} pictures were`} attached to this question; they are not sent again.]`;
}

const SHORTCUT_LABEL = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘⇧H" : "Ctrl+Shift+H";

export function isHelperShortcut(event: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "shiftKey" | "altKey">): boolean {
  return (event.ctrlKey || event.metaKey) && event.shiftKey && !event.altKey && event.key.toLowerCase() === "h";
}

function toCatalogueItem(option: HelperModelOption): CatalogueItem & { option: HelperModelOption } {
  return {
    id: option.id,
    name: option.name,
    provider: option.provider,
    model: option.model,
    baseUrl: null,
    note: null,
    maker: option.maker,
    baseModel: option.baseModel,
    lane: (option.lane as CatalogueItem["lane"]) ?? null,
    availability: null,
    tags: [],
    specs: null,
    favorite: option.favorite,
    archivedAt: null,
    family: null,
    variant: null,
    ratings: [],
    providerRouting: null,
    option,
  };
}

function describeError(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  return "The helper could not answer. Try again.";
}

export function HelperOverlay() {
  const { selectedCompanyId, selectedCompany } = useCompany();
  const location = useLocation();
  const [open, setOpen] = useState(false);
  const [marking, setMarking] = useState(false);
  const [drag, setDrag] = useState<{ x: number; y: number; x2: number; y2: number } | null>(null);
  const [markedRect, setMarkedRect] = useState<HelperRect | null>(null);
  const [capture, setCapture] = useState<HelperCapture | null>(null);
  const [seeOpen, setSeeOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [entryId, setEntryId] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [appliedNote, setAppliedNote] = useState<string | null>(null);
  const [pictures, setPictures] = useState<HelperAttachedPicture[]>([]);
  const [pictureProblems, setPictureProblems] = useState<string[]>([]);
  const [filePickerOpen, setFilePickerOpen] = useState(false);
  const [draft, setDraft] = useState<(InvestigationDraft & { fromComposer: boolean }) | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const [startedIds, setStartedIds] = useState<string[]>([]);
  const [droppedNotice, setDroppedNotice] = useState<HelperDroppedReference[]>([]);
  const queryClient = useQueryClient();
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const registeredTargets = useHelperApplyTargets();

  const route = `${location.pathname}${location.search}`;

  const settingsQuery = useQuery({
    queryKey: queryKeys.companies.helperSettings(selectedCompanyId ?? ""),
    queryFn: () => helperApi.getSettings(selectedCompanyId!),
    enabled: open && Boolean(selectedCompanyId),
    staleTime: 60_000,
  });
  const settings = settingsQuery.data;
  const investigationsKey = queryKeys.companies.helperInvestigations(selectedCompanyId ?? "");
  const investigationsQuery = useQuery({
    queryKey: investigationsKey,
    queryFn: () => helperApi.listInvestigations(selectedCompanyId!),
    enabled: open && Boolean(selectedCompanyId),
    // Live while any is waiting or working, and only while the panel is open.
    refetchInterval: (query) =>
      query.state.data?.investigations.some(isInvestigationActive) ? HELPER_INVESTIGATION_POLL_MS : false,
    refetchOnWindowFocus: true,
  });
  const investigations = investigationsQuery.data?.investigations ?? [];
  const openInvestigationIds = useMemo(
    () => new Set([...startedIds, ...(investigations[0] ? [investigations[0].id] : [])]),
    [startedIds, investigations],
  );
  const startInvestigation = useMutation({
    mutationFn: (input: InvestigationDraft) =>
      helperApi.startInvestigation(selectedCompanyId!, {
        question: input.question,
        context: input.context,
        pageRoute: input.pageRoute,
        references: input.references,
        quickAnswer: input.quickAnswer,
        ...(input.pictures.length > 0 ? { pictures: input.pictures } : {}),
      }),
    onSuccess: (view) => {
      queryClient.setQueryData<HelperInvestigationList>(investigationsKey, (prev) =>
        prev
          ? { ...prev, investigations: [view, ...prev.investigations.filter((i) => i.id !== view.id)].slice(0, HELPER_INVESTIGATIONS_LIST_LIMIT) }
          : prev,
      );
      void queryClient.invalidateQueries({ queryKey: investigationsKey });
      setStartedIds((prev) => [view.id, ...prev]);
      setDroppedNotice(view.droppedReferences ?? []);
      if (draft?.fromComposer) {
        setMessage("");
        setPictures([]);
        setPictureProblems([]);
      }
      setDraft(null);
      setStartError(null);
    },
    onError: (err) => {
      setStartError(describeError(err));
      void queryClient.invalidateQueries({ queryKey: investigationsKey });
    },
  });
  // Ready models first: groups with a ready model first, and ready models first inside each group.
  const groups = useMemo(() => {
    const grouped = groupEntries((settings?.models ?? []).map(toCatalogueItem), "maker").map((group) => ({
      ...group,
      entries: sortByReadiness(group.entries),
    }));
    return grouped
      .map((group, index) => ({ group, index, ready: group.entries.some((e) => isHelperStatusReady(e.option.status)) }))
      .sort((a, b) => Number(b.ready) - Number(a.ready) || a.index - b.index)
      .map(({ group }) => group);
  }, [settings?.models]);
  const chosen = settings?.models.find((m) => m.id === entryId) ?? null;
  const defaultModel = settings?.models.find((m) => m.id === settings.defaultDirectoryEntryId) ?? null;
  const effective = effectiveHelperModel(settings, entryId);
  const hasPictures = pictures.length > 0;
  const blindWithPictures = hasPictures && Boolean(settings) && effective.canSeePictures !== true;
  const visionModels = sortByReadiness(
    (settings?.models ?? []).filter((m) => m.canSeePictures === true).map((option) => ({ option })),
  ).map(({ option }) => option);

  const captureNow = useCallback(
    (rect: HelperRect | null) => {
      const main = document.getElementById("main-content");
      setCapture(
        captureHelperContext({
          root: rect ? document.body : main ?? document.body,
          rect: rect ?? viewportRect(),
          route,
          pageTitle: document.title,
          companyName: selectedCompany?.name ?? null,
        }),
      );
    },
    [route, selectedCompany?.name],
  );

  // Opening the panel takes the visible page as the default context.
  useEffect(() => {
    if (open && !capture) captureNow(null);
  }, [open, capture, captureNow]);

  // A new page means the old context no longer matches what is on screen.
  useEffect(() => {
    setCapture(null);
    setMarkedRect(null);
  }, [route]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (isHelperShortcut(event)) {
        event.preventDefault();
        setOpen((v) => !v);
        return;
      }
      if (event.key === "Escape" && marking) {
        event.preventDefault();
        setMarking(false);
        setDrag(null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [marking]);

  useEffect(() => {
    if (open && !marking) inputRef.current?.focus();
  }, [open, marking]);

  if (!selectedCompanyId) return null;

  const finishMarking = (rect: HelperRect | null) => {
    setMarking(false);
    setDrag(null);
    if (rect && rect.width >= 8 && rect.height >= 8) {
      setMarkedRect(rect);
      captureNow(rect);
      setSeeOpen(true);
    }
  };

  const addFiles = async (files: readonly File[]) => {
    if (files.length === 0) return;
    const { pictures: added, problems } = await filesToHelperPictures(files, pictures.length);
    setPictureProblems(problems);
    if (added.length > 0) setPictures((prev) => [...prev, ...added].slice(0, HELPER_PICTURES_MAX));
  };

  const send = async () => {
    const text = message.trim();
    if (!text || pending || blindWithPictures) return;
    setPending(true);
    setError(null);
    setAppliedNote(null);
    const history = turns.map((t) => ({ role: t.role, content: historyContentOf(t) }));
    const sentPictures = pictures;
    const asked: Turn = {
      role: "user",
      content: text,
      applyTargets: capture?.applyTargets ?? [],
      pictures: sentPictures.map(({ key, name, previewUrl }) => ({ key, name, previewUrl })),
      context: capture?.text ? capture.text : null,
      pageRoute: route,
      references: capture?.entities ?? [],
      pictureInputs: sentPictures.map((p) => p.input),
    };
    setTurns((prev) => [...prev, asked]);
    setMessage("");
    setPictures([]);
    setPictureProblems([]);
    try {
      const result = await helperApi.ask(selectedCompanyId, {
        message: text,
        context: capture?.text ?? null,
        pageRoute: route,
        directoryEntryId: entryId || null,
        history,
        ...(sentPictures.length > 0 ? { pictures: sentPictures.map((p) => p.input) } : {}),
      });
      setTurns((prev) => [
        ...prev,
        {
          role: "assistant",
          content: result.answer,
          meta: { modelLabel: result.modelLabel, costCents: result.costCents, truncated: result.truncated },
          applyTargets: asked.applyTargets,
          suggestInvestigation: result.suggestInvestigation === true,
        },
      ]);
    } catch (err) {
      setError(describeError(err));
      setTurns((prev) => prev.slice(0, -1));
      setMessage(text);
      setPictures(sentPictures);
    } finally {
      setPending(false);
    }
  };

  /** Opens the confirm step; nothing starts until the person presses "Start investigation". */
  const openInvestigation = (next: InvestigationDraft & { fromComposer: boolean }) => {
    setDraft(next);
    setStartError(null);
    void investigationsQuery.refetch();
  };

  const investigateComposer = () => {
    const text = message.trim();
    if (!text) return;
    openInvestigation({
      question: text,
      context: capture?.text ? capture.text : null,
      pageRoute: route,
      references: capture?.entities ?? [],
      pictures: pictures.map((p) => p.input),
      quickAnswer: null,
      fromComposer: true,
    });
  };

  /** "Investigate deeper" on an answer: the question that got it, with what was sent then. */
  const investigateTurn = (index: number) => {
    const answer = turns[index];
    const asked = turns[index - 1];
    if (!answer || !asked || asked.role !== "user") return;
    openInvestigation({
      question: asked.content,
      context: asked.context ?? null,
      pageRoute: asked.pageRoute ?? route,
      references: asked.references ?? [],
      pictures: asked.pictureInputs ?? [],
      quickAnswer: answer.content,
      fromComposer: false,
    });
  };

  const apply = (label: string, answer: string) => {
    const ok = applyHelperAnswer(label, extractApplicableText(answer));
    setAppliedNote(
      ok
        ? `Put into "${label}". Check it, then press that page's own Save — nothing is saved yet.`
        : `"${label}" is no longer on the page, so nothing was changed.`,
    );
  };

  return (
    <>
      {!open ? (
        <button
          type="button"
          data-helper-ignore
          data-testid="helper-open"
          onClick={() => setOpen(true)}
          title={`Ask Paperclip (${SHORTCUT_LABEL})`}
          className="pointer-events-auto fixed bottom-24 right-4 z-40 flex items-center gap-1.5 rounded-full border border-border bg-background px-3 py-2 text-sm font-medium shadow-md hover:bg-accent md:bottom-6 md:right-20"
        >
          <HelpCircle className="h-4 w-4" />
          Ask
        </button>
      ) : null}

      {marking ? (
        <div
          data-helper-ignore
          data-testid="helper-marking-layer"
          className="pointer-events-auto fixed inset-0 z-[70] cursor-crosshair bg-black/10"
          onPointerDown={(e) => {
            (e.target as Element).setPointerCapture?.(e.pointerId);
            setDrag({ x: e.clientX, y: e.clientY, x2: e.clientX, y2: e.clientY });
          }}
          onPointerMove={(e) => {
            if (drag) setDrag({ ...drag, x2: e.clientX, y2: e.clientY });
          }}
          onPointerUp={(e) => {
            if (!drag) return finishMarking(null);
            const rect = rectFromPoints(drag.x, drag.y, e.clientX, e.clientY);
            // The layer must be gone before reading the page underneath.
            setMarking(false);
            requestAnimationFrame(() => finishMarking(rect));
          }}
        >
          <div className="pointer-events-none fixed left-1/2 top-4 -translate-x-1/2 rounded-md bg-background px-3 py-1.5 text-sm shadow">
            Drag over the part of the page you want help with. Esc cancels.
          </div>
          {drag ? (
            <div
              className="pointer-events-none fixed border-2 border-primary bg-primary/10"
              style={{
                left: Math.min(drag.x, drag.x2),
                top: Math.min(drag.y, drag.y2),
                width: Math.abs(drag.x2 - drag.x),
                height: Math.abs(drag.y2 - drag.y),
              }}
            />
          ) : null}
        </div>
      ) : null}

      {markedRect && open && !marking ? (
        <div
          data-helper-ignore
          aria-hidden="true"
          className="pointer-events-none fixed z-[45] rounded border-2 border-dashed border-primary/70"
          style={{ left: markedRect.left, top: markedRect.top, width: markedRect.width, height: markedRect.height }}
        />
      ) : null}

      {open && !marking ? (
        <aside
          data-helper-ignore
          data-testid="helper-panel"
          aria-label="Ask Paperclip"
          className="pointer-events-auto fixed inset-y-0 right-0 z-50 flex w-full max-w-[400px] flex-col border-l border-border bg-background shadow-xl"
        >
          <header className="flex items-center justify-between border-b border-border px-4 py-3">
            <div>
              <div className="text-sm font-semibold">Ask Paperclip</div>
              <div className="text-xs text-muted-foreground">
                Explains what is on this page. It cannot change anything. {SHORTCUT_LABEL} opens and closes it.
              </div>
            </div>
            <Button variant="ghost" size="icon-sm" onClick={() => setOpen(false)} aria-label="Close the helper">
              <X className="h-4 w-4" />
            </Button>
          </header>

          <div className="flex-1 space-y-3 overflow-y-auto px-4 py-3">
            {turns.length === 0 ? (
              <div className="space-y-2 text-sm text-muted-foreground">
                <p>Ask about anything on this page. For example:</p>
                <ul className="list-disc space-y-1 pl-5">
                  <li>Mark a setting and ask “What should I put here, step by step?”</li>
                  <li>Mark a card on Now and ask “Should I approve this?”</li>
                  <li>Mark a text field and ask the helper to write it, then press “Apply”.</li>
                  <li>Attach or paste a picture and ask “What's wrong in this screenshot?” or “Write a character sheet from this photo”.</li>
                  <li>
                    When a question needs real digging (the code, reviews or logs behind a card), press “Investigate deeper”
                    to hand it to an agent. You see what it costs before it starts.
                  </li>
                </ul>
              </div>
            ) : null}
            {turns.map((turn, index) =>
              turn.role === "user" ? (
                <div key={index} className="ml-8 space-y-1.5 rounded-lg bg-muted px-3 py-2 text-sm whitespace-pre-wrap">
                  {turn.pictures && turn.pictures.length > 0 ? (
                    <div className="flex flex-wrap gap-1" data-testid="helper-turn-pictures">
                      {turn.pictures.map((p) => (
                        <img key={p.key} src={p.previewUrl} alt={p.name} title={p.name} className="h-12 w-12 rounded object-cover" />
                      ))}
                    </div>
                  ) : null}
                  {turn.content}
                </div>
              ) : (
                <div key={index} className="space-y-2" data-testid="helper-answer">
                  <MarkdownBody className="text-sm">{turn.content}</MarkdownBody>
                  {turn.suggestInvestigation ? (
                    <div className="space-y-1.5 rounded-md border border-primary/40 bg-primary/5 px-2.5 py-2 text-xs" data-testid="helper-suggest-investigation">
                      <p>
                        This needs a closer look than the quick helper can give. An agent can investigate it: that takes
                        a few minutes and is paid from that agent's budget. Nothing starts until you press the button.
                      </p>
                      <Button size="xs" variant="outline" onClick={() => investigateTurn(index)} data-testid="helper-investigate-suggested">
                        <Search className="h-3.5 w-3.5" /> Investigate deeper
                      </Button>
                    </div>
                  ) : null}
                  <div className="flex flex-wrap items-center gap-2">
                    {(turn.applyTargets ?? [])
                      .filter((label) => registeredTargets.includes(label) || canApplyHelperAnswer(label))
                      .map((label) => (
                        <Button key={label} size="xs" variant="outline" onClick={() => apply(label, turn.content)}>
                          Apply to {label}
                        </Button>
                      ))}
                    {!turn.suggestInvestigation ? (
                      <Button
                        size="xs"
                        variant="ghost"
                        onClick={() => investigateTurn(index)}
                        title="Hand this question to an agent that can look things up (takes a few minutes and costs money)"
                        data-testid="helper-investigate-answer"
                      >
                        <Search className="h-3.5 w-3.5" /> Investigate deeper
                      </Button>
                    ) : null}
                    {turn.meta ? (
                      <span className="text-[11px] text-muted-foreground">
                        {turn.meta.modelLabel}
                        {turn.meta.costCents > 0 ? ` · ${(turn.meta.costCents / 100).toFixed(2)} USD` : ""}
                        {turn.meta.truncated ? " · answer was cut short" : ""}
                      </span>
                    ) : null}
                  </div>
                </div>
              ),
            )}
            {pending ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> Thinking…
              </div>
            ) : null}
            {appliedNote ? <p className="rounded-md bg-muted px-3 py-2 text-xs">{appliedNote}</p> : null}
            {error ? (
              <p role="alert" className="rounded-md border border-destructive/40 px-3 py-2 text-xs text-destructive">
                {error}
              </p>
            ) : null}
            {draft ? (
              <InvestigateConfirm
                draft={draft}
                availability={investigationsQuery.data?.availability ?? null}
                loading={investigationsQuery.isFetching}
                starting={startInvestigation.isPending}
                error={startError ?? (investigationsQuery.error ? describeError(investigationsQuery.error) : null)}
                onStart={() => startInvestigation.mutate(draft)}
                onCancel={() => {
                  setDraft(null);
                  setStartError(null);
                }}
              />
            ) : null}
            <DroppedReferencesNotice dropped={droppedNotice} onClose={() => setDroppedNotice([])} />
            <MyInvestigations investigations={investigations} openIds={openInvestigationIds} />
          </div>

          <footer className="space-y-2 border-t border-border px-4 py-3">
            <div className="flex flex-wrap items-center gap-2">
              <Button size="xs" variant="outline" onClick={() => setMarking(true)} data-testid="helper-mark">
                <Crop className="h-3.5 w-3.5" /> {markedRect ? "Mark again" : "Mark an area"}
              </Button>
              {markedRect ? (
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => {
                    setMarkedRect(null);
                    captureNow(null);
                  }}
                >
                  <RotateCcw className="h-3.5 w-3.5" /> Use the visible page
                </Button>
              ) : null}
              {capture ? (
                <Button size="xs" variant="ghost" onClick={() => setCapture({ ...capture, text: "", itemCount: 0, entities: [], applyTargets: [] })}>
                  Send no page text
                </Button>
              ) : null}
              {turns.length > 0 ? (
                <Button size="xs" variant="ghost" onClick={() => setTurns([])}>
                  New conversation
                </Button>
              ) : null}
            </div>

            <details open={seeOpen} onToggle={(e) => setSeeOpen((e.currentTarget as HTMLDetailsElement).open)} className="text-xs">
              <summary className="flex cursor-pointer items-center gap-1 text-muted-foreground">
                <Eye className="h-3.5 w-3.5" /> What the helper sees
                {capture ? ` (${capture.text.length.toLocaleString()} characters${capture.truncated ? ", cut to fit" : ""})` : ""}
              </summary>
              <p className="mt-1 text-muted-foreground">
                Only this text is sent, together with the page address — never a picture of the screen. Passwords, keys and
                anything that looks like one are left out or shown as [hidden].
              </p>
              <pre data-testid="helper-sees" className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded border border-border bg-muted/40 p-2 font-mono text-[11px]">
                {capture?.text ? capture.text : `Page address: ${route}\n(No page text will be sent.)`}
              </pre>
            </details>

            <div className="space-y-1.5" data-testid="helper-pictures">
              <div className="flex flex-wrap items-center gap-2">
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={pictures.length >= HELPER_PICTURES_MAX}
                  data-testid="helper-attach"
                >
                  <ImagePlus className="h-3.5 w-3.5" /> Attach picture
                </Button>
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => setFilePickerOpen((v) => !v)}
                  disabled={pictures.length >= HELPER_PICTURES_MAX}
                  data-testid="helper-from-files"
                >
                  <FolderOpen className="h-3.5 w-3.5" /> From Files
                </Button>
                <span className="text-[11px] text-muted-foreground">
                  or paste one. Up to {HELPER_PICTURES_MAX}, 5 MB each.
                </span>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept={HELPER_PICTURE_ACCEPT}
                  multiple
                  hidden
                  data-testid="helper-file-input"
                  onChange={(e) => {
                    const files = Array.from(e.currentTarget.files ?? []);
                    e.currentTarget.value = "";
                    void addFiles(files);
                  }}
                />
              </div>
              {filePickerOpen ? (
                <HelperFilePicker
                  companyId={selectedCompanyId}
                  onClose={() => setFilePickerOpen(false)}
                  onPick={(file) => {
                    setFilePickerOpen(false);
                    setPictures((prev) =>
                      prev.length >= HELPER_PICTURES_MAX || prev.some((p) => p.input.kind === "file" && p.input.fileId === file.attachmentId)
                        ? prev
                        : [...prev, companyFilePicture(file.attachmentId, file.name, file.thumbnailPath)],
                    );
                  }}
                />
              ) : null}
              {pictures.length > 0 ? (
                <div className="flex flex-wrap gap-1.5">
                  {pictures.map((p) => (
                    <div key={p.key} className="relative" data-testid="helper-picture">
                      <img src={p.previewUrl} alt={p.name} title={p.name} className="h-14 w-14 rounded border border-border object-cover" />
                      <button
                        type="button"
                        aria-label={`Remove ${p.name}`}
                        className="absolute -right-1.5 -top-1.5 rounded-full border border-border bg-background p-0.5 shadow"
                        onClick={() => setPictures((prev) => prev.filter((x) => x.key !== p.key))}
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </div>
                  ))}
                </div>
              ) : null}
              {hasPictures ? (
                <p className="text-[11px] text-muted-foreground">
                  Only these pictures are sent, with this question only. They are not saved.
                </p>
              ) : null}
              {pictureProblems.map((problem) => (
                <p key={problem} role="alert" className="text-xs text-destructive">
                  {problem}
                </p>
              ))}
            </div>

            <label className="block text-xs">
              <span className="text-muted-foreground">Model</span>
              <select
                className="mt-0.5 w-full rounded-md border border-border bg-transparent px-2 py-1 text-sm"
                value={entryId}
                onChange={(e) => setEntryId(e.target.value)}
                data-testid="helper-model"
              >
                <option value="">
                  Use default ({defaultModel ? defaultModel.name : settings?.builtInDefaultLabel ?? "Paperclip's default"})
                  {settings ? ` — ${helperStatusText(defaultModel ? defaultModel.status : settings.builtInDefaultStatus)}` : ""}
                </option>
                {groups.map((group) => (
                  <optgroup key={group.key} label={group.title}>
                    {group.entries.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name} — {helperStatusText(item.option.status)}
                        {hasPictures && item.option.canSeePictures !== true ? " · can't see pictures" : ""}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </label>
            {settings && effective.status && !isHelperStatusReady(effective.status) ? (
              <p className="text-xs text-amber-600" data-testid="helper-model-warning">
                {helperStatusText(effective.status)}: {chosen && !chosen.keyReady && chosen.keyHint ? chosen.keyHint : effective.status.detail}
              </p>
            ) : null}
            {blindWithPictures ? (
              <div className="space-y-1 rounded-md border border-amber-500/50 px-2 py-1.5 text-xs" role="alert" data-testid="helper-vision-gate">
                <p>
                  {effective.canSeePictures === false
                    ? `“${effective.name}” cannot look at pictures, so it cannot answer about the ones you attached.`
                    : `Paperclip does not know whether “${effective.name}” can look at pictures, so they are not sent to it.`}{" "}
                  Pick a model that can, or remove the pictures.
                </p>
                <div className="flex flex-wrap gap-1">
                  {settings?.builtInDefaultCanSeePictures && !defaultModel && entryId ? (
                    <Button size="xs" variant="outline" onClick={() => setEntryId("")} data-testid="helper-vision-option">
                      Paperclip's default
                    </Button>
                  ) : null}
                  {visionModels.map((m) => (
                    <Button key={m.id} size="xs" variant="outline" onClick={() => setEntryId(m.id)} data-testid="helper-vision-option">
                      {m.name}
                    </Button>
                  ))}
                </div>
                <p className="text-muted-foreground">
                  Whether a saved model can see pictures is its “Pictures” setting under Company settings → Models. Models
                  Paperclip already knows are filled in for you; an owner or admin can change it.
                </p>
              </div>
            ) : null}

            <div className="flex items-end gap-2">
              <Textarea
                ref={inputRef}
                value={message}
                maxLength={HELPER_MESSAGE_MAX_CHARS}
                rows={3}
                placeholder={hasPictures ? "Ask about the pictures…" : "Ask about this page…"}
                onChange={(e) => setMessage(e.target.value)}
                onPaste={(e) => {
                  const files = picturesFromClipboard(e.clipboardData);
                  if (files.length === 0) return;
                  e.preventDefault();
                  void addFiles(files);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void send();
                  }
                }}
                className="min-h-[64px] flex-1 text-sm"
                aria-label="Your question"
              />
              <div className="flex flex-col gap-1.5">
                <Button
                  size="icon-sm"
                  variant="outline"
                  onClick={investigateComposer}
                  disabled={!message.trim() || startInvestigation.isPending}
                  aria-label="Investigate deeper"
                  title="Hand this question straight to an agent that can look things up (takes a few minutes and costs money). You confirm first."
                  data-testid="helper-investigate-composer"
                >
                  <Search className="h-4 w-4" />
                </Button>
                <Button size="icon-sm" onClick={() => void send()} disabled={pending || !message.trim() || blindWithPictures} aria-label="Send">
                  <Send className="h-4 w-4" />
                </Button>
              </div>
            </div>
          </footer>
        </aside>
      ) : null}
    </>
  );
}

