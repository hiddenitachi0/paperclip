// Per-company theming. `brandColor` already exists on Company (and tints the
// company icon); here we also drive the app's primary theme tokens from it, and
// give each company an opt-out ("use the default Paperclip skin") so screenshots
// and tutorials can match the stock look. The opt-out is a per-company UI
// preference (localStorage) — no schema change.

export const BRANDING_CHANGED_EVENT = "paperclip:branding-changed";

const skinKey = (companyId: string) => `paperclip.defaultSkin.${companyId}`;

/** True when this company is pinned to the stock Paperclip skin (branding off). */
export function isDefaultSkin(companyId: string | null): boolean {
  if (!companyId) return false;
  try {
    return localStorage.getItem(skinKey(companyId)) === "1";
  } catch {
    return false;
  }
}

export function setDefaultSkin(companyId: string, value: boolean): void {
  try {
    if (value) localStorage.setItem(skinKey(companyId), "1");
    else localStorage.removeItem(skinKey(companyId));
  } catch {
    // ignore storage failures (private mode, quota) — theming just stays as-is
  }
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(BRANDING_CHANGED_EVENT));
  }
}

// The theme tokens we override. Kept to the "primary" family so a brand color
// tints buttons, focus rings, and primary accents without wrecking contrast on
// backgrounds/text. Values are set on <html> so they win over :root and .dark.
const BRAND_VARS = [
  "--primary",
  "--primary-foreground",
  "--ring",
  "--sidebar-primary",
  "--sidebar-primary-foreground",
  "--sidebar-ring",
] as const;

function parseHex(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m) return null;
  let h = m[1];
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

/** Pick a readable foreground (near-black or near-white) for text on `hex`. */
function readableForeground(rgb: [number, number, number]): string {
  const [r, g, b] = rgb;
  // Perceived brightness (ITU-R BT.601). Bright brand → dark text, else light.
  const brightness = (r * 299 + g * 587 + b * 114) / 1000;
  return brightness > 150 ? "oklch(0.145 0 0)" : "oklch(0.985 0 0)";
}

/** Apply (or, with null/invalid, clear) the brand color as theme overrides. */
export function applyBrandColor(hex: string | null): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  const rgb = hex ? parseHex(hex) : null;
  if (!rgb) {
    for (const v of BRAND_VARS) root.style.removeProperty(v);
    return;
  }
  const normalized = `#${rgb.map((n) => n.toString(16).padStart(2, "0")).join("")}`;
  const fg = readableForeground(rgb);
  root.style.setProperty("--primary", normalized);
  root.style.setProperty("--primary-foreground", fg);
  root.style.setProperty("--ring", normalized);
  root.style.setProperty("--sidebar-primary", normalized);
  root.style.setProperty("--sidebar-primary-foreground", fg);
  root.style.setProperty("--sidebar-ring", normalized);
}
