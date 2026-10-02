import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PluginHostContext } from "@paperclipai/plugin-sdk/ui";
import { usePluginAction } from "@paperclipai/plugin-sdk/ui";

// Standalone ES module (see index.tsx's note): bare specifiers only outside
// this ui/ folder. Keep these action keys in sync with manifest.ts.
const ACTION_EDIT_CAPABILITIES = "edit.capabilities";
const ACTION_EDIT_SOGNI = "edit.sogni";
const ACTION_EDIT_FAL = "edit.fal";

const MAKE_VARIATION_PROMPT = "Make a creative variation of this picture, keeping the same subject and composition.";

function hostFetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  return fetch(path, { credentials: "include", headers: { "content-type": "application/json", ...(init?.headers ?? {}) }, ...init }).then(
    async (res) => {
      if (!res.ok) throw new Error((await res.text()) || `Request failed: ${res.status}`);
      return (res.status === 204 ? (undefined as T) : ((await res.json()) as T));
    },
  );
}

// Local style palette (duplicated from index.tsx on purpose: this file is
// compiled and served standalone alongside it, and index.tsx imports this
// module, so importing back would be circular).
const card: React.CSSProperties = { border: "1px solid rgba(128,128,128,0.35)", borderRadius: 10, padding: 12, display: "flex", flexDirection: "column", gap: 10 };
const field: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 4 };
const input: React.CSSProperties = { padding: 8, borderRadius: 8, border: "1px solid rgba(128,128,128,0.5)", fontFamily: "inherit", fontSize: 13, background: "transparent", color: "inherit" };
const thumb: React.CSSProperties = { width: 84, height: 84, objectFit: "cover", borderRadius: 6, display: "block", cursor: "pointer", border: "1px solid rgba(128,128,128,0.35)" };
const errorBox: React.CSSProperties = { background: "#fff0f6", color: "#a61e4d", padding: "8px 10px", borderRadius: 8, fontSize: 13 };
const okBox: React.CSSProperties = { background: "#e6fcf5", color: "#087f5b", padding: "8px 10px", borderRadius: 8, fontSize: 13 };
const baseBtn: React.CSSProperties = { padding: "6px 12px", borderRadius: 8, border: "1px solid transparent", cursor: "pointer", fontSize: 12, fontWeight: 600 };
const primaryBtn: React.CSSProperties = { ...baseBtn, background: "#1971c2", color: "#fff" };
const secondaryBtn: React.CSSProperties = { ...baseBtn, background: "#e7f5ff", color: "#1971c2", borderColor: "#a5d8ff" };
const ghostBtn: React.CSSProperties = { ...baseBtn, background: "transparent", color: "#495057", borderColor: "#ced4da" };
const disabledBtn: React.CSSProperties = { ...baseBtn, background: "#e9ecef", color: "#adb5bd", cursor: "not-allowed" };
const sectionTitle: React.CSSProperties = { fontSize: 12, fontWeight: 700, color: "#495057", textTransform: "uppercase", letterSpacing: 0.3, margin: 0 };

type PickerItem = {
  id: string;
  title: string;
  contentType: string | null;
  openPath: string | null;
  originalFilename: string | null;
};

type TextLayer = {
  id: string;
  text: string;
  xPct: number; // 0..100, left edge
  yPct: number; // 0..100, top edge
  fontSize: number;
  color: string;
};

type Adjustments = {
  rotationDeg: number;
  brightness: number; // 100 = unchanged
  contrast: number;
  saturation: number;
};

const DEFAULT_ADJUSTMENTS: Adjustments = { rotationDeg: 0, brightness: 100, contrast: 100, saturation: 100 };

/** Degrees -> radians. */
function rad(deg: number): number {
  return (deg * Math.PI) / 180;
}

/** The pixel bounding box of a w x h rectangle rotated by `deg` around its center. */
function rotatedBounds(w: number, h: number, deg: number): { width: number; height: number } {
  const r = rad(deg);
  const cos = Math.abs(Math.cos(r));
  const sin = Math.abs(Math.sin(r));
  return { width: Math.round(w * cos + h * sin), height: Math.round(w * sin + h * cos) };
}

/**
 * Draws `img` rotated and cropped into a canvas sized to `outW` x `outH`,
 * with the given CSS-style filter and any text layers on top. One function
 * so the small on-screen preview and the full-resolution save use the exact
 * same pipeline.
 */
function renderComposite(params: {
  img: HTMLImageElement;
  rotationDeg: number;
  cropPct: { x: number; y: number; w: number; h: number } | null;
  outW: number;
  outH: number;
  brightness: number;
  contrast: number;
  saturation: number;
  textLayers: TextLayer[];
}): HTMLCanvasElement {
  const { img, rotationDeg, cropPct, outW, outH, brightness, contrast, saturation, textLayers } = params;
  const bounds = rotatedBounds(img.naturalWidth, img.naturalHeight, rotationDeg);

  const rotated = document.createElement("canvas");
  rotated.width = bounds.width;
  rotated.height = bounds.height;
  const rctx = rotated.getContext("2d")!;
  rctx.translate(bounds.width / 2, bounds.height / 2);
  rctx.rotate(rad(rotationDeg));
  rctx.drawImage(img, -img.naturalWidth / 2, -img.naturalHeight / 2);

  const crop = cropPct ?? { x: 0, y: 0, w: 100, h: 100 };
  const srcX = (crop.x / 100) * bounds.width;
  const srcY = (crop.y / 100) * bounds.height;
  const srcW = Math.max(1, (crop.w / 100) * bounds.width);
  const srcH = Math.max(1, (crop.h / 100) * bounds.height);

  const out = document.createElement("canvas");
  out.width = Math.max(1, Math.round(outW));
  out.height = Math.max(1, Math.round(outH));
  const octx = out.getContext("2d")!;
  octx.filter = `brightness(${brightness}%) contrast(${contrast}%) saturate(${saturation}%)`;
  octx.drawImage(rotated, srcX, srcY, srcW, srcH, 0, 0, out.width, out.height);
  octx.filter = "none";

  for (const layer of textLayers) {
    octx.fillStyle = layer.color;
    octx.font = `${Math.round((layer.fontSize / 100) * out.width)}px sans-serif`;
    octx.textBaseline = "top";
    octx.fillText(layer.text, (layer.xPct / 100) * out.width, (layer.yPct / 100) * out.height);
  }

  return out;
}

/**
 * Media Studio's Edit tab (DUR-4063): open a picture from Media Studio /
 * Files or your own computer, crop, rotate, resize, adjust brightness /
 * contrast / saturation, add text, and run AI edits (Sogni / Fal). Saving
 * always writes a brand-new file -- the picture you opened is never changed.
 */
export function MediaStudioEditTab({ context, initialFileId }: { context: PluginHostContext; initialFileId?: string | null }) {
  const editSogni = usePluginAction(ACTION_EDIT_SOGNI);
  const editFal = usePluginAction(ACTION_EDIT_FAL);
  const getCapabilities = usePluginAction(ACTION_EDIT_CAPABILITIES);

  const [capabilities, setCapabilities] = useState<{ sogni: boolean; fal: boolean } | null>(null);
  const [pickerItems, setPickerItems] = useState<PickerItem[] | null>(null);
  const [pickerError, setPickerError] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(true);

  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [sourceLabel, setSourceLabel] = useState<string>("");
  const [adjustments, setAdjustments] = useState<Adjustments>(DEFAULT_ADJUSTMENTS);
  const [cropPct, setCropPct] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [cropDraft, setCropDraft] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [cropMode, setCropMode] = useState(false);
  const [targetW, setTargetW] = useState<number>(0);
  const [targetH, setTargetH] = useState<number>(0);
  const [lockAspect, setLockAspect] = useState(true);
  const [textLayers, setTextLayers] = useState<TextLayer[]>([]);
  /** Pictures before each AI edit, newest last, so an edit can be undone. */
  const [history, setHistory] = useState<string[]>([]);
  const [newText, setNewText] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [savedPath, setSavedPath] = useState<string | null>(null);
  const [aiPrompt, setAiPrompt] = useState("");

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dragRef = useRef<{ startX: number; startY: number } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    getCapabilities({})
      .then((res) => {
        if (!cancelled) setCapabilities(res as { sogni: boolean; fal: boolean });
      })
      .catch(() => {
        if (!cancelled) setCapabilities({ sogni: false, fal: false });
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Opened from Create tab's "Edit" result action (DUR-4330): skip the picker
  // and load that exact file directly.
  useEffect(() => {
    if (!initialFileId) return;
    loadImage(`/api/attachments/${initialFileId}/content`, "From the Create tab");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialFileId]);

  useEffect(() => {
    if (!pickerOpen || !context.companyId || pickerItems !== null) return;
    let cancelled = false;
    hostFetchJson<{ artifacts: PickerItem[] }>(`/api/companies/${context.companyId}/artifacts?kind=image&limit=30`)
      .then((res) => {
        if (!cancelled) setPickerItems(res.artifacts);
      })
      .catch((err) => {
        if (!cancelled) setPickerError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [pickerOpen, context.companyId, pickerItems]);

  const loadImage = useCallback((src: string, label: string, options: { keepText?: boolean } = {}) => {
    setError(null);
    setSavedPath(null);
    const el = new Image();
    el.crossOrigin = "anonymous";
    el.onload = () => {
      setImg(el);
      setSourceLabel(label);
      setAdjustments(DEFAULT_ADJUSTMENTS);
      setCropPct(null);
      setCropDraft(null);
      setCropMode(false);
      // An AI edit or Undo replaces the picture but keeps the text on top of it
      // (still editable and removable); opening a different picture starts clean.
      if (!options.keepText) {
        setTextLayers([]);
        setHistory([]);
      }
      setTargetW(el.naturalWidth);
      setTargetH(el.naturalHeight);
      setPickerOpen(false);
    };
    el.onerror = () => setError("Could not load that picture. It may need you to be signed in, or the file is gone.");
    el.src = src;
  }, []);

  const handleUpload = useCallback(
    (file: File) => {
      const reader = new FileReader();
      reader.onload = () => loadImage(String(reader.result), file.name);
      reader.onerror = () => setError("Could not read that file.");
      reader.readAsDataURL(file);
    },
    [loadImage],
  );

  const previewCanvasSize = useMemo(() => {
    if (!img) return { width: 0, height: 0 };
    const rotated = rotatedBounds(img.naturalWidth, img.naturalHeight, adjustments.rotationDeg);
    const crop = cropPct ?? { x: 0, y: 0, w: 100, h: 100 };
    const croppedW = (crop.w / 100) * rotated.width;
    const croppedH = (crop.h / 100) * rotated.height;
    const maxDim = 640;
    const scale = Math.min(1, maxDim / Math.max(croppedW, croppedH, 1));
    return { width: Math.max(1, Math.round(croppedW * scale)), height: Math.max(1, Math.round(croppedH * scale)) };
  }, [img, adjustments.rotationDeg, cropPct]);

  // Redraw the preview whenever anything changes.
  useEffect(() => {
    if (!img || !canvasRef.current) return;
    const canvas = canvasRef.current;
    canvas.width = previewCanvasSize.width;
    canvas.height = previewCanvasSize.height;
    const composed = renderComposite({
      img,
      rotationDeg: adjustments.rotationDeg,
      cropPct,
      outW: previewCanvasSize.width,
      outH: previewCanvasSize.height,
      brightness: adjustments.brightness,
      contrast: adjustments.contrast,
      saturation: adjustments.saturation,
      textLayers,
    });
    const ctx = canvas.getContext("2d")!;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(composed, 0, 0);

    // Draw the crop-mode selection rectangle on top, in draft or committed form.
    const rectPct = cropMode ? cropDraft : null;
    if (rectPct) {
      ctx.save();
      ctx.strokeStyle = "#1971c2";
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 4]);
      ctx.strokeRect(
        (rectPct.x / 100) * canvas.width,
        (rectPct.y / 100) * canvas.height,
        (rectPct.w / 100) * canvas.width,
        (rectPct.h / 100) * canvas.height,
      );
      ctx.restore();
    }
  }, [img, previewCanvasSize, adjustments, cropPct, cropMode, cropDraft, textLayers]);

  const rotate = (deltaDeg: number) => {
    setAdjustments((prev) => ({ ...prev, rotationDeg: (((prev.rotationDeg + deltaDeg) % 360) + 360) % 360 }));
    setCropPct(null);
    setCropDraft(null);
  };

  const pctFromEvent = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * 100;
    const y = ((e.clientY - rect.top) / rect.height) * 100;
    return { x: Math.max(0, Math.min(100, x)), y: Math.max(0, Math.min(100, y)) };
  };

  const onCanvasMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!cropMode) return;
    const p = pctFromEvent(e);
    dragRef.current = { startX: p.x, startY: p.y };
    setCropDraft({ x: p.x, y: p.y, w: 0, h: 0 });
  };
  const onCanvasMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!cropMode || !dragRef.current) return;
    const p = pctFromEvent(e);
    const { startX, startY } = dragRef.current;
    setCropDraft({ x: Math.min(startX, p.x), y: Math.min(startY, p.y), w: Math.abs(p.x - startX), h: Math.abs(p.y - startY) });
  };
  const onCanvasMouseUp = () => {
    dragRef.current = null;
  };

  const applyCrop = () => {
    if (!cropDraft || cropDraft.w < 2 || cropDraft.h < 2) {
      setError("Drag a rectangle on the picture first.");
      return;
    }
    // cropDraft is relative to the currently-cropped preview; compose it with
    // any existing crop so cropping twice narrows further instead of resetting.
    const base = cropPct ?? { x: 0, y: 0, w: 100, h: 100 };
    setCropPct({
      x: base.x + (cropDraft.x / 100) * base.w,
      y: base.y + (cropDraft.y / 100) * base.h,
      w: (cropDraft.w / 100) * base.w,
      h: (cropDraft.h / 100) * base.h,
    });
    setCropDraft(null);
    setCropMode(false);
    if (img) {
      const rotated = rotatedBounds(img.naturalWidth, img.naturalHeight, adjustments.rotationDeg);
      setTargetW(Math.round((((cropDraft.w / 100) * base.w) / 100) * rotated.width));
      setTargetH(Math.round((((cropDraft.h / 100) * base.h) / 100) * rotated.height));
    }
  };

  const clearCrop = () => {
    setCropPct(null);
    setCropDraft(null);
    setCropMode(false);
    if (img) {
      const rotated = rotatedBounds(img.naturalWidth, img.naturalHeight, adjustments.rotationDeg);
      setTargetW(rotated.width);
      setTargetH(rotated.height);
    }
  };

  const onWidthChange = (w: number) => {
    if (lockAspect && img) {
      const rotated = rotatedBounds(img.naturalWidth, img.naturalHeight, adjustments.rotationDeg);
      const crop = cropPct ?? { x: 0, y: 0, w: 100, h: 100 };
      const aspect = ((crop.h / 100) * rotated.height) / Math.max(1, (crop.w / 100) * rotated.width);
      setTargetW(w);
      setTargetH(Math.round(w * aspect));
    } else {
      setTargetW(w);
    }
  };
  const onHeightChange = (h: number) => {
    if (lockAspect && img) {
      const rotated = rotatedBounds(img.naturalWidth, img.naturalHeight, adjustments.rotationDeg);
      const crop = cropPct ?? { x: 0, y: 0, w: 100, h: 100 };
      const aspect = ((crop.w / 100) * rotated.width) / Math.max(1, (crop.h / 100) * rotated.height);
      setTargetH(h);
      setTargetW(Math.round(h * aspect));
    } else {
      setTargetH(h);
    }
  };

  const addTextLayer = () => {
    if (!newText.trim()) return;
    setTextLayers((prev) => [...prev, { id: `t${Date.now()}`, text: newText.trim(), xPct: 10, yPct: 10, fontSize: 8, color: "#ffffff" }]);
    setNewText("");
  };
  const updateTextLayer = (id: string, patch: Partial<TextLayer>) => {
    setTextLayers((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  };
  const removeTextLayer = (id: string) => {
    setTextLayers((prev) => prev.filter((t) => t.id !== id));
  };

  const fullResCanvas = useCallback(() => {
    if (!img) return null;
    return renderComposite({
      img,
      rotationDeg: adjustments.rotationDeg,
      cropPct,
      outW: targetW || img.naturalWidth,
      outH: targetH || img.naturalHeight,
      brightness: adjustments.brightness,
      contrast: adjustments.contrast,
      saturation: adjustments.saturation,
      textLayers,
    });
  }, [img, adjustments, cropPct, targetW, targetH, textLayers]);

  const saveAsNewFile = async () => {
    if (!context.companyId) {
      setError("Open Media Studio from inside a company first.");
      return;
    }
    const canvas = fullResCanvas();
    if (!canvas) return;
    setBusy("save");
    setError(null);
    setSavedPath(null);
    try {
      const blob: Blob = await new Promise((resolve, reject) =>
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Could not turn the picture into a file."))), "image/png"),
      );
      const form = new FormData();
      const name = sourceLabel ? `edited-${sourceLabel.replace(/\.[^.]+$/, "")}.png` : "edited-picture.png";
      form.append("file", blob, name);
      const res = await fetch(`/api/companies/${context.companyId}/files`, { method: "POST", credentials: "include", body: form });
      if (!res.ok) throw new Error((await res.text()) || `Save failed: ${res.status}`);
      const created = (await res.json()) as { openPath?: string };
      setSavedPath(created.openPath ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  /**
   * The picture an AI edit works on: crop, rotation and colour adjustments
   * applied, but WITHOUT the text layers, so text stays a separate layer the
   * person can still change or remove after the edit.
   */
  const currentImageDataUrl = useCallback((): string | null => {
    if (!img) return null;
    const canvas = renderComposite({
      img,
      rotationDeg: adjustments.rotationDeg,
      cropPct,
      outW: targetW || img.naturalWidth,
      outH: targetH || img.naturalHeight,
      brightness: adjustments.brightness,
      contrast: adjustments.contrast,
      saturation: adjustments.saturation,
      textLayers: [],
    });
    return canvas.toDataURL("image/png");
  }, [img, adjustments, cropPct, targetW, targetH]);

  const applyAiResult = (resultDataUrl: string, before: string) => {
    setHistory((prev) => [...prev.slice(-9), before]);
    loadImage(resultDataUrl, sourceLabel, { keepText: true });
  };

  const undoLastEdit = () => {
    const previous = history[history.length - 1];
    if (!previous) return;
    setHistory((prev) => prev.slice(0, -1));
    loadImage(previous, sourceLabel, { keepText: true });
  };

  const runSogniEdit = async (tool: string, extra: Record<string, unknown>, busyKey: string) => {
    const imageDataUrl = currentImageDataUrl();
    if (!imageDataUrl) return;
    setBusy(busyKey);
    setError(null);
    setSavedPath(null);
    try {
      const result = (await editSogni({ tool, imageDataUrl, ...extra })) as { imageDataUrl: string };
      applyAiResult(result.imageDataUrl, imageDataUrl);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const runFalEdit = async (prompt: string, busyKey: string) => {
    const imageDataUrl = currentImageDataUrl();
    if (!imageDataUrl) return;
    setBusy(busyKey);
    setError(null);
    setSavedPath(null);
    try {
      const result = (await editFal({ imageDataUrl, prompt })) as { imageDataUrl: string };
      applyAiResult(result.imageDataUrl, imageDataUrl);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      {error ? <div style={errorBox}>{error}</div> : null}
      {savedPath ? (
        <div style={okBox}>
          Saved as a new file (the original is unchanged).{" "}
          <a href={savedPath} target="_blank" rel="noreferrer" style={{ color: "#087f5b", fontWeight: 700 }}>
            Open it
          </a>
          .
        </div>
      ) : null}

      {!img || pickerOpen ? (
        <div style={card}>
          <p style={sectionTitle}>Open a picture</p>
          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <button type="button" style={secondaryBtn} onClick={() => fileInputRef.current?.click()}>
              Upload from your computer
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              style={{ display: "none" }}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) handleUpload(file);
                e.target.value = "";
              }}
            />
            {img ? (
              <button type="button" style={ghostBtn} onClick={() => setPickerOpen(false)}>
                Cancel
              </button>
            ) : null}
          </div>
          <p style={{ fontSize: 12, color: "#868e96", margin: 0 }}>Or pick a recent picture from Media Studio / Files:</p>
          {pickerError ? <div style={errorBox}>{pickerError}</div> : null}
          {pickerItems === null && !pickerError ? <p style={{ fontSize: 13, margin: 0 }}>Loading…</p> : null}
          {pickerItems && pickerItems.length === 0 ? <p style={{ fontSize: 13, margin: 0, color: "#868e96" }}>No pictures yet.</p> : null}
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {(pickerItems ?? []).map((item) =>
              item.openPath ? (
                <img
                  key={item.id}
                  src={item.openPath}
                  alt={item.title}
                  title={item.title}
                  style={thumb}
                  onClick={() => loadImage(item.openPath as string, item.originalFilename ?? item.title)}
                />
              ) : null,
            )}
          </div>
        </div>
      ) : null}

      {img && !pickerOpen ? (
        <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <canvas
              ref={canvasRef}
              style={{ border: "1px solid rgba(128,128,128,0.35)", borderRadius: 8, cursor: cropMode ? "crosshair" : "default", maxWidth: "100%" }}
              onMouseDown={onCanvasMouseDown}
              onMouseMove={onCanvasMouseMove}
              onMouseUp={onCanvasMouseUp}
              onMouseLeave={onCanvasMouseUp}
            />
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button type="button" style={ghostBtn} onClick={() => setPickerOpen(true)}>
                Open a different picture
              </button>
              <button type="button" style={busy ? disabledBtn : primaryBtn} disabled={!!busy} onClick={saveAsNewFile}>
                {busy === "save" ? "Saving…" : "Save as new version"}
              </button>
            </div>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 14, minWidth: 280, flex: 1 }}>
            <div style={card}>
              <p style={sectionTitle}>Rotate & crop</p>
              <div style={{ display: "flex", gap: 8 }}>
                <button type="button" style={ghostBtn} onClick={() => rotate(-90)}>
                  ⟲ Rotate left
                </button>
                <button type="button" style={ghostBtn} onClick={() => rotate(90)}>
                  ⟳ Rotate right
                </button>
              </div>
              <div style={field}>
                <label style={{ fontSize: 12 }}>Fine rotation ({adjustments.rotationDeg}°)</label>
                <input
                  type="range"
                  min={0}
                  max={359}
                  value={adjustments.rotationDeg}
                  onChange={(e) => {
                    setAdjustments((prev) => ({ ...prev, rotationDeg: Number(e.target.value) }));
                    setCropPct(null);
                    setCropDraft(null);
                  }}
                />
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                {!cropMode ? (
                  <button type="button" style={secondaryBtn} onClick={() => setCropMode(true)}>
                    Crop…
                  </button>
                ) : (
                  <>
                    <button type="button" style={primaryBtn} onClick={applyCrop}>
                      Apply crop
                    </button>
                    <button type="button" style={ghostBtn} onClick={() => (setCropMode(false), setCropDraft(null))}>
                      Cancel
                    </button>
                  </>
                )}
                {cropPct ? (
                  <button type="button" style={ghostBtn} onClick={clearCrop}>
                    Clear crop
                  </button>
                ) : null}
              </div>
              {cropMode ? <p style={{ fontSize: 12, color: "#868e96", margin: 0 }}>Drag on the picture to select the area to keep.</p> : null}
            </div>

            <div style={card}>
              <p style={sectionTitle}>Resize</p>
              <div style={{ display: "flex", gap: 8 }}>
                <div style={field}>
                  <label style={{ fontSize: 12 }}>Width</label>
                  <input style={input} type="number" min={1} value={targetW} onChange={(e) => onWidthChange(Number(e.target.value) || 1)} />
                </div>
                <div style={field}>
                  <label style={{ fontSize: 12 }}>Height</label>
                  <input style={input} type="number" min={1} value={targetH} onChange={(e) => onHeightChange(Number(e.target.value) || 1)} />
                </div>
              </div>
              <label style={{ fontSize: 12, display: "flex", gap: 6, alignItems: "center" }}>
                <input type="checkbox" checked={lockAspect} onChange={(e) => setLockAspect(e.target.checked)} />
                Keep aspect ratio
              </label>
            </div>

            <div style={card}>
              <p style={sectionTitle}>Brightness, contrast, saturation</p>
              {(["brightness", "contrast", "saturation"] as const).map((key) => (
                <div style={field} key={key}>
                  <label style={{ fontSize: 12, textTransform: "capitalize" }}>
                    {key} ({adjustments[key]}%)
                  </label>
                  <input
                    type="range"
                    min={0}
                    max={200}
                    value={adjustments[key]}
                    onChange={(e) => setAdjustments((prev) => ({ ...prev, [key]: Number(e.target.value) }))}
                  />
                </div>
              ))}
            </div>

            <div style={card}>
              <p style={sectionTitle}>Text</p>
              <div style={{ display: "flex", gap: 8 }}>
                <input style={{ ...input, flex: 1 }} placeholder="Add text…" value={newText} onChange={(e) => setNewText(e.target.value)} />
                <button type="button" style={secondaryBtn} onClick={addTextLayer}>
                  Add
                </button>
              </div>
              {textLayers.map((layer) => (
                <div key={layer.id} style={{ ...card, padding: 8 }}>
                  <input style={input} value={layer.text} onChange={(e) => updateTextLayer(layer.id, { text: e.target.value })} />
                  <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    <label style={{ fontSize: 11 }}>X</label>
                    <input type="range" min={0} max={95} value={layer.xPct} onChange={(e) => updateTextLayer(layer.id, { xPct: Number(e.target.value) })} />
                    <label style={{ fontSize: 11 }}>Y</label>
                    <input type="range" min={0} max={95} value={layer.yPct} onChange={(e) => updateTextLayer(layer.id, { yPct: Number(e.target.value) })} />
                  </div>
                  <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    <label style={{ fontSize: 11 }}>Size</label>
                    <input type="range" min={2} max={20} value={layer.fontSize} onChange={(e) => updateTextLayer(layer.id, { fontSize: Number(e.target.value) })} />
                    <input type="color" value={layer.color} onChange={(e) => updateTextLayer(layer.id, { color: e.target.value })} />
                    <button type="button" style={ghostBtn} onClick={() => removeTextLayer(layer.id)}>
                      Remove
                    </button>
                  </div>
                </div>
              ))}
            </div>

            <div style={card}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                <p style={sectionTitle}>AI edits</p>
                {history.length > 0 ? (
                  <button type="button" style={busy ? disabledBtn : ghostBtn} disabled={!!busy} onClick={undoLastEdit}>
                    Undo last AI edit
                  </button>
                ) : null}
              </div>
              {capabilities && !capabilities.sogni && !capabilities.fal ? (
                <p style={{ fontSize: 12, color: "#868e96", margin: 0 }}>
                  Ask an admin to add a Sogni or Fal.ai API key in Media Studio settings to use AI edits.
                </p>
              ) : null}
              {capabilities?.sogni ? (
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <button type="button" style={busy ? disabledBtn : secondaryBtn} disabled={!!busy} onClick={() => runSogniEdit("sogni-remove-background", {}, "bg")}>
                    {busy === "bg" ? "Working…" : "Remove background"}
                  </button>
                  <button type="button" style={busy ? disabledBtn : secondaryBtn} disabled={!!busy} onClick={() => runSogniEdit("sogni-upscale-image", { scale: 2 }, "upscale")}>
                    {busy === "upscale" ? "Working…" : "Upscale"}
                  </button>
                </div>
              ) : null}
              {capabilities?.sogni || capabilities?.fal ? (
                <div style={field}>
                  <label style={{ fontSize: 12 }}>Describe a change (for "Restore / clean up" and "Edit with a prompt")</label>
                  <textarea style={{ ...input, minHeight: 50 }} value={aiPrompt} onChange={(e) => setAiPrompt(e.target.value)} placeholder="e.g. replace the sky with a sunset" />
                </div>
              ) : null}
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {capabilities?.sogni ? (
                  <button
                    type="button"
                    style={busy || !aiPrompt.trim() ? disabledBtn : secondaryBtn}
                    disabled={!!busy || !aiPrompt.trim()}
                    onClick={() => runSogniEdit("sogni-restore-photo", { prompt: aiPrompt.trim() }, "inpaint")}
                  >
                    {busy === "inpaint" ? "Working…" : "Restore / clean up (whole picture)"}
                  </button>
                ) : null}
                {capabilities?.fal ? (
                  <>
                    <button type="button" style={busy ? disabledBtn : secondaryBtn} disabled={!!busy} onClick={() => runFalEdit(MAKE_VARIATION_PROMPT, "variation")}>
                      {busy === "variation" ? "Working…" : "Make variations"}
                    </button>
                    <button
                      type="button"
                      style={busy || !aiPrompt.trim() ? disabledBtn : secondaryBtn}
                      disabled={!!busy || !aiPrompt.trim()}
                      onClick={() => runFalEdit(aiPrompt.trim(), "prompt-edit")}
                    >
                      {busy === "prompt-edit" ? "Working…" : "Edit with a prompt"}
                    </button>
                  </>
                ) : null}
              </div>
              <p style={{ fontSize: 11, color: "#868e96", margin: 0 }}>
                An AI edit replaces the picture on this screen with its result; use "Save as new version" when you are happy with it.
              </p>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
