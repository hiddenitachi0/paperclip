// Quick pictures: a small, fast, cheap picture to go along with a message
// ("just vibes"). The fastest path each picture service has, and nothing that
// slows it down: no reference pictures, no LoRAs, no look unless one is named.
//
// Models and sizes (checked 2026-09-28):
//   Fal.ai  fal-ai/flux/schnell, the FLUX.1 [schnell] model Fal serves for
//           fast pictures: num_inference_steps defaults to 4 and image_size
//           takes {width, height} (fal.ai/models/fal-ai/flux/schnell/api).
//           Fal bills schnell by megapixel, so a 512px picture is about a
//           quarter of the price of a 1024px one; 2 steps keeps it quick.
//   Sogni   z-turbo (Z-Image Turbo, catalog id z_image_turbo_bf16): in Sogni's
//           public model catalog (GET /v1/model-catalog?mediaType=image&
//           include=parameters) it has the lowest benchmark time (138) and
//           cost (about $0.008) of the generate_image models that need no
//           Premium plan and work with the content filter on; its sides are
//           512-2048 there, so its quick picture is 512 on the short side.
//           A workflow step has no steps argument, so Sogni picks the steps.

export const FAL_QUICK_MODEL = "fal-ai/flux/schnell";
/** FLUX.1 [schnell] is distilled for 1-4 steps; 2 is quick and still a clear picture. */
export const FAL_QUICK_STEPS = 2;
export const SOGNI_QUICK_MODEL = "z-turbo";
/** Z-Image Turbo's smallest side in Sogni's catalog. */
export const SOGNI_QUICK_MIN_SIDE = 512;
/** The long side of a quick picture where the model allows it. */
export const QUICK_LONG_SIDE = 512;

/** The whole quick picture (making it and fetching the bytes) is given up after this long. */
export const QUICK_PICTURE_TIMEOUT_MS = 30_000;
/** The picture service is told to stop a little earlier, so it can cancel its own job cleanly. */
export const QUICK_PICTURE_PROVIDER_TIMEOUT_MS = 28_000;

export const QUICK_PICTURE_TIMEOUT_SENTENCE =
  "The quick picture took longer than 30 seconds, so it was stopped. Send the message without it, or try again in a minute.";

export const QUICK_SHAPES = ["square", "landscape", "portrait"] as const;
export type QuickShape = (typeof QUICK_SHAPES)[number];

export function isQuickShape(value: unknown): value is QuickShape {
  return typeof value === "string" && (QUICK_SHAPES as readonly string[]).includes(value);
}

function roundTo16(value: number): number {
  return Math.max(16, Math.round(value / 16) * 16);
}

/**
 * The quick picture's size as "WxH": 512 on the long side (4:3 for
 * landscape and portrait), made bigger only when the model's smallest side
 * is larger (Sogni's Z-Image Turbo: 512).
 */
export function quickPictureSize(shape: QuickShape, service: string): { width: number; height: number; imageSize: string } {
  const minSide = service === "sogni" ? SOGNI_QUICK_MIN_SIDE : 0;
  let long = QUICK_LONG_SIDE;
  let short = shape === "square" ? long : roundTo16((long * 3) / 4);
  if (short < minSide) {
    long = shape === "square" ? minSide : roundTo16((minSide * 4) / 3);
    short = minSide;
  }
  const width = shape === "portrait" ? short : long;
  const height = shape === "portrait" ? long : short;
  return { width, height, imageSize: `${width}x${height}` };
}

/** The fastest model of a picture service; undefined for mock and ComfyUI (their own set-up decides). */
export function quickModelFor(service: string): string | undefined {
  if (service === "fal") return FAL_QUICK_MODEL;
  if (service === "sogni") return SOGNI_QUICK_MODEL;
  return undefined;
}

export class QuickPictureTimeout extends Error {
  constructor() {
    super(QUICK_PICTURE_TIMEOUT_SENTENCE);
    this.name = "QuickPictureTimeout";
  }
}

/** Run `work`, but give up with QuickPictureTimeout after `ms`. The late result (or error) is dropped. */
export async function withQuickTimeout<T>(work: Promise<T>, ms = QUICK_PICTURE_TIMEOUT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new QuickPictureTimeout()), ms);
  });
  work.catch(() => undefined);
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** "3.2 s" / "850 ms", for the result sentence. */
export function showDuration(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(Math.round(ms / 100) / 10).toFixed(1)} s`;
}
