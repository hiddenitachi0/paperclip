// Pure selection-mask math for the Edit tab's "select an area" tools.
// A mask is a flat w*h array: 1 = selected, 0 = not selected. Kept free of
// any canvas/DOM use so it can be tested directly (jsdom has no 2D canvas).

export type Mask = { width: number; height: number; data: Uint8Array };

export function createMask(width: number, height: number): Mask {
  return { width, height, data: new Uint8Array(Math.max(1, width) * Math.max(1, height)) };
}

export function clearMask(mask: Mask): void {
  mask.data.fill(0);
}

export function invertMask(mask: Mask): void {
  for (let i = 0; i < mask.data.length; i += 1) mask.data[i] = mask.data[i] ? 0 : 1;
}

export function hasSelection(mask: Mask): boolean {
  return mask.data.some((v) => v !== 0);
}

/** Paints (value 1) or erases (value 0) a filled circle centred on (cx, cy). */
export function stampCircle(mask: Mask, cx: number, cy: number, radius: number, value: 0 | 1): void {
  const r = Math.max(0.5, radius);
  const x0 = Math.max(0, Math.floor(cx - r));
  const x1 = Math.min(mask.width - 1, Math.ceil(cx + r));
  const y0 = Math.max(0, Math.floor(cy - r));
  const y1 = Math.min(mask.height - 1, Math.ceil(cy + r));
  const r2 = r * r;
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      if (dx * dx + dy * dy <= r2) mask.data[y * mask.width + x] = value;
    }
  }
}

/** A brush stroke from one point to the next with no gaps. */
export function strokeLine(mask: Mask, x0: number, y0: number, x1: number, y1: number, radius: number, value: 0 | 1): void {
  const dist = Math.hypot(x1 - x0, y1 - y0);
  const step = Math.max(1, radius / 2);
  const steps = Math.max(1, Math.ceil(dist / step));
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    stampCircle(mask, x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, radius, value);
  }
}

/** Fills (or clears) the pixels inside the rectangle spanned by two corners. */
export function fillRect(mask: Mask, ax: number, ay: number, bx: number, by: number, value: 0 | 1 = 1): void {
  const x0 = Math.max(0, Math.floor(Math.min(ax, bx)));
  const x1 = Math.min(mask.width, Math.ceil(Math.max(ax, bx)));
  const y0 = Math.max(0, Math.floor(Math.min(ay, by)));
  const y1 = Math.min(mask.height, Math.ceil(Math.max(ay, by)));
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) mask.data[y * mask.width + x] = value;
  }
}

/** Fills the inside of a freehand outline (even-odd rule, scanline). */
export function fillPolygon(mask: Mask, points: Array<{ x: number; y: number }>, value: 0 | 1 = 1): void {
  if (points.length < 3) return;
  for (let y = 0; y < mask.height; y += 1) {
    const sy = y + 0.5;
    const crossings: number[] = [];
    for (let i = 0; i < points.length; i += 1) {
      const a = points[i];
      const b = points[(i + 1) % points.length];
      if ((a.y <= sy && b.y > sy) || (b.y <= sy && a.y > sy)) {
        crossings.push(a.x + ((sy - a.y) / (b.y - a.y)) * (b.x - a.x));
      }
    }
    crossings.sort((p, q) => p - q);
    for (let i = 0; i + 1 < crossings.length; i += 2) {
      const from = Math.max(0, Math.round(crossings[i]));
      const to = Math.min(mask.width, Math.round(crossings[i + 1]));
      for (let x = from; x < to; x += 1) mask.data[y * mask.width + x] = value;
    }
  }
}

/** Adds every pixel that is bright in a returned black-and-white picture (RGBA bytes) to the mask. */
export function mergeBrightPixels(mask: Mask, rgba: Uint8ClampedArray | Uint8Array): void {
  const n = Math.min(mask.data.length, Math.floor(rgba.length / 4));
  for (let i = 0; i < n; i += 1) {
    if (rgba[i * 4] >= 128) mask.data[i] = 1;
  }
}

/** RGBA bytes for showing the selection as a see-through coloured overlay. */
export function maskToOverlayRgba(mask: Mask, rgb: [number, number, number] = [224, 49, 49], alpha = 120): Uint8ClampedArray {
  const out = new Uint8ClampedArray(mask.data.length * 4);
  for (let i = 0; i < mask.data.length; i += 1) {
    if (!mask.data[i]) continue;
    out[i * 4] = rgb[0];
    out[i * 4 + 1] = rgb[1];
    out[i * 4 + 2] = rgb[2];
    out[i * 4 + 3] = alpha;
  }
  return out;
}

/** RGBA bytes for the black-and-white picture sent to the server (white = selected). */
export function maskToBlackWhiteRgba(mask: Mask): Uint8ClampedArray {
  const out = new Uint8ClampedArray(mask.data.length * 4);
  for (let i = 0; i < mask.data.length; i += 1) {
    const v = mask.data[i] ? 255 : 0;
    out[i * 4] = v;
    out[i * 4 + 1] = v;
    out[i * 4 + 2] = v;
    out[i * 4 + 3] = 255;
  }
  return out;
}
