import { useCallback, useEffect, useRef, useState } from "react";
import type { PluginHostContext } from "@paperclipai/plugin-sdk/ui";
import { usePluginAction } from "@paperclipai/plugin-sdk/ui";
import {
  ACTION_EDIT_SEGMENT,
  ACTION_EDIT_SOGNI,
  ACTION_ROOMS_DELETE,
  ACTION_ROOMS_LIST,
  ACTION_ROOMS_PLACE,
  ACTION_ROOMS_SAVE,
  fileContentPath,
  listCompanyPictures,
  pictureDataUrl,
  uploadPicture,
} from "./anchor-helpers.js";

// Rooms: a photo of a real room, named areas in it (zones) and product
// pictures. "Place product" puts products into one zone and keeps the rest of
// the room exactly as in the photo (src/rooms.ts, src/mask-composite.ts).

export type RoomZone = { id: string; name: string; maskFileId: string };
export type RoomProduct = { id: string; name: string; fileId: string; cutoutFileId: string | null };
export type Room = { id: string; name: string; photoFileId: string; cameraNote: string | null; zones: RoomZone[]; products: RoomProduct[]; updatedAt: string };
type Draft = { id: string | null; name: string; photoFileId: string | null; cameraNote: string; zones: Array<Omit<RoomZone, "id"> & { id?: string }>; products: Array<Omit<RoomProduct, "id"> & { id?: string }> };

const card: React.CSSProperties = { border: "1px solid rgba(128,128,128,0.35)", borderRadius: 10, padding: 12, display: "flex", flexDirection: "column", gap: 8 };
const field: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 4, fontSize: 13 };
const input: React.CSSProperties = { padding: 8, borderRadius: 8, border: "1px solid rgba(128,128,128,0.5)", fontFamily: "inherit", fontSize: 13, background: "transparent", color: "inherit" };
const help: React.CSSProperties = { fontSize: 12, opacity: 0.75 };
const errorBox: React.CSSProperties = { background: "#fff0f6", color: "#a61e4d", padding: "8px 10px", borderRadius: 8, fontSize: 13 };
const okBox: React.CSSProperties = { background: "#e6fcf5", color: "#087f5b", padding: "8px 10px", borderRadius: 8, fontSize: 13 };
const baseBtn: React.CSSProperties = { padding: "6px 12px", borderRadius: 8, border: "1px solid transparent", cursor: "pointer", fontSize: 12, fontWeight: 600 };
const primaryBtn: React.CSSProperties = { ...baseBtn, background: "#1971c2", color: "#fff" };
const secondaryBtn: React.CSSProperties = { ...baseBtn, background: "#e7f5ff", color: "#1971c2", borderColor: "#a5d8ff" };
const dangerBtn: React.CSSProperties = { ...baseBtn, background: "#f03e3e", color: "#fff" };
const ghostBtn: React.CSSProperties = { ...baseBtn, background: "transparent", color: "inherit", borderColor: "#ced4da" };
const thumb: React.CSSProperties = { width: 96, height: 96, objectFit: "cover", borderRadius: 6, display: "block", border: "1px solid rgba(128,128,128,0.35)" };
const row: React.CSSProperties = { display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" };

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function roomToDraft(room: Room | null): Draft {
  return room
    ? { id: room.id, name: room.name, photoFileId: room.photoFileId, cameraNote: room.cameraNote ?? "", zones: room.zones.map((z) => ({ ...z })), products: room.products.map((p) => ({ ...p })) }
    : { id: null, name: "", photoFileId: null, cameraNote: "", zones: [], products: [] };
}

/** Paint an area on the room photo; returns a black-and-white mask the size of the photo. */
function BrushMask({ src, onDone, onCancel }: { src: string; onDone: (blob: Blob) => void; onCancel: () => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const [brush, setBrush] = useState(40);
  const painting = useRef(false);
  useEffect(() => {
    const img = new Image();
    img.onload = () => setSize({ w: img.naturalWidth, h: img.naturalHeight });
    img.src = src;
  }, [src]);
  useEffect(() => {
    const c = canvas.current;
    if (!c || !size) return;
    const g = c.getContext("2d");
    if (!g) return;
    g.fillStyle = "#000";
    g.fillRect(0, 0, size.w, size.h);
  }, [size]);
  const paint = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const c = canvas.current;
    if (!c || !painting.current || !size) return;
    const rect = c.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * size.w;
    const y = ((e.clientY - rect.top) / rect.height) * size.h;
    const g = c.getContext("2d");
    if (!g) return;
    g.fillStyle = "#fff";
    g.beginPath();
    g.arc(x, y, (brush / rect.width) * size.w, 0, Math.PI * 2);
    g.fill();
  };
  if (!size) return <div style={help}>Loading the photo…</div>;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={help}>Paint over the area where products may go. White is the area.</div>
      <div style={{ position: "relative", display: "inline-block", maxWidth: "100%" }}>
        <img src={src} alt="Room" style={{ display: "block", maxWidth: "100%", maxHeight: 480 }} />
        <canvas
          ref={canvas}
          width={size.w}
          height={size.h}
          style={{ position: "absolute", inset: 0, width: "100%", height: "100%", opacity: 0.45, cursor: "crosshair", touchAction: "none" }}
          onPointerDown={(e) => { painting.current = true; paint(e); }}
          onPointerMove={paint}
          onPointerUp={() => { painting.current = false; }}
          onPointerLeave={() => { painting.current = false; }}
          aria-label="Paint the area"
        />
      </div>
      <div style={row}>
        <label style={{ ...row, fontSize: 12 }}>
          Brush size <input type="range" min={8} max={120} value={brush} onChange={(e) => setBrush(Number(e.target.value))} />
        </label>
        <button type="button" style={primaryBtn} onClick={() => canvas.current?.toBlob((b) => b && onDone(b), "image/png")}>Use this area</button>
        <button type="button" style={ghostBtn} onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

function PictureButton({ companyId, label, onPick, disabled }: { companyId: string; label: string; onPick: (fileId: string) => void; disabled?: boolean }) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [pictures, setPictures] = useState<Array<{ fileId: string; title: string }> | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open && !pictures) listCompanyPictures(companyId).then(setPictures).catch((e) => setError(errText(e)));
  }, [open, pictures, companyId]);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={row}>
        <button type="button" style={secondaryBtn} disabled={disabled} onClick={() => fileInput.current?.click()}>{label}</button>
        <button type="button" style={ghostBtn} disabled={disabled} onClick={() => setOpen((o) => !o)}>{open ? "Hide Files" : "Pick from Files"}</button>
        <input
          ref={fileInput}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          style={{ display: "none" }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) uploadPicture(companyId, f, f.name).then(onPick).catch((err) => setError(errText(err)));
          }}
        />
      </div>
      {error ? <div style={errorBox}>{error}</div> : null}
      {open ? (
        <div style={{ ...row, maxHeight: 200, overflowY: "auto" }}>
          {(pictures ?? []).map((p) => (
            <button key={p.fileId} type="button" style={{ padding: 0, border: "none", background: "none", cursor: "pointer" }} onClick={() => { onPick(p.fileId); setOpen(false); }}>
              <img src={fileContentPath(p.fileId)} alt={p.title} style={{ ...thumb, width: 64, height: 64 }} />
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function RoomsPanel({ context }: { context: PluginHostContext }) {
  const companyId = context.companyId;
  const list = usePluginAction(ACTION_ROOMS_LIST);
  const save = usePluginAction(ACTION_ROOMS_SAVE);
  const remove = usePluginAction(ACTION_ROOMS_DELETE);
  const place = usePluginAction(ACTION_ROOMS_PLACE);
  const segment = usePluginAction(ACTION_EDIT_SEGMENT);
  const sogniTool = usePluginAction(ACTION_EDIT_SOGNI);
  const [rooms, setRooms] = useState<Room[] | null>(null);
  const [canManage, setCanManage] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [open, setOpen] = useState<Room | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [zoneName, setZoneName] = useState("");
  const [zoneText, setZoneText] = useState("");
  const [painting, setPainting] = useState(false);
  const [placeZone, setPlaceZone] = useState("");
  const [placeProducts, setPlaceProducts] = useState<string[]>([]);
  const [service, setService] = useState<"sogni" | "fal">("sogni");
  const [extra, setExtra] = useState("");
  const [result, setResult] = useState<{ imageDataUrl: string; provider: string } | null>(null);
  const [savedResult, setSavedResult] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = (await list({})) as { rooms: Room[]; canManage: boolean };
      setRooms(res.rooms);
      setCanManage(res.canManage);
    } catch (e) {
      setError(errText(e));
    }
  }, [list]);
  useEffect(() => {
    void load();
  }, [load]);

  if (!companyId) return <div style={errorBox}>Open Media Studio from inside a company.</div>;
  if (!rooms) return error ? <div style={errorBox}>{error}</div> : <div style={help}>Loading…</div>;

  const step = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(null);
    }
  };

  if (draft) {
    const addZone = (maskFileId: string) => {
      setDraft((d) => (d ? { ...d, zones: [...d.zones, { name: zoneName.trim() || `Area ${d.zones.length + 1}`, maskFileId }] } : d));
      setZoneName("");
      setZoneText("");
    };
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }} aria-label="Room editor">
        <div style={row}>
          <strong style={{ fontSize: 15 }}>{draft.id ? `Edit ${draft.name}` : "New room"}</strong>
          <button type="button" style={ghostBtn} onClick={() => setDraft(null)}>Cancel</button>
        </div>
        <div style={card}>
          <label style={field}>
            <span>Name</span>
            <input style={input} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          </label>
          <strong>Room photo</strong>
          <PictureButton companyId={companyId} label="Upload the room photo" disabled={busy !== null} onPick={(fileId) => setDraft({ ...draft, photoFileId: fileId, zones: [] })} />
          {draft.photoFileId ? <img src={fileContentPath(draft.photoFileId)} alt="Room" style={{ maxWidth: 360, borderRadius: 6 }} /> : null}
          <label style={field}>
            <span>Camera and lighting (optional)</span>
            <input style={input} placeholder="eye level from the doorway, soft daylight from the left window" value={draft.cameraNote} onChange={(e) => setDraft({ ...draft, cameraNote: e.target.value })} />
            <span style={help}>Told to the picture service so placed products match the room.</span>
          </label>
        </div>

        {draft.photoFileId ? (
          <div style={card}>
            <strong>Areas (zones)</strong>
            <div style={help}>Named areas where products may go. Placing a product only changes that area; the rest of the photo stays exactly as it is.</div>
            <div style={row}>
              {draft.zones.map((z, i) => (
                <span key={`${z.maskFileId}-${i}`} style={{ textAlign: "center", fontSize: 12 }}>
                  <img src={fileContentPath(z.maskFileId)} alt={z.name} style={{ ...thumb, width: 72, height: 72 }} />
                  {z.name}{" "}
                  <button type="button" style={ghostBtn} onClick={() => setDraft({ ...draft, zones: draft.zones.filter((_, j) => j !== i) })}>Remove</button>
                </span>
              ))}
            </div>
            <label style={field}>
              <span>New area's name</span>
              <input style={input} placeholder="Left wall, under the window" value={zoneName} onChange={(e) => setZoneName(e.target.value)} />
            </label>
            {painting ? (
              <BrushMask
                src={fileContentPath(draft.photoFileId)}
                onCancel={() => setPainting(false)}
                onDone={(blob) =>
                  void step("paint", async () => {
                    addZone(await uploadPicture(companyId, blob, `${(zoneName || "area").replace(/[^A-Za-z0-9-]+/g, "-")}-mask.png`));
                    setPainting(false);
                  })
                }
              />
            ) : (
              <div style={row}>
                <input style={{ ...input, minWidth: 220 }} placeholder="What to select, e.g. the empty floor by the window" value={zoneText} onChange={(e) => setZoneText(e.target.value)} />
                <button
                  type="button"
                  style={secondaryBtn}
                  disabled={busy !== null || !zoneText.trim()}
                  onClick={() =>
                    void step("select", async () => {
                      const imageDataUrl = await pictureDataUrl(draft.photoFileId!);
                      const res = (await segment({ imageDataUrl, text: zoneText.trim() })) as { imageDataUrl: string };
                      addZone(await uploadPicture(companyId, res.imageDataUrl, `${(zoneName || "area").replace(/[^A-Za-z0-9-]+/g, "-")}-mask.png`));
                    })
                  }
                >
                  {busy === "select" ? "Selecting…" : "Select with Sogni"}
                </button>
                <button type="button" style={ghostBtn} disabled={busy !== null} onClick={() => setPainting(true)}>Paint it instead</button>
              </div>
            )}
          </div>
        ) : null}

        <div style={card}>
          <strong>Products</strong>
          <div style={help}>Pictures of products to place in the room. Removing the background first gives cleaner results.</div>
          {draft.products.map((p, i) => (
            <div key={`${p.fileId}-${i}`} style={row}>
              <img src={fileContentPath(p.cutoutFileId ?? p.fileId)} alt={p.name} style={{ ...thumb, width: 64, height: 64 }} />
              <input style={input} value={p.name} onChange={(e) => setDraft({ ...draft, products: draft.products.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })} aria-label="Product name" />
              <button
                type="button"
                style={secondaryBtn}
                disabled={busy !== null}
                title="A paid Sogni call"
                onClick={() =>
                  void step(`bg-${i}`, async () => {
                    const imageDataUrl = await pictureDataUrl(p.fileId);
                    const res = (await sogniTool({ tool: "sogni-remove-background", imageDataUrl })) as { imageDataUrl: string };
                    const cutoutFileId = await uploadPicture(companyId, res.imageDataUrl, `${p.name.replace(/[^A-Za-z0-9-]+/g, "-") || "product"}-cutout.png`);
                    setDraft((d) => (d ? { ...d, products: d.products.map((x, j) => (j === i ? { ...x, cutoutFileId } : x)) } : d));
                  })
                }
              >
                {busy === `bg-${i}` ? "Removing…" : p.cutoutFileId ? "Background removed" : "Remove background"}
              </button>
              <button type="button" style={ghostBtn} onClick={() => setDraft({ ...draft, products: draft.products.filter((_, j) => j !== i) })}>Remove</button>
            </div>
          ))}
          <PictureButton
            companyId={companyId}
            label="Add a product picture"
            disabled={busy !== null}
            onPick={(fileId) => setDraft((d) => (d ? { ...d, products: [...d.products, { name: `Product ${d.products.length + 1}`, fileId, cutoutFileId: null }] } : d))}
          />
        </div>
        {error ? <div style={errorBox}>{error}</div> : null}
        <div>
          <button
            type="button"
            style={primaryBtn}
            disabled={busy !== null || !draft.name.trim() || !draft.photoFileId}
            onClick={() =>
              void step("save", async () => {
                const res = (await save({ id: draft.id, name: draft.name, photoFileId: draft.photoFileId, cameraNote: draft.cameraNote || null, zones: draft.zones, products: draft.products })) as { room: Room; rooms: Room[] };
                setRooms(res.rooms);
                setDraft(null);
                setOpen(res.room);
              })
            }
          >
            {busy === "save" ? "Saving…" : "Save room"}
          </button>
        </div>
      </div>
    );
  }

  if (open) {
    const ready = placeZone && placeProducts.length > 0;
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }} aria-label="Room details">
        <div style={row}>
          <button type="button" style={ghostBtn} onClick={() => { setOpen(null); setResult(null); }}>All rooms</button>
          <strong style={{ fontSize: 15 }}>{open.name}</strong>
          {canManage ? (
            <>
              <button type="button" style={secondaryBtn} onClick={() => setDraft(roomToDraft(open))}>Edit</button>
              <button
                type="button"
                style={dangerBtn}
                disabled={busy !== null}
                onClick={() =>
                  void step("delete", async () => {
                    if (typeof window !== "undefined" && !window.confirm(`Delete the room "${open.name}"?`)) return;
                    const res = (await remove({ id: open.id })) as { rooms: Room[] };
                    setRooms(res.rooms);
                    setOpen(null);
                  })
                }
              >
                Delete
              </button>
            </>
          ) : null}
        </div>
        <img src={fileContentPath(open.photoFileId)} alt={open.name} style={{ maxWidth: 480, borderRadius: 6 }} />
        <div style={card} aria-label="Place product">
          <strong>Place products</strong>
          <div style={help}>
            The room photo is sent as picture 1 and the products as pictures 2 and on. The new picture is then put back only inside the chosen area,
            so every other part of the room stays exactly as in the photo.
          </div>
          <label style={field}>
            <span>Area</span>
            <select style={input} value={placeZone} onChange={(e) => setPlaceZone(e.target.value)}>
              <option value="">Pick an area…</option>
              {open.zones.map((z) => (
                <option key={z.id} value={z.id}>{z.name}</option>
              ))}
            </select>
          </label>
          <div style={row}>
            {open.products.map((p) => (
              <label key={p.id} style={{ ...row, fontSize: 13 }}>
                <input
                  type="checkbox"
                  checked={placeProducts.includes(p.id)}
                  onChange={(e) => setPlaceProducts((list) => (e.target.checked ? [...list, p.id] : list.filter((x) => x !== p.id)))}
                />
                <img src={fileContentPath(p.cutoutFileId ?? p.fileId)} alt={p.name} style={{ ...thumb, width: 48, height: 48 }} />
                {p.name}
              </label>
            ))}
          </div>
          <label style={field}>
            <span>Picture service</span>
            <select style={input} value={service} onChange={(e) => setService(e.target.value === "fal" ? "fal" : "sogni")}>
              <option value="sogni">Sogni (Qwen Image Edit, up to 2 products)</option>
              <option value="fal">Fal.ai (FLUX Kontext, up to 3 products)</option>
            </select>
          </label>
          <label style={field}>
            <span>Anything else (optional)</span>
            <input style={input} placeholder="facing the window, slightly angled" value={extra} onChange={(e) => setExtra(e.target.value)} />
          </label>
          {error ? <div style={errorBox}>{error}</div> : null}
          <div style={row}>
            <button
              type="button"
              style={primaryBtn}
              disabled={busy !== null || !ready}
              onClick={() =>
                void step("place", async () => {
                  setSavedResult(null);
                  const res = (await place({ roomId: open.id, zoneId: placeZone, productIds: placeProducts, service, prompt: extra || null })) as { imageDataUrl: string; provider: string };
                  setResult(res);
                })
              }
            >
              {busy === "place" ? "Placing…" : "Place product"}
            </button>
            <span style={help}>A paid call; counts toward Media Studio's spending limit.</span>
          </div>
          {result ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <img src={result.imageDataUrl} alt="Room with product" style={{ maxWidth: 480, borderRadius: 6 }} />
              <div style={row}>
                <button
                  type="button"
                  style={secondaryBtn}
                  disabled={busy !== null}
                  onClick={() =>
                    void step("keep", async () => {
                      await uploadPicture(companyId, result.imageDataUrl, `${open.name.replace(/[^A-Za-z0-9-]+/g, "-")}-placed.png`);
                      setSavedResult("Saved to Files.");
                    })
                  }
                >
                  Save to Files
                </button>
                {savedResult ? <span style={okBox}>{savedResult}</span> : null}
              </div>
            </div>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }} aria-label="Rooms">
      <div style={help}>
        A room is a photo of a real room with named areas, plus product pictures. Place products into an area and the rest of the photo stays
        exactly the same.
      </div>
      {canManage ? (
        <div>
          <button type="button" style={primaryBtn} onClick={() => setDraft(roomToDraft(null))}>New room</button>
        </div>
      ) : (
        <span style={help}>Only an owner or admin can add or change rooms. Anyone in the company can place products.</span>
      )}
      {error ? <div style={errorBox}>{error}</div> : null}
      {rooms.length === 0 ? <div style={help}>No rooms yet.</div> : null}
      <div style={row}>
        {rooms.map((room) => (
          <button key={room.id} type="button" style={{ ...card, cursor: "pointer", background: "none", color: "inherit", alignItems: "center", width: 160 }} onClick={() => setOpen(room)}>
            <img src={fileContentPath(room.photoFileId)} alt={room.name} style={{ ...thumb, width: 136 }} />
            <span style={{ fontSize: 13, fontWeight: 600 }}>{room.name}</span>
            <span style={help}>{room.zones.length} areas · {room.products.length} products</span>
          </button>
        ))}
      </div>
    </div>
  );
}
