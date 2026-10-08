import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { HelpCircle, Crop, X, Send, Eye, RotateCcw, Loader2 } from "lucide-react";
import { HELPER_MESSAGE_MAX_CHARS, type HelperAskResponse, type HelperModelOption } from "@paperclipai/shared";
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

/**
 * "Ask Paperclip" — the floating helper (Phase 1).
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
 */

interface Turn {
  role: "user" | "assistant";
  content: string;
  meta?: Pick<HelperAskResponse, "modelLabel" | "costCents" | "truncated">;
  /** Fields the person marked when asking this question. */
  applyTargets?: string[];
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
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const registeredTargets = useHelperApplyTargets();

  const route = `${location.pathname}${location.search}`;

  const settingsQuery = useQuery({
    queryKey: queryKeys.companies.helperSettings(selectedCompanyId ?? ""),
    queryFn: () => helperApi.getSettings(selectedCompanyId!),
    enabled: open && Boolean(selectedCompanyId),
    staleTime: 60_000,
  });
  const settings = settingsQuery.data;
  const groups = useMemo(() => groupEntries((settings?.models ?? []).map(toCatalogueItem), "maker"), [settings?.models]);
  const chosen = settings?.models.find((m) => m.id === entryId) ?? null;
  const defaultModel = settings?.models.find((m) => m.id === settings.defaultDirectoryEntryId) ?? null;

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

  const send = async () => {
    const text = message.trim();
    if (!text || pending) return;
    setPending(true);
    setError(null);
    setAppliedNote(null);
    const history = turns.map((t) => ({ role: t.role, content: t.content }));
    const asked: Turn = { role: "user", content: text, applyTargets: capture?.applyTargets ?? [] };
    setTurns((prev) => [...prev, asked]);
    setMessage("");
    try {
      const result = await helperApi.ask(selectedCompanyId, {
        message: text,
        context: capture?.text ?? null,
        pageRoute: route,
        directoryEntryId: entryId || null,
        history,
      });
      setTurns((prev) => [
        ...prev,
        {
          role: "assistant",
          content: result.answer,
          meta: { modelLabel: result.modelLabel, costCents: result.costCents, truncated: result.truncated },
          applyTargets: asked.applyTargets,
        },
      ]);
    } catch (err) {
      setError(describeError(err));
      setTurns((prev) => prev.slice(0, -1));
      setMessage(text);
    } finally {
      setPending(false);
    }
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
                </ul>
              </div>
            ) : null}
            {turns.map((turn, index) =>
              turn.role === "user" ? (
                <div key={index} className="ml-8 rounded-lg bg-muted px-3 py-2 text-sm whitespace-pre-wrap">
                  {turn.content}
                </div>
              ) : (
                <div key={index} className="space-y-2" data-testid="helper-answer">
                  <MarkdownBody className="text-sm">{turn.content}</MarkdownBody>
                  <div className="flex flex-wrap items-center gap-2">
                    {(turn.applyTargets ?? [])
                      .filter((label) => registeredTargets.includes(label) || canApplyHelperAnswer(label))
                      .map((label) => (
                        <Button key={label} size="xs" variant="outline" onClick={() => apply(label, turn.content)}>
                          Apply to {label}
                        </Button>
                      ))}
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
                </option>
                {groups.map((group) => (
                  <optgroup key={group.key} label={group.title}>
                    {group.entries.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name}
                        {item.option.keyReady ? "" : " (needs a key)"}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </label>
            {chosen && !chosen.keyReady && chosen.keyHint ? <p className="text-xs text-amber-600">{chosen.keyHint}</p> : null}

            <div className="flex items-end gap-2">
              <Textarea
                ref={inputRef}
                value={message}
                maxLength={HELPER_MESSAGE_MAX_CHARS}
                rows={3}
                placeholder="Ask about this page…"
                onChange={(e) => setMessage(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void send();
                  }
                }}
                className="min-h-[64px] flex-1 text-sm"
                aria-label="Your question"
              />
              <Button size="icon-sm" onClick={() => void send()} disabled={pending || !message.trim()} aria-label="Send">
                <Send className="h-4 w-4" />
              </Button>
            </div>
          </footer>
        </aside>
      ) : null}
    </>
  );
}

