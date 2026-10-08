// Small pieces the Identities and Rooms tabs share: box math for the crop
// editor, the box around a mask, uploads to the company's Files, and the
// action names (kept in step with src/anchors.ts; a test checks).
//
// Standalone ES module (see index.tsx's note): no imports outside ui/.

export const ACTION_IDENTITIES_LIST = "identities.list";
export const ACTION_IDENTITIES_SAVE = "identities.save";
export const ACTION_IDENTITIES_DELETE = "identities.delete";
export const ACTION_IDENTITIES_ANALYSE = "identities.analyse";
export const ACTION_IDENTITIES_CROP = "identities.crop";
export const ACTION_IDENTITIES_CANDIDATES = "identities.candidates";
export const ACTION_IDENTITIES_USE_CANDIDATE = "identities.useCandidate";
export const ACTION_IDENTITY_SETTINGS_GET = "identitySettings.get";
export const ACTION_IDENTITY_SETTINGS_SAVE = "identitySettings.save";
export const ACTION_ROOMS_LIST = "rooms.list";
export const ACTION_ROOMS_SAVE = "rooms.save";
export const ACTION_ROOMS_DELETE = "rooms.delete";
export const ACTION_ROOMS_PLACE = "rooms.place";
export const ACTION_IDENTITIES_GENERATION_OPTIONS = "identities.generationOptions";
export const ACTION_TRAINING_SET_GENERATE = "trainingSet.generate";
export const ACTION_TRAINING_SET_ADD = "trainingSet.add";
export const ACTION_TRAINING_SET_SELECT = "trainingSet.select";
export const ACTION_TRAINING_SET_REMOVE = "trainingSet.remove";
export const ACTION_TRAINING_SET_PRESETS = "trainingSet.presets";
export const ACTION_TRAINING_SET_DOWNLOAD = "trainingSet.download";
export const ACTION_HIGGSFIELD_SOUL = "higgsfield.soulId";
export const ACTION_TRAINED_STATUS = "trained.status";
export const ACTION_TRAINED_REMOVE = "trained.remove";
export const ACTION_SOGNI_LORAS = "sogni.loras";
export const ACTION_LORA_TRAIN = "lora.train";
export const ACTION_LORA_STATUS = "lora.status";
export const ACTION_LORA_PUBLISH = "lora.publish";
export const ACTION_LORA_IMPORT_SOGNI = "lora.importSogni";
export const ACTION_LORA_ATTACH = "lora.attach";
export const ACTION_LORA_RESET = "lora.reset";
export const ACTION_EDIT_SEGMENT = "edit.segment";
export const ACTION_EDIT_SOGNI = "edit.sogni";

export type CropRole = "face" | "body" | "outfit" | "other";
export const CROP_ROLE_OPTIONS: Array<{ value: CropRole; label: string; color: string; help: string }> = [
  { value: "face", label: "Face", color: "#e8590c", help: "Sent as picture 1: the face every picture keeps." },
  { value: "body", label: "Body", color: "#1971c2", help: "Sent as picture 2 when the model has room: body shape and proportions." },
  { value: "outfit", label: "Outfit", color: "#2f9e44", help: 'Only sent when a look ticks "same outfit".' },
  { value: "other", label: "Other", color: "#7048e8", help: "Kept with the identity; not sent automatically." },
];

export const IDENTITY_SHEET_OPTIONS = [
  { key: "hair", label: "Hair", placeholder: "long, straight, honey blonde, middle parting" },
  { key: "face", label: "Face", placeholder: "oval face, high cheekbones, small straight nose" },
  { key: "eyes", label: "Eyes", placeholder: "green, almond-shaped" },
  { key: "body", label: "Body and proportions", placeholder: "tall, slim, long legs" },
  { key: "skin", label: "Skin", placeholder: "fair with light freckles" },
  { key: "marks", label: "Distinguishing marks", placeholder: "small mole above the left lip" },
] as const;

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

const MIN = 0.02;
const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

/** Move a box by (dx, dy) fractions, keeping it inside the picture. */
export function moveBox(box: Box, dx: number, dy: number): Box {
  return { ...box, x: Math.min(1 - box.w, clamp01(box.x + dx)), y: Math.min(1 - box.h, clamp01(box.y + dy)) };
}

/** Drag the bottom-right corner by (dx, dy); at least 2% wide and high, never past the edge. */
export function resizeBox(box: Box, dx: number, dy: number): Box {
  return { ...box, w: Math.max(MIN, Math.min(1 - box.x, box.w + dx)), h: Math.max(MIN, Math.min(1 - box.y, box.h + dy)) };
}

/** A starting box for a role that has none yet. */
export function defaultBox(role: CropRole): Box {
  if (role === "face") return { x: 0.35, y: 0.05, w: 0.3, h: 0.3 };
  if (role === "body") return { x: 0.15, y: 0.02, w: 0.7, h: 0.96 };
  if (role === "outfit") return { x: 0.2, y: 0.3, w: 0.6, h: 0.5 };
  return { x: 0.3, y: 0.3, w: 0.4, h: 0.4 };
}

/** The box around the white part of a black-and-white mask (RGBA pixels); null when empty. */
export function maskBox(data: Uint8ClampedArray | Uint8Array, width: number, height: number): Box | null {
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (data[(y * width + x) * 4]! >= 128) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  return { x: minX / width, y: minY / height, w: (maxX - minX + 1) / width, h: (maxY - minY + 1) / height };
}

/** Grow a box by a margin (fraction of its own size) on every side, inside the picture. */
export function padBox(box: Box, margin = 0.15): Box {
  const x = clamp01(box.x - box.w * margin);
  const y = clamp01(box.y - box.h * margin);
  return { x, y, w: Math.min(1 - x, box.w * (1 + 2 * margin)), h: Math.min(1 - y, box.h * (1 + 2 * margin)) };
}

export function formatDollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/** Plain words for where a LoRA training is. */
export function trainingStatusText(status: string | null | undefined, progress?: string | null): string {
  switch (status) {
    case "training":
      return `Fal.ai is training the LoRA${progress ? ` (${progress})` : ""}. This usually takes 10 to 30 minutes; you can leave this page.`;
    case "trained":
      return "Trained. Publish it so Sogni can use it.";
    case "published":
      return "Published on Hugging Face.";
    case "failed":
      return "The training did not finish. You can try again with the same pictures.";
    default:
      return "Not started.";
  }
}

export function fileContentPath(fileId: string): string {
  return `/api/attachments/${fileId}/content`;
}

export function hostFetchJson<T>(path: string, init?: RequestInit): Promise<T> {
  return fetch(path, { credentials: "include", headers: { "content-type": "application/json", ...(init?.headers ?? {}) }, ...init }).then(async (res) => {
    if (!res.ok) throw new Error((await res.text()) || `Request failed: ${res.status}`);
    return (res.status === 204 ? (undefined as T) : ((await res.json()) as T));
  });
}

/** Save a picture (data: URL or Blob) as a new file in the company's Files; returns its id. */
export async function uploadPicture(companyId: string, picture: string | Blob, filename: string): Promise<string> {
  const blob = typeof picture === "string" ? await (await fetch(picture)).blob() : picture;
  const form = new FormData();
  form.append("file", blob, filename);
  const res = await fetch(`/api/companies/${companyId}/files`, { method: "POST", credentials: "include", body: form });
  if (!res.ok) throw new Error((await res.text()) || `Saving the picture failed: ${res.status}`);
  const created = (await res.json()) as { id?: string };
  if (!created.id) throw new Error("The picture was saved but its id did not come back. Reload the page.");
  return created.id;
}

/** A company picture as a data: URL (for the AI tools that take the picture's bytes). */
export async function pictureDataUrl(fileId: string): Promise<string> {
  const res = await fetch(fileContentPath(fileId), { credentials: "include" });
  if (!res.ok) throw new Error(`The picture could not be read (${res.status}).`);
  const blob = await res.blob();
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("The picture could not be read."));
    reader.readAsDataURL(blob);
  });
}

/** The company's pictures for pickers: from the artifacts list (newest first). */
export async function listCompanyPictures(companyId: string): Promise<Array<{ fileId: string; title: string }>> {
  const res = await hostFetchJson<{ artifacts?: Array<{ title: string; contentPath: string | null }> }>(`/api/companies/${companyId}/artifacts?kind=image&limit=100`);
  const found: Array<{ fileId: string; title: string }> = [];
  for (const artifact of res.artifacts ?? []) {
    const match = artifact.contentPath ? /^\/api\/attachments\/([0-9a-f-]{36})\/content$/i.exec(artifact.contentPath) : null;
    if (match && !found.some((p) => p.fileId === match[1])) found.push({ fileId: match[1]!, title: artifact.title });
  }
  return found;
}

/** Saved models (Settings > Models) that can see pictures first, then the rest. */
export function visionModelsFirst<T extends { specs?: { vision?: boolean | null } | null; archivedAt?: string | null }>(entries: T[]): T[] {
  const live = entries.filter((e) => !e.archivedAt);
  return [...live.filter((e) => e.specs?.vision === true), ...live.filter((e) => e.specs?.vision !== true)];
}

/** The page's cost estimate for one batch: pictures x price per picture, or null when the service publishes none. */
export function batchEstimateCents(priceCentsPerPicture: number | null | undefined, pictures: number): number | null {
  return typeof priceCentsPerPicture === "number" ? priceCentsPerPicture * pictures : null;
}

/** How many calls a batch needs on a service that makes `perCall` pictures per call. */
export function callsFor(pictures: number, perCall: number): number {
  return Math.ceil(Math.max(0, pictures) / Math.max(1, perCall));
}
