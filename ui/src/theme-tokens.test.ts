import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Contrast guard for the theme tokens in index.css.
 *
 * Parses the oklch() values of the `:root` (light) and `.dark` blocks,
 * converts them to sRGB relative luminance and checks the WCAG 2.1 ratios
 * the themes promise:
 *   - borders read as edges on the surfaces they sit on (1.4.11, ≥ 3:1)
 *   - input borders are visible on cards (≥ 3:1)
 *   - muted text stays readable on cards (1.4.3, ≥ 4.5:1)
 *   - body text stays readable on cards (≥ 4.5:1)
 * plus the surface ladder that gives each level its own lightness.
 * No dependency: the oklch → linear sRGB maths is the published OKLab matrix.
 */

type Oklch = { l: number; c: number; h: number };

const CSS = fs.readFileSync(fileURLToPath(new URL("./index.css", import.meta.url)), "utf8");

function block(selector: string): string {
  const start = CSS.indexOf(`\n${selector} {`);
  if (start < 0) throw new Error(`no ${selector} block in index.css`);
  const end = CSS.indexOf("\n}", start);
  return CSS.slice(start, end);
}

function parseTokens(selector: string): Record<string, Oklch> {
  const out: Record<string, Oklch> = {};
  const re = /--([a-z0-9-]+):\s*oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*[\d.%]+)?\s*\)/g;
  for (const match of block(selector).matchAll(re)) {
    out[match[1]] = { l: Number(match[2]), c: Number(match[3]), h: Number(match[4]) };
  }
  return out;
}

function oklchToLinearSrgb({ l: L, c: C, h }: Oklch): [number, number, number] {
  const a = C * Math.cos((h * Math.PI) / 180);
  const b = C * Math.sin((h * Math.PI) / 180);
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ ** 3;
  const m = m_ ** 3;
  const s = s_ ** 3;
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  return [
    clamp(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    clamp(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    clamp(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
  ];
}

function luminance(color: Oklch): number {
  const [r, g, b] = oklchToLinearSrgb(color);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(a: Oklch, b: Oklch): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

const THEMES = {
  light: parseTokens(":root"),
  dark: parseTokens(".dark"),
} as const;

/** [foreground/edge token, surface token, minimum ratio] */
const REQUIRED_PAIRS: Array<[string, string, number]> = [
  ["border", "card", 3],
  ["border", "background", 3],
  ["input", "card", 3],
  ["muted-foreground", "card", 4.5],
  ["foreground", "card", 4.5],
];

/** Extra pairs the themes also promise; kept separate so the five required ones stay obvious. */
const EXTRA_PAIRS: Array<[string, string, number]> = [
  ["border", "popover", 3],
  ["sidebar-border", "sidebar", 3],
  ["input", "input-background", 3],
  ["ring", "card", 3],
  ["ring", "input-background", 3],
  ["muted-foreground", "background", 4.5],
  ["muted-foreground", "muted", 4.5],
  ["muted-foreground", "accent", 4.5],
  ["muted-foreground", "popover", 4.5],
  ["foreground", "background", 4.5],
  ["foreground", "input-background", 4.5],
  ["foreground", "code-background", 4.5],
  ["foreground", "accent", 4.5],
  ["primary-foreground", "primary", 4.5],
  ["destructive", "card", 3],
  ["chart-1", "background", 3],
  ["chart-2", "background", 3],
  ["chart-3", "background", 3],
  ["chart-4", "background", 3],
  ["chart-5", "background", 3],
];

describe.each(Object.entries(THEMES))("%s theme tokens", (themeName, tokens) => {
  it("parses the surface, edge and text tokens", () => {
    for (const name of [
      "background", "foreground", "card", "popover", "sidebar", "muted", "accent",
      "border", "input", "input-background", "code-background", "ring", "muted-foreground",
    ]) {
      expect(tokens[name], `${themeName}: --${name} must be a plain oklch() value`).toBeDefined();
    }
  });

  it("prints the contrast table", () => {
    const rows = [...REQUIRED_PAIRS, ...EXTRA_PAIRS].map(
      ([fg, bg, min]) => `${fg.padEnd(18)} on ${bg.padEnd(16)} ${contrastRatio(tokens[fg], tokens[bg]).toFixed(2).padStart(6)}:1  (min ${min})`,
    );
    console.info(`[theme-tokens] ${themeName}\n  ${rows.join("\n  ")}`);
  });

  it.each(REQUIRED_PAIRS)("%s on %s is at least %s:1", (fg, bg, min) => {
    expect(contrastRatio(tokens[fg], tokens[bg])).toBeGreaterThanOrEqual(min);
  });

  it.each(EXTRA_PAIRS)("(extra) %s on %s is at least %s:1", (fg, bg, min) => {
    expect(contrastRatio(tokens[fg], tokens[bg])).toBeGreaterThanOrEqual(min);
  });

  it("gives input fields a background that differs from the card", () => {
    expect(Math.abs(tokens["input-background"].l - tokens.card.l)).toBeGreaterThanOrEqual(0.03);
  });
});

describe("surface ladder", () => {
  it("dark: code-background < background < sidebar < card < popover < input-background", () => {
    const t = THEMES.dark;
    const ladder = ["code-background", "background", "sidebar", "card", "popover", "input-background"].map((n) => t[n].l);
    for (let i = 1; i < ladder.length; i += 1) {
      expect(ladder[i], `step ${i}`).toBeGreaterThan(ladder[i - 1] + 0.02);
    }
    // No pure black anywhere on the page surfaces.
    expect(t.background.l).toBeGreaterThanOrEqual(0.2);
  });

  it("light: sidebar < background < card, with cards white", () => {
    const t = THEMES.light;
    expect(t.sidebar.l).toBeLessThan(t.background.l);
    expect(t.background.l).toBeLessThan(t.card.l);
    expect(t.card.l).toBe(1);
  });
});
