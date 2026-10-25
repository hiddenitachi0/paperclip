import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { DismissableLayer, FocusScope } from "radix-ui/internal";
import {
  HelpCircle,
  Crop,
  X,
  Send,
  Eye,
  RotateCcw,
  Loader2,
  ImagePlus,
  FolderOpen,
  Search,
  Copy,
  Check,
  MessageSquarePlus,
  MessagesSquare,
  Undo2,
} from "lucide-react";
import {
  HELPER_INVESTIGATIONS_LIST_LIMIT,
  HELPER_MESSAGE_MAX_CHARS,
  HELPER_PICTURES_MAX,
  type HelperDroppedReference,
  type HelperInvestigationList,
  type HelperModelOption,
} from "@paperclipai/shared";
import { Link, useLocation, useNavigate } from "@/lib/router";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useCompany } from "../../context/CompanyContext";
import { helperApi } from "../../api/helper";
import { authApi } from "../../api/auth";
import { queryKeys } from "../../lib/queryKeys";
import {
  captureHelperContext,
  helperCaptureSummary,
  helperDefaultRoot,
  helperRectAtPoint,
  helperScrollableAt,
  rectFromPoints,
  viewportRect,
  type HelperCapture,
  type HelperRect,
} from "../../lib/helper-capture";
import {
  applyHelperAnswer,
  canApplyHelperAnswer,
  extractApplicableText,
  findHelperApplyElement,
  readHelperApplyValue,
  useHelperApplyTargets,
} from "../../lib/helper-apply";
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
  InvestigationInline,
  MyInvestigations,
  isInvestigationActive,
  type InvestigationDraft,
} from "./HelperInvestigations";
import { helperErrorText } from "./helper-errors";
import { boardChatUnavailableText, useBoardChatAvailability } from "../../hooks/useBoardChatAvailability";
import { boardChatPrefillState, buildBoardChatHandoffText } from "../../lib/board-chat-handoff";
import {
  buildHelperHistory,
  clampHelperWidth,
  historyContentOf,
  loadHelperOpen,
  loadHelperSession,
  loadHelperWidth,
  saveHelperOpen,
  saveHelperSession,
  saveHelperWidth,
  type HelperTurn,
} from "./helper-session";

export { historyContentOf };

/**
 * "Ask Paperclip" — the floating helper.
 *
 * An "Ask" tab on the right edge of the screen (and Ctrl/Cmd+Shift+H) opens
 * a side panel. The person can mark an area of the page (drag a rectangle,
 * like a snipping tool, or click one thing); the panel then shows exactly
 * the text the helper will see before anything is sent. Answers can be
 * applied to an opted-in text field (and undone); the person still presses
 * the page's own Save.
 *
 * Phase 2: up to 4 pictures (upload, paste, or one of the company's Files).
 * Only a model that can see pictures may answer them; the panel says so and
 * offers those that can. Each model in the picker shows whether it is ready.
 *
 * Phase 3: "Investigate deeper" hands a question to the company's
 * investigation agent as a normal task, after the person sees who will look,
 * what it usually takes and costs, and that it is advice only. Its state and
 * its answer show up in the conversation itself, and in "My investigations"
 * (fetched from the server, so it survives a reload).
 *
 * Ask only explains. When a question asks Paperclip to DO something (the
 * server flags it: suggestBoardChat), the answer offers "Do this in Board
 * chat", which opens Board chat with the question typed in for the person to
 * check and send. It is also a small action under every answer. A person who
 * cannot use Board chat gets a plain note instead of the button.
 *
 * The conversation is kept per company for this browser tab (sessionStorage,
 * see helper-session.ts): it survives moving between pages and a reload, and
 * a company switch shows that company's own conversation. Nothing of it is
 * remembered on the server.
 *
 * The panel works over pop-up dialogs too: it is drawn above them, clicking
 * in it does not close them, typing in it is not pulled back into them, and
 * "the visible page" then means the dialog. Everything it draws carries
 * data-helper-ignore so it is never part of what is captured.
 */

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

function isSmallScreen(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(max-width: 767px)").matches;
}

/**
 * Pop-up dialogs trap the keyboard focus inside themselves. While the panel is
 * open this keeps that trap paused (the newest focus scope pauses the older
 * ones), so the person can type in the panel next to an open dialog. It is
 * remounted whenever a dialog opens, so it is always the newest scope.
 */
function DialogFocusPause() {
  const [generation, setGeneration] = useState(0);
  useEffect(() => {
    if (typeof MutationObserver === "undefined") return;
    const observer = new MutationObserver((records) => {
      if (records.some((record) => touchesDialog(record.addedNodes))) setGeneration((g) => g + 1);
    });
    observer.observe(document.body, { childList: true });
    return () => observer.disconnect();
  }, []);
  return (
    <FocusScope.FocusScope
      key={generation}
      trapped={false}
      loop={false}
      onMountAutoFocus={(event) => event.preventDefault()}
      onUnmountAutoFocus={(event) => event.preventDefault()}
      style={{ display: "none" }}
    />
  );
}

function CopyButton({ text, testId }: { text: string; testId?: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  useEffect(() => {
    if (state === "idle") return;
    const timer = setTimeout(() => setState("idle"), 2000);
    return () => clearTimeout(timer);
  }, [state]);
  return (
    <Button
      size="xs"
      variant="ghost"
      data-testid={testId}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setState("copied");
        } catch {
          setState("failed");
        }
      }}
    >
      {state === "copied" ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      {state === "copied" ? "Copied" : state === "failed" ? "Could not copy" : "Copy"}
    </Button>
  );
}

const DIALOG_SELECTOR = '[role="dialog"],[role="alertdialog"]';

function touchesDialog(nodes: NodeList): boolean {
  return Array.from(nodes).some(
    (node) =>
      node instanceof Element &&
      !node.hasAttribute("data-helper-ignore") &&
      (node.matches(DIALOG_SELECTOR) || node.querySelector(DIALOG_SELECTOR) !== null),
  );
}

/**
 * The helper's own place in the page: a container straight under <body>, so
 * it is drawn above pop-up dialogs and is not inside the page it reads.
 *
 * Pointer presses inside it stop here. A pop-up dialog closes on any press
 * "outside" itself, and it decides that a moment later, after the click, when
 * the button pressed may already be gone (the helper swaps buttons as it
 * goes); stopping the press here means a dialog never counts a press in the
 * helper as outside. React still sees it: it listens on this container.
 */
function useHelperHost(): HTMLElement | null {
  const [host, setHost] = useState<HTMLElement | null>(null);
  useEffect(() => {
    const el = document.createElement("div");
    el.setAttribute("data-helper-ignore", "");
    // Kept readable for screen readers while a dialog hides everything else (aria-live elements are left alone).
    el.setAttribute("aria-live", "off");
    el.setAttribute("data-testid", "helper-root");
    const stop = (event: Event) => event.stopPropagation();
    el.addEventListener("pointerdown", stop);
    document.body.appendChild(el);
    setHost(el);
    return () => {
      el.removeEventListener("pointerdown", stop);
      el.remove();
    };
  }, []);
  return host;
}

export function HelperOverlay() {
  const { selectedCompanyId } = useCompany();
  const host = useHelperHost();
  // Whose conversation this is: it is saved per person and company, and not at all while nobody is known.
  const sessionQuery = useQuery({ queryKey: queryKeys.auth.session, queryFn: () => authApi.getSession(), retry: false });
  const userId = sessionQuery.data?.session?.userId ?? sessionQuery.data?.user?.id ?? null;
  // Wait until it is known who is signed in (or that nobody is), so the panel does not start over a moment later.
  if (!selectedCompanyId || !host || sessionQuery.isPending) return null;
  // One instance per person and company: a switch starts from that person's own conversation in that company.
  return createPortal(
    <CompanyHelper key={`${userId ?? "unknown"}:${selectedCompanyId}`} companyId={selectedCompanyId} userId={userId} />,
    host,
  );
}

interface Note {
  text: string;
  undo?: () => void;
}

function CompanyHelper({ companyId, userId }: { companyId: string; userId: string | null }) {
  const { selectedCompany } = useCompany();
  const location = useLocation();
  const navigate = useNavigate();
  const boardChat = useBoardChatAvailability(companyId);
  const initial = useMemo(() => loadHelperSession(userId, companyId), [userId, companyId]);
  const [open, setOpen] = useState(loadHelperOpen);
  const [width, setWidth] = useState(loadHelperWidth);
  const [marking, setMarking] = useState(false);
  const [drag, setDrag] = useState<{ x: number; y: number; x2: number; y2: number } | null>(null);
  const [markedRect, setMarkedRect] = useState<HelperRect | null>(null);
  const [outlineVisible, setOutlineVisible] = useState(true);
  const [capture, setCapture] = useState<HelperCapture | null>(null);
  const [includePage, setIncludePage] = useState(true);
  const [seeOpen, setSeeOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [entryId, setEntryId] = useState(initial.entryId);
  const [turns, setTurns] = useState<HelperTurn[]>(initial.turns);
  const [seenAnswerIds, setSeenAnswerIds] = useState<string[]>(initial.seenAnswerIds);
  const [pending, setPending] = useState(false);
  const [slow, setSlow] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<Note | null>(null);
  const [pictures, setPictures] = useState<HelperAttachedPicture[]>([]);
  const [pictureProblems, setPictureProblems] = useState<string[]>([]);
  const [filePickerOpen, setFilePickerOpen] = useState(false);
  const [draft, setDraft] = useState<(InvestigationDraft & { fromComposer: boolean }) | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const [droppedNotice, setDroppedNotice] = useState<HelperDroppedReference[]>([]);
  const queryClient = useQueryClient();
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const panelRef = useRef<HTMLElement | null>(null);
  const openButtonRef = useRef<HTMLButtonElement | null>(null);
  const endRef = useRef<HTMLDivElement | null>(null);
  const sendingRef = useRef(false);
  const wantFocusRef = useRef(false);
  const registeredTargets = useHelperApplyTargets();

  const route = `${location.pathname}${location.search}`;

  // ─── Remembered for this tab ──────────────────────────────────────────────
  useEffect(() => saveHelperOpen(open), [open]);
  useEffect(() => {
    saveHelperSession(userId, companyId, { turns, entryId, seenAnswerIds });
  }, [userId, companyId, turns, entryId, seenAnswerIds]);

  // ─── Server data ──────────────────────────────────────────────────────────
  const settingsQuery = useQuery({
    queryKey: queryKeys.companies.helperSettings(companyId),
    queryFn: () => helperApi.getSettings(companyId),
    enabled: open,
    staleTime: 60_000,
  });
  const settings = settingsQuery.data;

  const inlineIds = useMemo(
    () => turns.filter((t) => t.role === "investigation" && t.investigationId).map((t) => t.investigationId!),
    [turns],
  );
  const investigationsKey = queryKeys.companies.helperInvestigations(companyId);
  const cachedList = queryClient.getQueryData<HelperInvestigationList>(investigationsKey);
  const watchWhileClosed = inlineIds.some((id) => {
    const item = cachedList?.investigations.find((i) => i.id === id);
    return !item || isInvestigationActive(item);
  });
  const investigationsQuery = useQuery({
    queryKey: investigationsKey,
    queryFn: () => helperApi.listInvestigations(companyId),
    // While the panel is open, and while one started from this conversation is still running.
    enabled: open || watchWhileClosed,
    refetchInterval: (query) =>
      query.state.data?.investigations.some(isInvestigationActive) ? HELPER_INVESTIGATION_POLL_MS : false,
    refetchOnWindowFocus: true,
  });
  const investigations = useMemo(() => investigationsQuery.data?.investigations ?? [], [investigationsQuery.data]);
  const investigationsById = useMemo(() => new Map(investigations.map((i) => [i.id, i])), [investigations]);
  const investigationAnswers = useMemo(
    () => new Map(investigations.filter((i) => i.answer).map((i) => [i.id, i.answer!])),
    [investigations],
  );
  const listOpenIds = useMemo(() => {
    const newest = investigations[0];
    return new Set(newest && !inlineIds.includes(newest.id) ? [newest.id] : []);
  }, [investigations, inlineIds]);
  const unseenAnswerIds = inlineIds.filter((id) => investigationsById.get(id)?.answer && !seenAnswerIds.includes(id));

  useEffect(() => {
    if (open && unseenAnswerIds.length > 0) setSeenAnswerIds((prev) => [...prev, ...unseenAnswerIds.filter((id) => !prev.includes(id))]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, unseenAnswerIds.join(",")]);

  const startInvestigation = useMutation({
    mutationFn: (input: InvestigationDraft) =>
      helperApi.startInvestigation(companyId, {
        question: input.question,
        context: input.context,
        pageRoute: input.pageRoute,
        references: input.references,
        quickAnswer: input.quickAnswer,
        ...(input.pictures.length > 0 ? { pictures: input.pictures } : {}),
        ...(input.applyTargets.length > 0 ? { applyTargets: input.applyTargets } : {}),
      }),
    onSuccess: (view) => {
      queryClient.setQueryData<HelperInvestigationList>(investigationsKey, (prev) =>
        prev
          ? { ...prev, investigations: [view, ...prev.investigations.filter((i) => i.id !== view.id)].slice(0, HELPER_INVESTIGATIONS_LIST_LIMIT) }
          : prev,
      );
      void queryClient.invalidateQueries({ queryKey: investigationsKey });
      setTurns((prev) => [
        ...prev,
        {
          role: "investigation",
          content: view.question,
          investigationId: view.id,
          investigationIdentifier: view.identifier,
          agentName: view.agentName,
        },
      ]);
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
      setStartError(helperErrorText(err, "investigate"));
      void queryClient.invalidateQueries({ queryKey: investigationsKey });
    },
  });

  // ─── Models ───────────────────────────────────────────────────────────────
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
  const offerBuiltInForPictures = Boolean(settings?.builtInDefaultCanSeePictures && !defaultModel && entryId);

  // A model picked earlier that is no longer in the company's list: fall back to the default.
  useEffect(() => {
    if (settings && entryId && !settings.models.some((m) => m.id === entryId)) setEntryId("");
  }, [settings, entryId]);

  // ─── What the helper sees ─────────────────────────────────────────────────
  const captureNow = useCallback(
    (rect: HelperRect | null): HelperCapture => {
      const next = captureHelperContext({
        root: rect ? document.body : helperDefaultRoot(document),
        rect: rect ?? viewportRect(),
        route,
        pageTitle: document.title,
        companyName: selectedCompany?.name ?? null,
      });
      setCapture(next);
      return next;
    },
    [route, selectedCompany?.name],
  );

  // A new page means the old context no longer matches what is on screen.
  useEffect(() => {
    setCapture(null);
    setMarkedRect(null);
  }, [route]);

  // While the panel is open, read the visible page (shortly after a page change, so the new page has drawn).
  useEffect(() => {
    if (!open || marking || capture || markedRect) return;
    const timer = setTimeout(() => captureNow(null), 250);
    return () => clearTimeout(timer);
  }, [open, marking, capture, markedRect, captureNow]);

  // The marked outline is drawn where the area was; once the page scrolls it no longer matches.
  useEffect(() => {
    if (!markedRect || !outlineVisible) return;
    const hide = (event: Event) => {
      if (event.target instanceof Element && event.target.closest("[data-helper-ignore]")) return;
      setOutlineVisible(false);
    };
    document.addEventListener("scroll", hide, true);
    window.addEventListener("resize", hide);
    return () => {
      document.removeEventListener("scroll", hide, true);
      window.removeEventListener("resize", hide);
    };
  }, [markedRect, outlineVisible]);

  // A pop-up dialog opening or closing changes what is on screen: a marked area no longer matches it.
  useEffect(() => {
    if (!markedRect || typeof MutationObserver === "undefined") return;
    const observer = new MutationObserver((records) => {
      if (records.some((record) => touchesDialog(record.addedNodes) || touchesDialog(record.removedNodes))) {
        setMarkedRect(null);
        setCapture(null);
      }
    });
    observer.observe(document.body, { childList: true });
    return () => observer.disconnect();
  }, [markedRect]);

  // ─── Open, close, focus, keys ─────────────────────────────────────────────
  const openPanel = useCallback(() => {
    wantFocusRef.current = true;
    setOpen(true);
  }, []);

  const closePanel = useCallback(() => {
    const hadFocus = Boolean(panelRef.current && panelRef.current.contains(document.activeElement));
    setOpen(false);
    setMarking(false);
    setDrag(null);
    if (hadFocus) requestAnimationFrame(() => openButtonRef.current?.focus());
  }, []);

  const cancelMarking = useCallback(() => {
    setMarking(false);
    setDrag(null);
    wantFocusRef.current = true;
  }, []);

  useEffect(() => {
    if (open && !marking && wantFocusRef.current) {
      wantFocusRef.current = false;
      inputRef.current?.focus();
    }
  }, [open, marking]);

  useEffect(() => {
    // Capture phase on window: runs before a pop-up dialog's own Esc handling (on document), so Esc
    // in the panel closes the panel, not the dialog the person is asking about.
    const onKey = (event: KeyboardEvent) => {
      if (isHelperShortcut(event)) {
        event.preventDefault();
        if (open) closePanel();
        else openPanel();
        return;
      }
      if (event.key !== "Escape") return;
      if (marking) {
        event.preventDefault();
        event.stopPropagation();
        cancelMarking();
        return;
      }
      const panel = panelRef.current;
      if (!open || !panel || !(event.target instanceof Node) || !panel.contains(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
      if (filePickerOpen) setFilePickerOpen(false);
      else if (draft) setDraft(null);
      else closePanel();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, marking, filePickerOpen, draft, openPanel, closePanel, cancelMarking]);

  // A pop-up dialog blocks scrolling everywhere but itself; the panel's own lists must still scroll.
  useEffect(() => {
    const panel = panelRef.current;
    if (!open || marking || !panel) return;
    const stop = (event: Event) => event.stopPropagation();
    panel.addEventListener("wheel", stop, { passive: true });
    panel.addEventListener("touchmove", stop, { passive: true });
    return () => {
      panel.removeEventListener("wheel", stop);
      panel.removeEventListener("touchmove", stop);
    };
  }, [open, marking]);

  // Keep the newest message (or the confirm step) in view.
  const answeredCount = inlineIds.filter((id) => investigationAnswers.has(id)).length;
  useEffect(() => {
    if (!open || marking) return;
    endRef.current?.scrollIntoView?.({ block: "end" });
  }, [open, marking, turns.length, pending, error, Boolean(draft), answeredCount]);

  useEffect(() => {
    if (!pending) {
      setSlow(false);
      return;
    }
    const timer = setTimeout(() => setSlow(true), 15_000);
    return () => clearTimeout(timer);
  }, [pending]);

  // ─── Marking ──────────────────────────────────────────────────────────────
  const finishMarking = (rect: HelperRect | null, point: { x: number; y: number } | null) => {
    setMarking(false);
    setDrag(null);
    wantFocusRef.current = true;
    const area = rect && rect.width >= 8 && rect.height >= 8 ? rect : point ? helperRectAtPoint(point.x, point.y) : null;
    if (area) {
      setMarkedRect(area);
      setOutlineVisible(true);
      setIncludePage(true);
      captureNow(area);
      setSeeOpen(true);
    }
  };

  // ─── Asking ───────────────────────────────────────────────────────────────
  const addFiles = async (files: readonly File[]) => {
    if (files.length === 0) return;
    const { pictures: added, problems } = await filesToHelperPictures(files, pictures.length);
    setPictureProblems(problems);
    if (added.length > 0) setPictures((prev) => [...prev, ...added].slice(0, HELPER_PICTURES_MAX));
  };

  /** What goes with a question now: the marked area as marked, or the visible page read again. */
  const contextForSend = (): HelperCapture | null => {
    if (!includePage) return null;
    if (markedRect && capture) return capture;
    return captureNow(null);
  };

  const send = async () => {
    const text = message.trim();
    if (!text || sendingRef.current || blindWithPictures) return;
    sendingRef.current = true;
    setPending(true);
    setError(null);
    setNote(null);
    const sent = contextForSend();
    const history = buildHelperHistory(turns, investigationAnswers);
    const sentPictures = pictures;
    const asked: HelperTurn = {
      role: "user",
      content: text,
      applyTargets: sent?.applyTargets ?? [],
      pictures: sentPictures.map(({ key, name, previewUrl }) => ({ key, name, previewUrl })),
      context: sent?.text ? sent.text : null,
      pageRoute: route,
      pageTitle: typeof document !== "undefined" ? document.title : null,
      references: sent?.entities ?? [],
      pictureInputs: sentPictures.map((p) => p.input),
    };
    setTurns((prev) => [...prev, asked]);
    setMessage("");
    setPictures([]);
    setPictureProblems([]);
    try {
      const result = await helperApi.ask(companyId, {
        message: text,
        context: sent?.text ? sent.text : null,
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
          suggestBoardChat: result.suggestBoardChat === true,
        },
      ]);
    } catch (err) {
      setError(helperErrorText(err, "ask"));
      setTurns((prev) => prev.filter((t) => t !== asked));
      setMessage((current) => current || text);
      setPictures((current) => (current.length > 0 ? current : sentPictures));
    } finally {
      sendingRef.current = false;
      setPending(false);
    }
  };

  const newConversation = () => {
    setTurns([]);
    setSeenAnswerIds([]);
    setError(null);
    setNote(null);
    setDraft(null);
    setStartError(null);
    setDroppedNotice([]);
    wantFocusRef.current = false;
    inputRef.current?.focus();
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
    const sent = contextForSend();
    openInvestigation({
      question: text,
      context: sent?.text ? sent.text : null,
      pageRoute: route,
      references: sent?.entities ?? [],
      pictures: pictures.map((p) => p.input),
      quickAnswer: null,
      applyTargets: sent?.applyTargets ?? [],
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
      applyTargets: asked.applyTargets ?? [],
      fromComposer: false,
    });
  };

  /**
   * "Do this in Board chat": opens Board chat with the question (and where it
   * was asked) typed in. Passed in navigation state, never the URL; nothing is
   * sent until the person presses Send there.
   */
  const handOffToBoardChat = (index: number) => {
    const asked = turns[index - 1];
    if (!asked || asked.role !== "user") return;
    const text = buildBoardChatHandoffText({ question: asked.content, pageTitle: asked.pageTitle ?? null });
    closePanel();
    navigate("/board-chat", { state: boardChatPrefillState(text) });
  };

  const canApply = (label: string) => registeredTargets.includes(label) || canApplyHelperAnswer(label);

  const apply = (label: string, answer: string) => {
    const before = readHelperApplyValue(label);
    const value = extractApplicableText(answer);
    const ok = applyHelperAnswer(label, value);
    if (!ok) {
      setNote({ text: `“${label}” is no longer on this page, so nothing was changed.` });
      return;
    }
    findHelperApplyElement(label)?.scrollIntoView?.({ block: "nearest" });
    setNote({
      text: `Put into “${label}”. Check it, then press that page's own Save — nothing is saved yet.`,
      undo:
        before !== null && before !== value
          ? () => {
              const undone = applyHelperAnswer(label, before);
              setNote({
                text: undone
                  ? `Put back what was in “${label}” before.`
                  : `“${label}” is no longer on this page, so it could not be put back.`,
              });
            }
          : undefined,
    });
  };

  const onOpenTask = () => {
    if (isSmallScreen()) closePanel();
  };
  const answerActions = (answer: string) => <CopyButton text={answer} />;

  // ─── Resize (wider screens) ───────────────────────────────────────────────
  const startResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const handle = event.currentTarget;
    handle.setPointerCapture?.(event.pointerId);
    const move = (e: PointerEvent) => setWidth(clampHelperWidth(window.innerWidth - e.clientX, window.innerWidth));
    const up = (e: PointerEvent) => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
      const final = clampHelperWidth(window.innerWidth - e.clientX, window.innerWidth);
      setWidth(final);
      saveHelperWidth(final);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
  };
  const panelWidth = clampHelperWidth(width, typeof window !== "undefined" ? window.innerWidth : 1280);

  // ─── Drawing ──────────────────────────────────────────────────────────────
  const renderTurn = (turn: HelperTurn, index: number): ReactNode => {
    if (turn.role === "user") {
      return (
        <div key={index} className="ml-8 space-y-1.5 rounded-lg bg-muted px-3 py-2 text-sm whitespace-pre-wrap" data-testid="helper-question">
          {turn.pictures && turn.pictures.length > 0 ? (
            <div className="flex flex-wrap gap-1" data-testid="helper-turn-pictures">
              {turn.pictures.map((p) =>
                p.previewUrl ? (
                  <img key={p.key} src={p.previewUrl} alt={p.name} title={p.name} className="h-12 w-12 rounded object-cover" />
                ) : (
                  <span key={p.key} className="rounded border border-border px-1.5 py-0.5 text-[11px] text-muted-foreground" title={p.name}>
                    Picture: {p.name}
                  </span>
                ),
              )}
            </div>
          ) : null}
          {turn.content}
        </div>
      );
    }
    if (turn.role === "investigation") {
      const id = turn.investigationId ?? "";
      return (
        <InvestigationInline
          key={`inv-${id}-${index}`}
          item={investigationsById.get(id) ?? null}
          fallback={{ id, identifier: turn.investigationIdentifier ?? null, question: turn.content, agentName: turn.agentName ?? null }}
          canApply={canApply}
          onApply={apply}
          onOpenTask={onOpenTask}
          answerActions={answerActions}
        />
      );
    }
    return (
      <div key={index} className="space-y-2" data-testid="helper-answer">
        <MarkdownBody className="text-sm">{turn.content}</MarkdownBody>
        {turn.suggestInvestigation ? (
          <div className="space-y-1.5 rounded-md border border-primary/40 bg-primary/5 px-2.5 py-2 text-xs" data-testid="helper-suggest-investigation">
            <p>
              This needs a closer look than the quick helper can give. An agent can investigate it: that takes a few
              minutes and is paid from that agent's budget. Nothing starts until you press the button.
            </p>
            <Button size="xs" variant="outline" onClick={() => investigateTurn(index)} data-testid="helper-investigate-suggested">
              <Search className="h-3.5 w-3.5" /> Investigate deeper
            </Button>
          </div>
        ) : null}
        {turn.suggestBoardChat && boardChat.available ? (
          <div className="space-y-1.5 rounded-md border border-primary/40 bg-primary/5 px-2.5 py-2 text-xs" data-testid="helper-suggest-board-chat">
            <p>
              This asks for a change. Ask can only explain, but Board chat can do it for you. Your question is typed in
              there for you to check; nothing is sent until you press Send.
            </p>
            <Button size="xs" variant="outline" onClick={() => handOffToBoardChat(index)} data-testid="helper-board-chat-suggested">
              <MessagesSquare className="h-3.5 w-3.5" /> Do this in Board chat
            </Button>
          </div>
        ) : null}
        {turn.suggestBoardChat && boardChat.loaded && !boardChat.available && boardChatUnavailableText(boardChat.reason) ? (
          <p className="rounded-md bg-muted px-2.5 py-2 text-xs text-muted-foreground" data-testid="helper-board-chat-unavailable">
            {boardChatUnavailableText(boardChat.reason)}
          </p>
        ) : null}
        <div className="flex flex-wrap items-center gap-2">
          {(turn.applyTargets ?? []).filter(canApply).map((label) => (
            <Button key={label} size="xs" variant="outline" onClick={() => apply(label, turn.content)}>
              Apply to {label}
            </Button>
          ))}
          <CopyButton text={turn.content} testId="helper-copy-answer" />
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
          {boardChat.available && !turn.suggestBoardChat ? (
            <Button
              size="xs"
              variant="ghost"
              onClick={() => handOffToBoardChat(index)}
              title="Open Board chat with this question typed in, so it can make the change for you. You check it and press Send."
              data-testid="helper-board-chat-answer"
            >
              <MessagesSquare className="h-3.5 w-3.5" /> Do this in Board chat
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
    );
  };

  const summary = capture ? helperCaptureSummary(capture, Boolean(markedRect)) : null;

  return (
    <DismissableLayer.Branch className="contents">
      {!open ? (
        <button
          ref={openButtonRef}
          type="button"
          data-testid="helper-open"
          onClick={openPanel}
          aria-label={unseenAnswerIds.length > 0 ? "Ask Paperclip — an investigation answer is ready" : "Ask Paperclip"}
          aria-keyshortcuts="Control+Shift+H Meta+Shift+H"
          title={`Ask Paperclip about this page (${SHORTCUT_LABEL})`}
          className="pointer-events-auto fixed right-0 top-1/2 z-[60] flex -translate-y-1/2 flex-col items-center gap-1.5 rounded-l-lg border border-r-0 border-border bg-background px-1.5 py-2.5 text-xs font-medium text-foreground shadow-md transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <HelpCircle className="h-4 w-4" aria-hidden="true" />
          <span className="[writing-mode:vertical-rl] rotate-180" aria-hidden="true">
            Ask
          </span>
          {unseenAnswerIds.length > 0 ? (
            <span className="absolute -left-1 -top-1 h-2.5 w-2.5 rounded-full bg-primary ring-2 ring-background" data-testid="helper-answer-ready" />
          ) : null}
        </button>
      ) : null}

      {open ? <DialogFocusPause /> : null}

      {marking ? (
        <div
          data-testid="helper-marking-layer"
          className="pointer-events-auto fixed inset-0 z-[70] cursor-crosshair touch-none bg-black/10"
          onPointerDown={(e) => {
            (e.target as Element).setPointerCapture?.(e.pointerId);
            setDrag({ x: e.clientX, y: e.clientY, x2: e.clientX, y2: e.clientY });
          }}
          onPointerMove={(e) => {
            if (drag) setDrag({ ...drag, x2: e.clientX, y2: e.clientY });
          }}
          onPointerUp={(e) => {
            const point = { x: e.clientX, y: e.clientY };
            const rect = drag ? rectFromPoints(drag.x, drag.y, e.clientX, e.clientY) : null;
            // The layer must be gone before reading the page underneath.
            setMarking(false);
            requestAnimationFrame(() => finishMarking(rect, point));
          }}
          onPointerCancel={cancelMarking}
          onWheel={(e) => {
            // Scrolling still moves the page underneath, so the person can find the part they want.
            helperScrollableAt(e.clientX, e.clientY)?.scrollBy?.({ top: e.deltaY, left: e.deltaX });
          }}
        >
          <div
            role="status"
            className="pointer-events-none fixed left-1/2 top-4 flex max-w-[calc(100vw-2rem)] -translate-x-1/2 items-center gap-3 rounded-md border border-border bg-background px-3 py-1.5 text-sm text-foreground shadow"
          >
            <span>Drag over the part you want help with, or click one thing. You can scroll first. Esc cancels.</span>
            <Button
              size="xs"
              variant="outline"
              className="pointer-events-auto"
              onPointerDown={(e) => e.stopPropagation()}
              onPointerUp={(e) => e.stopPropagation()}
              onClick={cancelMarking}
              data-testid="helper-mark-cancel"
            >
              Cancel
            </Button>
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

      {markedRect && open && !marking && outlineVisible ? (
        <div
          aria-hidden="true"
          data-testid="helper-marked-outline"
          className="pointer-events-none fixed z-[55] rounded border-2 border-dashed border-primary/70"
          style={{ left: markedRect.left, top: markedRect.top, width: markedRect.width, height: markedRect.height }}
        />
      ) : null}

      {open && !marking ? (
        <aside
          ref={panelRef}
          data-testid="helper-panel"
          aria-label="Ask Paperclip"
          className="pointer-events-auto fixed inset-y-0 right-0 z-[60] flex w-full max-w-full flex-col border-l border-border bg-background text-foreground shadow-xl md:w-[var(--helper-width)]"
          style={{ "--helper-width": `${panelWidth}px` } as CSSProperties}
        >
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Drag to make the helper wider or narrower"
            title="Drag to resize"
            className="absolute inset-y-0 -left-1 hidden w-2 cursor-col-resize md:block"
            onPointerDown={startResize}
            data-testid="helper-resize"
          />
          <header className="flex items-start justify-between gap-2 border-b border-border px-4 py-3">
            <div className="min-w-0">
              <h2 className="text-sm font-semibold">Ask Paperclip</h2>
              <p className="text-xs text-muted-foreground" data-testid="helper-subtitle">
                Explains this page — makes no changes.
                <span className="hidden md:inline"> {SHORTCUT_LABEL} opens and closes it.</span>
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              {turns.length > 0 ? (
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={newConversation}
                  aria-label="New conversation"
                  title="New conversation (forgets this one)"
                  data-testid="helper-new-conversation"
                >
                  <MessageSquarePlus className="h-4 w-4" />
                </Button>
              ) : null}
              <Button variant="ghost" size="icon-xs" onClick={closePanel} aria-label="Close the helper" title="Close (Esc)">
                <X className="h-4 w-4" />
              </Button>
            </div>
          </header>

          <div className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain px-4 py-3" data-testid="helper-conversation">
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
                {boardChat.available ? (
                  <p data-testid="helper-board-chat-tip">
                    Want something changed?{" "}
                    <Link to="/board-chat" onClick={onOpenTask} className="font-medium text-foreground underline underline-offset-2">
                      Use Board chat
                    </Link>
                    .
                  </p>
                ) : null}
                <p className="text-xs">The conversation stays while you move between pages, until you close this browser tab.</p>
              </div>
            ) : null}
            <div role="log" aria-live="polite" aria-label="Conversation" className="space-y-3">
              {turns.map(renderTurn)}
            </div>
            {pending ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground" role="status" data-testid="helper-thinking">
                <Loader2 className="h-4 w-4 animate-spin" />
                {slow ? "Still thinking… bigger questions and pictures can take up to a minute." : "Thinking…"}
              </div>
            ) : null}
            {note ? (
              <div className="flex flex-wrap items-center gap-2 rounded-md bg-muted px-3 py-2 text-xs" role="status" data-testid="helper-note">
                <span className="flex-1">{note.text}</span>
                {note.undo ? (
                  <Button size="xs" variant="outline" onClick={note.undo} data-testid="helper-apply-undo">
                    <Undo2 className="h-3.5 w-3.5" /> Undo
                  </Button>
                ) : null}
              </div>
            ) : null}
            {error ? (
              <div role="alert" className="space-y-1.5 rounded-md border border-destructive/40 px-3 py-2 text-xs text-destructive" data-testid="helper-error">
                <p>{error}</p>
                <div className="flex gap-2">
                  <Button size="xs" variant="outline" onClick={() => void send()} disabled={pending || !message.trim()} data-testid="helper-retry">
                    <RotateCcw className="h-3.5 w-3.5" /> Try again
                  </Button>
                  <Button size="xs" variant="ghost" onClick={() => setError(null)}>
                    Dismiss
                  </Button>
                </div>
              </div>
            ) : null}
            {draft ? (
              <InvestigateConfirm
                draft={draft}
                availability={investigationsQuery.data?.availability ?? null}
                loading={investigationsQuery.isFetching}
                starting={startInvestigation.isPending}
                error={startError ?? (investigationsQuery.error ? helperErrorText(investigationsQuery.error, "load") : null)}
                onStart={() => {
                  if (!startInvestigation.isPending) startInvestigation.mutate(draft);
                }}
                onCancel={() => {
                  setDraft(null);
                  setStartError(null);
                }}
              />
            ) : null}
            <DroppedReferencesNotice dropped={droppedNotice} onClose={() => setDroppedNotice([])} />
            <MyInvestigations
              investigations={investigations}
              openIds={listOpenIds}
              canApply={canApply}
              onApply={apply}
              onOpenTask={onOpenTask}
              answerActions={answerActions}
            />
            <div ref={endRef} />
          </div>

          <footer className="max-h-[65%] space-y-2 overflow-y-auto border-t border-border px-4 py-3">
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="xs"
                variant="outline"
                onClick={() => {
                  setFilePickerOpen(false);
                  setMarking(true);
                }}
                data-testid="helper-mark"
                title="Drag over part of the page, or click one thing, to ask about just that"
              >
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
                  data-testid="helper-use-visible-page"
                >
                  <RotateCcw className="h-3.5 w-3.5" /> Use the visible page
                </Button>
              ) : null}
              <label className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground">
                <input
                  type="checkbox"
                  checked={includePage}
                  onChange={(e) => setIncludePage(e.target.checked)}
                  data-testid="helper-include-page"
                />
                Send page text
              </label>
            </div>

            <details
              open={seeOpen}
              onToggle={(e) => {
                const nowOpen = (e.currentTarget as HTMLDetailsElement).open;
                setSeeOpen(nowOpen);
                if (nowOpen && !markedRect && includePage) captureNow(null);
              }}
              className="text-xs"
            >
              <summary className="flex cursor-pointer items-center gap-1 text-muted-foreground">
                <Eye className="h-3.5 w-3.5" /> What the helper sees
                {includePage && capture
                  ? ` (${markedRect ? "marked area" : "visible page"}, ${capture.text.length.toLocaleString()} characters${capture.truncated ? ", cut to fit" : ""})`
                  : includePage
                    ? ""
                    : " (only your question and the page address)"}
              </summary>
              {includePage && summary ? (
                <p className={`mt-1 ${capture?.itemCount === 0 ? "text-amber-700 dark:text-amber-500" : "text-muted-foreground"}`} data-testid="helper-sees-summary">
                  {summary}
                </p>
              ) : null}
              <p className="mt-1 text-muted-foreground">
                Only this text is sent, together with the page address — never a picture of the screen. Passwords, keys and
                anything that looks like one are left out or shown as [hidden]. Embedded pages some add-ons show cannot be
                read.
              </p>
              <pre
                data-testid="helper-sees"
                className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap rounded border border-border bg-muted/40 p-2 font-mono text-[11px]"
              >
                {!includePage
                  ? `Page address: ${route}\n(No page text will be sent.)`
                  : capture?.text
                    ? capture.text
                    : `Page address: ${route}\n(Reading the page… it is read again when you send.)`}
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
                  aria-expanded={filePickerOpen}
                  data-testid="helper-from-files"
                >
                  <FolderOpen className="h-3.5 w-3.5" /> From Files
                </Button>
                <span className="text-[11px] text-muted-foreground">or paste one. Up to {HELPER_PICTURES_MAX}, 5 MB each.</span>
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
                  companyId={companyId}
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
                <p className="text-[11px] text-muted-foreground">Only these pictures are sent, with this question only. They are not saved.</p>
              ) : null}
              {pictureProblems.map((problem) => (
                <p key={problem} role="alert" className="text-xs text-destructive">
                  {problem}
                </p>
              ))}
            </div>

            <label className="block text-xs">
              <span className="text-muted-foreground">Model that answers</span>
              <select
                className="mt-0.5 w-full rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground"
                value={entryId}
                onChange={(e) => setEntryId(e.target.value)}
                disabled={!settings}
                data-testid="helper-model"
              >
                <option value="">
                  {settings
                    ? `Use default (${defaultModel ? defaultModel.name : settings.builtInDefaultLabel}) — ${helperStatusText(defaultModel ? defaultModel.status : settings.builtInDefaultStatus)}`
                    : settingsQuery.isError
                      ? "Use default"
                      : "Loading models…"}
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
            {settingsQuery.isError ? (
              <p className="text-xs text-amber-700 dark:text-amber-500" data-testid="helper-settings-error">
                The model list could not be loaded ({helperErrorText(settingsQuery.error, "load")}) You can still ask with the
                default model.
              </p>
            ) : null}
            {settings && effective.status && !isHelperStatusReady(effective.status) ? (
              <p className="text-xs text-amber-700 dark:text-amber-500" data-testid="helper-model-warning">
                {helperStatusText(effective.status)}: {chosen && !chosen.keyReady && chosen.keyHint ? chosen.keyHint : effective.status.detail}
              </p>
            ) : null}
            {blindWithPictures ? (
              <div className="space-y-1 rounded-md border border-amber-500/50 px-2 py-1.5 text-xs" role="alert" data-testid="helper-vision-gate">
                <p>
                  {effective.canSeePictures === false
                    ? `“${effective.name}” cannot look at pictures, so it cannot answer about the ones you attached.`
                    : `Paperclip does not know whether “${effective.name}” can look at pictures, so they are not sent to it.`}{" "}
                  {visionModels.length > 0 || offerBuiltInForPictures
                    ? "Pick a model that can, or remove the pictures."
                    : "None of this company's models is known to see pictures yet, so remove the pictures to ask."}
                </p>
                {visionModels.length > 0 || offerBuiltInForPictures ? (
                  <div className="flex flex-wrap gap-1">
                    {offerBuiltInForPictures ? (
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
                ) : null}
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
                  if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    void send();
                  }
                }}
                className="min-h-[64px] flex-1 text-sm"
                aria-label="Your question"
                aria-describedby="helper-composer-hint"
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
                <Button
                  size="icon-sm"
                  onClick={() => void send()}
                  disabled={pending || !message.trim() || blindWithPictures}
                  aria-label="Send"
                  title="Send (Enter)"
                >
                  {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                </Button>
              </div>
            </div>
            <p id="helper-composer-hint" className="text-[11px] text-muted-foreground">
              Enter sends, Shift+Enter starts a new line.
              {message.length > HELPER_MESSAGE_MAX_CHARS - 300
                ? ` ${message.length.toLocaleString()} of ${HELPER_MESSAGE_MAX_CHARS.toLocaleString()} characters.`
                : ""}
            </p>
          </footer>
        </aside>
      ) : null}
    </DismissableLayer.Branch>
  );
}
