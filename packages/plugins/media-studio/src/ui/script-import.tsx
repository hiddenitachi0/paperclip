import { useEffect, useRef, useState } from "react";
import { errorText, storylineFetchJson } from "./storyline-api.js";

// "Import script (JSON)" and "Script-writer instructions" for the Storylines
// editor. The script is checked by the server (a dry run of the same import
// route), so the preview and the real import can never disagree, and the
// instructions text comes from GET .../script-instructions -- the one shared
// constant the server also serves to anyone else.

const card: React.CSSProperties = { border: "1px solid rgba(128,128,128,0.35)", borderRadius: 10, padding: 12, display: "flex", flexDirection: "column", gap: 8 };
const input: React.CSSProperties = { padding: 8, borderRadius: 8, border: "1px solid rgba(128,128,128,0.5)", fontFamily: "inherit", fontSize: 13, background: "transparent", color: "inherit" };
const errorBox: React.CSSProperties = { background: "#fff0f6", color: "#a61e4d", padding: "8px 10px", borderRadius: 8, fontSize: 13, whiteSpace: "pre-line" };
const okBox: React.CSSProperties = { background: "#e6fcf5", color: "#087f5b", padding: "8px 10px", borderRadius: 8, fontSize: 13 };
const noticeBox: React.CSSProperties = { background: "#fff9db", color: "#7f5f01", padding: "8px 10px", borderRadius: 8, fontSize: 12 };
const baseBtn: React.CSSProperties = { padding: "6px 12px", borderRadius: 8, border: "1px solid transparent", cursor: "pointer", fontSize: 12, fontWeight: 600 };
const primaryBtn: React.CSSProperties = { ...baseBtn, background: "#1971c2", color: "#fff" };
const ghostBtn: React.CSSProperties = { ...baseBtn, background: "transparent", color: "#495057", borderColor: "#ced4da" };

export interface ScriptImportSummary {
  dryRun: boolean;
  mode: "append" | "replace" | "new";
  storylineId: string | null;
  sceneCount: number;
  shotCount: number;
  totalSeconds: number;
  billedSeconds: number;
  estimatedCostCents: number;
  characterCount: number;
  storyline?: { id: string } | null;
}

function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function seconds(total: number): string {
  if (total < 60) return `${total} seconds`;
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m} min${s ? ` ${s} s` : ""}`;
}

/** Local JSON syntax check, so a stray comma says where it is before anything is sent. */
export function parseScriptText(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  if (!trimmed) return { ok: false, error: "Paste a script or choose a .json file first." };
  try {
    return { ok: true, value: JSON.parse(trimmed) };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const position = /position (\d+)/.exec(message);
    if (position) {
      const index = Number(position[1]);
      const before = trimmed.slice(0, index);
      const line = before.split("\n").length;
      const column = index - before.lastIndexOf("\n");
      return { ok: false, error: `This is not valid JSON (problem near line ${line}, column ${column}). Check for a missing comma, quote or bracket there.` };
    }
    return { ok: false, error: `This is not valid JSON: ${message}` };
  }
}

export function ScriptImportDialog(props: {
  companyId: string;
  /** Import into this storyline; null = create a new storyline from the script. */
  storylineId: string | null;
  defaultProvider?: "fal" | "sogni";
  onImported: (storylineId: string) => void | Promise<void>;
  onClose: () => void;
}) {
  const { companyId, storylineId } = props;
  const base = `/api/companies/${companyId}/video-storylines`;
  const [text, setText] = useState("");
  const [mode, setMode] = useState<"append" | "replace">("append");
  const [title, setTitle] = useState("");
  const [provider, setProvider] = useState<"fal" | "sogni">(props.defaultProvider ?? "fal");
  const [budget, setBudget] = useState("");
  const [preview, setPreview] = useState<ScriptImportSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Anything changed after a check means the preview is stale - except the
  // text that was just checked (choosing a file sets the text and checks it
  // in the same step).
  const checkedText = useRef<string | null>(null);
  useEffect(() => {
    if (checkedText.current !== text) setPreview(null);
  }, [text]);
  useEffect(() => {
    setPreview(null);
  }, [mode, provider]);

  const budgetCents = (): number | null | "invalid" => {
    if (!budget.trim()) return null;
    const value = Math.round(Number(budget) * 100);
    return Number.isFinite(value) && value >= 0 ? value : "invalid";
  };

  const body = (dryRun: boolean, source: string = text): Record<string, unknown> | { error: string } => {
    const parsed = parseScriptText(source);
    if (!parsed.ok) return { error: parsed.error };
    if (storylineId) return { mode, script: parsed.value, dryRun };
    const cents = budgetCents();
    if (cents === "invalid") return { error: "The budget cap must be an amount in dollars, like 20 or 12.50." };
    const scriptTitle =
      parsed.value && typeof parsed.value === "object" && typeof (parsed.value as { title?: unknown }).title === "string"
        ? ((parsed.value as { title: string }).title.trim() || null)
        : null;
    if (!title.trim() && !scriptTitle) return { error: "Give the new storyline a title (or put a \"title\" in the script)." };
    return {
      script: parsed.value,
      ...(title.trim() ? { title: title.trim() } : {}),
      providerId: provider,
      budgetCapCents: cents,
      dryRun,
    };
  };

  const url = storylineId ? `${base}/${storylineId}/import` : `${base}/import`;

  const check = async (source?: string) => {
    setError(null);
    setPreview(null);
    const checking = source ?? text;
    checkedText.current = checking;
    const payload = body(true, checking);
    if ("error" in payload && typeof payload.error === "string") {
      setError(payload.error);
      return;
    }
    setBusy(true);
    try {
      setPreview(await storylineFetchJson<ScriptImportSummary>(url, { method: "POST", body: JSON.stringify(payload) }, "checking the script"));
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const confirm = async () => {
    setError(null);
    const payload = body(false);
    if ("error" in payload && typeof payload.error === "string") {
      setError(payload.error);
      return;
    }
    if (storylineId && mode === "replace" && !window.confirm("Replace ALL scenes and shots in this storyline with the script? The current ones are deleted.")) return;
    setBusy(true);
    try {
      const result = await storylineFetchJson<ScriptImportSummary>(url, { method: "POST", body: JSON.stringify(payload) }, "importing the script");
      await props.onImported(result.storyline?.id ?? result.storylineId ?? storylineId ?? "");
      props.onClose();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) {
      setError("That file is bigger than 10 MB. Split the script into smaller parts.");
      return;
    }
    const loaded = await file.text();
    setText(loaded);
    // Check straight away: choosing a file should show the preview (or what
    // is wrong) without a second click.
    void check(loaded);
  };

  return (
    <div style={{ ...card, borderColor: "#a5d8ff" }} data-testid="script-import-dialog">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <strong style={{ fontSize: 13 }}>{storylineId ? "Import script (JSON) into this storyline" : "New storyline from a script (JSON)"}</strong>
        <button type="button" style={ghostBtn} onClick={props.onClose}>Close</button>
      </div>
      <p style={{ fontSize: 12, color: "#868e96", margin: 0 }}>
        Paste the JSON your script writer produced, or choose a .json file. Press "Check script" to see what will be created before anything is saved.
      </p>
      <textarea
        style={{ ...input, minHeight: 160, fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: 12 }}
        aria-label="Script JSON"
        placeholder='{"title": "...", "characters": {...}, "scenes": [{"scene_title": "...", "shots": [{"prompt": "..."}]}]}'
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setPreview(null);
        }}
        onPaste={(e) => {
          const pasted = e.clipboardData.getData("text");
          if (pasted.trim()) {
            e.preventDefault();
            setText(pasted);
            void check(pasted);
          }
        }}
      />
      <label style={{ fontSize: 12, display: "flex", alignItems: "center", gap: 6 }}>
        Or choose a file:
        <input type="file" accept=".json,application/json" aria-label="Script file" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; void onFile(f); }} />
      </label>

      {storylineId ? (
        <div style={{ display: "flex", gap: 12, fontSize: 12 }}>
          <label style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <input type="radio" name="script-import-mode" checked={mode === "append"} onChange={() => setMode("append")} />
            Add to the end
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <input type="radio" name="script-import-mode" checked={mode === "replace"} onChange={() => setMode("replace")} />
            Replace all scenes and shots (only before anything is rendered or paid for)
          </label>
        </div>
      ) : (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <input style={{ ...input, flex: 2, minWidth: 180 }} aria-label="Storyline title" placeholder="Title (or use the script's title)" value={title} onChange={(e) => setTitle(e.target.value)} />
          <select style={input} aria-label="Video service" value={provider} onChange={(e) => setProvider(e.target.value as "fal" | "sogni")}>
            <option value="fal">Fal.ai</option>
            <option value="sogni">Sogni</option>
          </select>
          <input style={{ ...input, width: 140 }} type="number" min={0} step="0.01" aria-label="Budget cap in dollars" placeholder="Budget cap ($)" value={budget} onChange={(e) => setBudget(e.target.value)} />
        </div>
      )}

      {error && <div style={errorBox} role="alert">{error}</div>}
      {preview && (
        <div style={okBox} data-testid="script-import-preview">
          {preview.sceneCount} scene{preview.sceneCount === 1 ? "" : "s"}, {preview.shotCount} shot{preview.shotCount === 1 ? "" : "s"}, {seconds(preview.totalSeconds)} of video
          {preview.billedSeconds !== preview.totalSeconds ? ` (rendered as ${seconds(preview.billedSeconds)}, since the video model only makes 5- or 10-second clips)` : ""}.
          {" "}Estimated video cost: about {money(preview.estimatedCostCents)} (a ballpark, not a quote).
          {preview.characterCount > 0 ? ` ${preview.characterCount} character description${preview.characterCount === 1 ? "" : "s"} will be saved in the first scene's notes.` : ""}
        </div>
      )}
      {storylineId && mode === "replace" && <div style={noticeBox}>Replace deletes every current scene and shot of this storyline.</div>}

      <div style={{ display: "flex", gap: 8 }}>
        <button type="button" style={ghostBtn} disabled={busy} onClick={() => void check()}>{busy ? "Checking…" : "Check script"}</button>
        <button type="button" style={primaryBtn} disabled={busy || !preview} title={preview ? undefined : "Check the script first"} onClick={() => void confirm()}>
          {storylineId ? (mode === "replace" ? "Replace with this script" : "Import") : "Create storyline"}
        </button>
      </div>
      {!preview && !error && !busy && (
        <div style={{ fontSize: 12, opacity: 0.75 }}>
          {text.trim() ? "Press \"Check script\" to see what will be created; the import button unlocks after that." : "Choose a .json file or paste the script above - it is checked automatically."}
        </div>
      )}
    </div>
  );
}

export function ScriptInstructionsDialog(props: { companyId: string; onClose: () => void }) {
  const [markdown, setMarkdown] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    storylineFetchJson<{ markdown: string }>(`/api/companies/${props.companyId}/video-storylines/script-instructions`, undefined, "loading the instructions")
      .then((res) => setMarkdown(res.markdown))
      .catch((e) => setError(errorText(e)));
  }, [props.companyId]);

  const copy = async () => {
    if (!markdown) return;
    try {
      await navigator.clipboard.writeText(markdown);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setError("Copying was blocked by the browser. Select the text below and copy it by hand, or download it.");
    }
  };

  const download = () => {
    if (!markdown) return;
    const url = URL.createObjectURL(new Blob([markdown], { type: "text/markdown" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "video-script-writer-instructions.md";
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  };

  return (
    <div style={{ ...card, borderColor: "#a5d8ff" }} data-testid="script-instructions-dialog">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <strong style={{ fontSize: 13 }}>Instructions for an AI script writer</strong>
        <button type="button" style={ghostBtn} onClick={props.onClose}>Close</button>
      </div>
      <p style={{ fontSize: 12, color: "#868e96", margin: 0 }}>
        Give these instructions (plus your story idea) to an AI like Claude or ChatGPT. It answers with a JSON script you can import here.
      </p>
      {error && <div style={errorBox} role="alert">{error}</div>}
      <div style={{ display: "flex", gap: 8 }}>
        <button type="button" style={primaryBtn} disabled={!markdown} onClick={() => void copy()}>{copied ? "Copied" : "Copy instructions"}</button>
        <button type="button" style={ghostBtn} disabled={!markdown} onClick={download}>Download as .md</button>
      </div>
      <pre
        style={{ margin: 0, maxHeight: 360, overflow: "auto", whiteSpace: "pre-wrap", fontSize: 12, background: "rgba(128,128,128,0.08)", borderRadius: 8, padding: 10 }}
        data-testid="script-instructions-text"
      >
        {markdown ?? (error ? "" : "Loading...")}
      </pre>
    </div>
  );
}
