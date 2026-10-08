// Room anchors: one photo of a real room, named areas in it (zones, each a
// black-and-white mask), and product pictures. "Place product" sends the
// room as picture 1 and the product(s) as pictures 2.., then puts the
// service's picture back through the zone's mask (mask-composite.ts), so
// every pixel outside the zone is exactly the room photo's.

export const ROOM_NAME_MAX = 60;
export const ROOM_NOTE_MAX = 300;
export const MAX_ROOMS = 50;
export const MAX_ZONES = 12;
export const MAX_PRODUCTS = 24;
/** Sogni's qwen editor takes 3 pictures (room + 2 products); Fal's Kontext multi 4 (room + 3). */
export const ROOM_SOGNI_MODEL = "qwen";

export interface RoomZone {
  id: string;
  name: string;
  /** Black-and-white mask, same shape as the room photo: white = the zone. */
  maskFileId: string;
}

export interface RoomProduct {
  id: string;
  name: string;
  fileId: string;
  /** The same product with its background removed (sent instead of fileId when set). */
  cutoutFileId: string | null;
}

export interface Room {
  id: string;
  name: string;
  photoFileId: string;
  /** Camera and lighting, in words ("eye level from the doorway, soft daylight from the left window"). */
  cameraNote: string | null;
  zones: RoomZone[];
  products: RoomProduct[];
  updatedAt: string;
}

function shortText(value: unknown, max: number, label: string, required = false): string | null {
  const t = typeof value === "string" ? value.trim() : "";
  if (!t) {
    if (required) throw new Error(`Give the ${label} a name.`);
    return null;
  }
  if (t.length > max) throw new Error(`Keep the ${label} under ${max} characters.`);
  return t;
}

function fileIdOf(value: unknown, what: string): string {
  const id = typeof value === "string" ? value.trim() : "";
  if (!id) throw new Error(`Pick ${what} first.`);
  return id;
}

export function readRoomInput(params: Record<string, unknown>, existing: Room | null, newId: () => string): Omit<Room, "id" | "updatedAt"> {
  const name = shortText(params.name, ROOM_NAME_MAX, "room", true)!;
  const photoFileId = fileIdOf(params.photoFileId, "the room photo");
  const cameraNote = shortText(params.cameraNote, ROOM_NOTE_MAX, "camera and lighting note");
  const zonesRaw = Array.isArray(params.zones) ? params.zones : [];
  if (zonesRaw.length > MAX_ZONES) throw new Error(`Keep at most ${MAX_ZONES} zones in one room.`);
  const zones: RoomZone[] = zonesRaw.map((z) => {
    const row = (z ?? {}) as Record<string, unknown>;
    const id = typeof row.id === "string" && existing?.zones.some((e) => e.id === row.id) ? row.id : newId();
    return { id, name: shortText(row.name, ROOM_NAME_MAX, "zone", true)!, maskFileId: fileIdOf(row.maskFileId, "the zone's area") };
  });
  const productsRaw = Array.isArray(params.products) ? params.products : [];
  if (productsRaw.length > MAX_PRODUCTS) throw new Error(`Keep at most ${MAX_PRODUCTS} products in one room.`);
  const products: RoomProduct[] = productsRaw.map((p) => {
    const row = (p ?? {}) as Record<string, unknown>;
    const id = typeof row.id === "string" && existing?.products.some((e) => e.id === row.id) ? row.id : newId();
    const cutout = typeof row.cutoutFileId === "string" && row.cutoutFileId.trim() ? row.cutoutFileId.trim() : null;
    return { id, name: shortText(row.name, ROOM_NAME_MAX, "product", true)!, fileId: fileIdOf(row.fileId, "the product picture"), cutoutFileId: cutout };
  });
  return { name, photoFileId, cameraNote, zones, products };
}

export function normalizeRoom(value: unknown): Room | null {
  const raw = value as Record<string, unknown> | null;
  if (!raw || typeof raw.id !== "string" || typeof raw.name !== "string" || typeof raw.photoFileId !== "string") return null;
  return {
    id: raw.id,
    name: raw.name,
    photoFileId: raw.photoFileId,
    cameraNote: typeof raw.cameraNote === "string" ? raw.cameraNote : null,
    zones: Array.isArray(raw.zones) ? (raw.zones as RoomZone[]).filter((z) => z && typeof z.id === "string" && typeof z.maskFileId === "string") : [],
    products: Array.isArray(raw.products) ? (raw.products as RoomProduct[]).filter((p) => p && typeof p.id === "string" && typeof p.fileId === "string") : [],
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : new Date(0).toISOString(),
  };
}

/** "picture 2", "pictures 2 and 3", "pictures 2, 3 and 4". */
function pictures(noun: string, from: number, count: number): string {
  const list = Array.from({ length: count }, (_, i) => from + i);
  if (list.length === 1) return `${noun} ${list[0]}`;
  return `${noun}s ${list.slice(0, -1).join(", ")} and ${list[list.length - 1]}`;
}

/** The instruction for placing products into a room. Room = picture 1; products = 2.. */
export function placementPrompt(input: {
  service: "sogni" | "fal";
  zoneName: string;
  productNames: string[];
  cameraNote: string | null;
  extra: string | null;
}): string {
  const noun = input.service === "sogni" ? "picture" : "image";
  const products = pictures(noun, 2, input.productNames.length);
  const names = input.productNames.map((n) => `"${n}"`).join(", ");
  const parts = [
    `Place the product${input.productNames.length === 1 ? "" : "s"} from ${products} (${names}) into the room from ${noun} 1, inside the area "${input.zoneName}".`,
    `Keep the room exactly as in ${noun} 1: the same walls, floor, windows, furniture, camera position, perspective and lighting.`,
    `Keep each product's exact shape, colours, materials, pattern and proportions; scale it realistically for the room, stand it on the floor or surface naturally, and add soft contact shadows that match the room's light.`,
  ];
  if (input.cameraNote) parts.push(`Camera and lighting: ${input.cameraNote.replace(/[\s.]+$/, "")}.`);
  if (input.extra) parts.push(input.extra.trim());
  if (input.service === "sogni") parts.push("Maintain realistic anatomy, perspective, and lighting integration.");
  return parts.join(" ");
}
