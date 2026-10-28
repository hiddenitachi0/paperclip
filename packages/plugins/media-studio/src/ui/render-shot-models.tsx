import { useCallback, useEffect, useState } from "react";
import { errorText, storylineFetchJson } from "./storyline-api.js";
import type { StripClip, StripSummary } from "./strip-panel.js";
import { FAL_VIDEO_MODELS, VideoModelPicker, type SogniVideoModelRow } from "./video-model-picker.js";

// Step 5's "which video model will each shot use" list: every AI shot says
// what its next render will use, a person can keep one shot on a different
// model (a "pin"), and one button puts every shot back on the film's model.
// Reads /video-storylines/:id/strip (each AI clip carries `willUse` and
// `pinned`), pins with PATCH .../shots/:shotId { providerId, model } (a null
// providerId clears the pin) and un-pins everything with
// POST .../shots/use-film-model. Standalone ES module (see index.tsx's note):
// local types and styles, no imports from @paperclipai/shared.

const card: React.CSSProperties = { border: "1px solid rgba(128,128,128,0.35)", borderRadius: 10, padding: 12, display: "flex", flexDirection: "column", gap: 8 };
const baseBtn: React.CSSProperties = { padding: "6px 12px", borderRadius: 8, border: "1px solid transparent", cursor: "pointer", fontSize: 12, fontWeight: 600 };
const primaryBtn: React.CSSProperties = { ...baseBtn, background: "#1971c2", color: "#fff" };
const secondaryBtn: React.CSSProperties = { ...baseBtn, background: "#e7f5ff", color: "#1971c2", borderColor: "#a5d8ff" };
const ghostBtn: React.CSSProperties = { ...baseBtn, background: "transparent", color: "#495057", borderColor: "#ced4da" };
const input: React.CSSProperties = { padding: 8, borderRadius: 8, border: "1px solid rgba(128,128,128,0.5)", fontFamily: "inherit", fontSize: 13, background: "transparent", color: "inherit" };
const errorBox: React.CSSProperties = { background: "#fff0f6", color: "#a61e4d", padding: "8px 10px", borderRadius: 8, fontSize: 13, whiteSpace: "pre-line" };
const okBox: React.CSSProperties = { background: "#ebfbee", color: "#087f5b", padding: "8px 10px", borderRadius: 8, fontSize: 12 };
const muted: React.CSSProperties = { fontSize: 12, color: "#868e96", margin: 0 };
const field: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 4 };

const SERVICES: Array<{ value: "fal" | "sogni"; label: string }> = [
  { value: "fal", label: "Fal.ai" },
  { value: "sogni", label: "Sogni" },
];

export function serviceLabel(providerId: string): string {
  return SERVICES.find((s) => s.value === providerId)?.label ?? providerId;
}

/** A model in words a person can read: "Sogni, LTX-2.3 I2V" (never a raw model id when we know its name). */
export function modelText(use: { providerId: string; model: string | null }, sogniModels: SogniVideoModelRow[] | null): string {
  const service = serviceLabel(use.providerId);
  if (!use.model) return use.providerId === "fal" ? `${service}, automatic (Kling)` : `${service}, its default model`;
  const name =
    use.providerId === "sogni" ? sogniModels?.find((m) => m.id === use.model)?.name : FAL_VIDEO_MODELS.find((m) => m.id === use.model)?.name;
  return `${service}, ${name ?? use.model}`;
}

function sameModel(a: { providerId: string; model: string | null }, b: { providerId: string; model: string | null }): boolean {
  return a.providerId === b.providerId && (a.model ?? null) === (b.model ?? null);
}

/** Only AI shots have a model; your own videos and photos do not. */
function aiClips(strip: StripSummary | null): StripClip[] {
  return (strip?.clips ?? []).filter((c) => c.willUse != null);
}

export function RenderShotModels(props: {
  apiBase: string;
  /** False while the film is being made or put together: pins cannot change then. */
  editable: boolean;
  /** The film's own service and model (changes here refresh the list). */
  filmProviderId: string;
  filmModel: string | null;
  sogniModels: SogniVideoModelRow[] | null;
  sogniNote?: string | null;
  reloadKey?: number;
  /** Called after every change so the page can refresh its own copies (cost, shots). */
  onChanged?: () => void | Promise<void>;
}) {
  const { apiBase, editable, filmProviderId, filmModel } = props;
  const [strip, setStrip] = useState<StripSummary | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<{ shotId: string; providerId: "fal" | "sogni"; model: string | null } | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await storylineFetchJson<StripSummary>(`${apiBase}/strip`, undefined, "loading the video models");
      setStrip(res && Array.isArray(res.clips) ? res : null);
      setLoadError(null);
    } catch (e) {
      setLoadError(errorText(e));
    }
  }, [apiBase]);
  useEffect(() => {
    void load();
  }, [load, props.reloadKey, filmProviderId, filmModel]);

  const run = async (fn: () => Promise<string | null>) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const message = await fn();
      await load();
      await props.onChanged?.();
      setNotice(message);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const clips = aiClips(strip);
  if (!strip && !loadError) return null;
  if (strip && clips.length === 0) return null;
  const pinnedCount = clips.filter((c) => c.pinned).length;
  const film = { providerId: filmProviderId, model: filmModel };

  const pin = (shotId: string, providerId: "fal" | "sogni", model: string | null) =>
    run(async () => {
      await storylineFetchJson(`${apiBase}/shots/${shotId}`, { method: "PATCH", body: JSON.stringify({ providerId, model }) }, "keeping this shot on that model");
      setEditing(null);
      return "Done. This shot will keep using that model.";
    });
  const unpin = (shotId: string) =>
    run(async () => {
      await storylineFetchJson(`${apiBase}/shots/${shotId}`, { method: "PATCH", body: JSON.stringify({ providerId: null }) }, "putting this shot back on the film's model");
      setEditing(null);
      return "Done. This shot follows the film's model again.";
    });
  const useFilmModelForAll = () =>
    run(async () => {
      await storylineFetchJson(`${apiBase}/shots/use-film-model`, { method: "POST", body: JSON.stringify({}) }, "putting every shot back on the film's model");
      setEditing(null);
      return "Done. Every shot follows the film's model again.";
    });

  return (
    <div style={card} data-testid="render-shot-models">
      <div>
        <strong style={{ fontSize: 13 }}>Which video model each shot will use</strong>
        <p style={muted}>
          Every shot follows the film's model ({modelText(film, props.sogniModels)}) unless you keep it on a different one. Shots that are already made keep the clip they have; the model you choose
          is used the next time that shot is made.
        </p>
      </div>
      {loadError && !strip && (
        <div style={errorBox} role="alert">
          {loadError}
        </div>
      )}
      {error && (
        <div style={errorBox} role="alert" data-testid="shot-models-error">
          {error}
        </div>
      )}
      {notice && (
        <div style={okBox} role="status" data-testid="shot-models-notice">
          {notice}
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {clips.map((clip) => {
          const willUse = clip.willUse!;
          const madeWith = clip.status === "done" && clip.providerId ? { providerId: clip.providerId, model: clip.model ?? null } : null;
          const isEditing = editing?.shotId === clip.shotId;
          return (
            <div key={clip.shotId} style={{ display: "flex", flexDirection: "column", gap: 6, fontSize: 13 }} data-testid={`shot-model-${clip.shotId}`}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <span>
                  <strong>Shot {clip.orderIndex + 1}</strong> will use <span data-testid={`will-use-${clip.shotId}`}>{modelText(willUse, props.sogniModels)}</span>
                  {clip.pinned && (
                    <span style={{ marginLeft: 8, fontSize: 11, fontWeight: 600, background: "#fff3bf", color: "#7f5f01", borderRadius: 6, padding: "1px 6px" }} data-testid={`pinned-${clip.shotId}`}>
                      Kept on this model
                    </span>
                  )}
                </span>
                {!isEditing && (
                  <span style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                    <button
                      type="button"
                      style={secondaryBtn}
                      disabled={busy || !editable}
                      onClick={() => setEditing({ shotId: clip.shotId, providerId: willUse.providerId === "sogni" ? "sogni" : "fal", model: willUse.model })}
                    >
                      {clip.pinned ? "Change model" : "Keep this shot on a model"}
                    </button>
                    {clip.pinned && (
                      <button type="button" style={ghostBtn} disabled={busy || !editable} onClick={() => void unpin(clip.shotId)}>
                        Follow the film's model
                      </button>
                    )}
                  </span>
                )}
              </div>
              {madeWith && !sameModel(madeWith, willUse) && (
                <span style={muted}>This clip was made with {modelText(madeWith, props.sogniModels)}. Making it again would use the model above.</span>
              )}
              {isEditing && editing && (
                <div style={{ ...card, background: "rgba(128,128,128,0.06)" }} data-testid={`pin-editor-${clip.shotId}`}>
                  <div style={field}>
                    <label style={{ fontSize: 12, color: "#868e96" }} htmlFor={`pin-service-${clip.shotId}`}>
                      Video service for this shot
                    </label>
                    <select
                      id={`pin-service-${clip.shotId}`}
                      style={input}
                      value={editing.providerId}
                      disabled={busy}
                      // A model belongs to one service, so switching service goes back to that service's default model.
                      onChange={(e) => setEditing({ ...editing, providerId: e.target.value === "sogni" ? "sogni" : "fal", model: null })}
                    >
                      {SERVICES.map((s) => (
                        <option key={s.value} value={s.value}>
                          {s.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div style={field}>
                    <label style={{ fontSize: 12, color: "#868e96" }}>Video model for this shot</label>
                    <VideoModelPicker
                      key={`${clip.shotId}-${editing.providerId}`}
                      provider={editing.providerId}
                      value={editing.model}
                      sogniModels={props.sogniModels}
                      sogniNote={props.sogniNote}
                      disabled={busy}
                      onChange={(next) => setEditing({ ...editing, model: next })}
                    />
                  </div>
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                    <button type="button" style={primaryBtn} disabled={busy} onClick={() => void pin(clip.shotId, editing.providerId, editing.model)}>
                      Keep this shot on this model
                    </button>
                    <button type="button" style={ghostBtn} disabled={busy} onClick={() => setEditing(null)}>
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <button type="button" style={ghostBtn} disabled={busy || !editable || pinnedCount === 0} onClick={() => void useFilmModelForAll()} data-testid="use-film-model">
          Use the film's model for all shots
        </button>
        {pinnedCount > 0 ? (
          <span style={muted}>
            {pinnedCount === 1 ? "1 shot is kept on its own model." : `${pinnedCount} shots are kept on their own model.`}
          </span>
        ) : (
          <span style={muted}>No shot is kept on its own model.</span>
        )}
      </div>
      {!editable && <p style={muted}>Models cannot be changed while the film is being made or put together. Try again when it has finished.</p>}
    </div>
  );
}
