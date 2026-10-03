import type { MorningReportFactItem, MorningReportFacts, MorningReportOutboxItem } from "@paperclipai/shared";

/**
 * Rendering helpers for the morning report full briefing page (DUR-4075).
 * Kept framework-free (no JSX) so link-safety and the downloadable-HTML
 * builder are unit-testable without mounting React in a headless browser
 * this sandbox does not have.
 */

/** Only http(s) links are ever rendered as a clickable link — Filip's security ground rule. Anything else (javascript:, data:, mailto:, a bare string) renders as plain text instead. */
export function isSafeExternalUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export interface CoverageSummary {
  sourcesChecked: number;
  itemsFound: number;
}

/**
 * DUR-4138: "sources checked / items found" footer line — reads facts.stats
 * (the same counts collectHeadlines logs and the live briefing page already
 * renders), not a recount of distinct sources across the *kept* fact lists.
 * That recount is what produced the "2 sources checked" bug Filip reported
 * when the report itself said 11: `stats.sourcesChecked` counts every source
 * the agent was configured to check, including ones that ended up with zero
 * kept items after topic filtering/dedupe/balancing, which a recount over
 * kept items alone can never see.
 */
export function summarizeCoverage(facts: MorningReportFacts): CoverageSummary {
  return facts.stats;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function factItemsHtml(title: string, items: MorningReportFactItem[]): string {
  if (items.length === 0) return "";
  const rows = items
    .map((item, i) => {
      const linkOpen = isSafeExternalUrl(item.url)
        ? `<a href="${escapeHtml(item.url)}" target="_blank" rel="noopener noreferrer">`
        : "<span>";
      const linkClose = isSafeExternalUrl(item.url) ? "</a>" : "</span>";
      const summary = item.summary ? `<br /><span class="summary">${escapeHtml(item.summary)}</span>` : "";
      return `<li><span class="num">${i + 1}.</span> ${linkOpen}${escapeHtml(item.title)}${linkClose} <span class="source">— ${escapeHtml(item.source)}</span>${summary}</li>`;
    })
    .join("\n");
  return `<section><h2>${escapeHtml(title)}</h2><ol class="items">${rows}</ol></section>`;
}

export interface DownloadImage {
  fileId: string;
  caption: string;
  /** data: URI, already fetched and base64-encoded — the whole point of a self-contained file is no network calls when opened later. */
  dataUrl: string;
}

/**
 * Builds one self-contained .html string: inline CSS, embedded images (as
 * data URIs the caller already fetched), no external requests when opened
 * later offline. Pure/no DOM APIs so it is unit-testable in plain Node.
 */
export function buildStandaloneReportHtml(
  report: Pick<MorningReportOutboxItem, "text" | "createdAt" | "facts">,
  agentName: string,
  images: DownloadImage[],
): string {
  const facts = report.facts ?? null;
  const imageFigure = (img: DownloadImage) =>
    `<figure><img src="${img.dataUrl}" alt="${escapeHtml(img.caption)}" /><figcaption>${escapeHtml(img.caption)}</figcaption></figure>`;
  const moodImage = facts ? facts.images.find((i) => i.kind === "mood") : undefined;
  const weatherImage = facts ? facts.images.find((i) => i.kind === "weather") : undefined;
  const findImage = (fileId: string) => images.find((img) => img.fileId === fileId);
  const moodHtml = moodImage ? imageFigure(findImage(moodImage.fileId) ?? { ...moodImage, dataUrl: "" }) : "";
  const weatherImageHtml = weatherImage ? imageFigure(findImage(weatherImage.fileId) ?? { ...weatherImage, dataUrl: "" }) : "";

  const weatherHtml =
    facts && (facts.weather.length > 0 || weatherImage)
      ? `<section><h2>Weather${facts.places.length ? ` — ${escapeHtml(facts.places.join(", "))}` : ""}</h2>${weatherImageHtml}${facts.weather
          .map((w) => `<h3>${escapeHtml(w.place)}</h3><p class="pre">${escapeHtml(w.text)}</p>`)
          .join("")}</section>`
      : "";

  const pricesHtml =
    facts && facts.prices.length > 0
      ? `<section><h2>Prices</h2><ul class="prices">${facts.prices
          .map((p) => {
            const changeText =
              p.changePercent === null
                ? ""
                : ` <span class="${p.changePercent >= 0 ? "up" : "down"}">${p.changePercent >= 0 ? "+" : ""}${p.changePercent.toFixed(2)}%</span>`;
            return `<li><strong>${escapeHtml(p.symbol)}</strong> ${p.price} ${escapeHtml(p.currency)}${changeText}</li>`;
          })
          .join("\n")}</ul></section>`
      : "";

  const notesHtml =
    facts && facts.notes.length > 0
      ? `<section><h2>Notes</h2><ul>${facts.notes.map((n) => `<li>${escapeHtml(n)}</li>`).join("\n")}</ul></section>`
      : "";

  const coverage = facts ? summarizeCoverage(facts) : null;
  const footerHtml = coverage
    ? `<footer>${coverage.sourcesChecked} source${coverage.sourcesChecked === 1 ? "" : "s"} checked, ${coverage.itemsFound} item${coverage.itemsFound === 1 ? "" : "s"} found.</footer>`
    : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>${escapeHtml(agentName)}'s morning report</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; max-width: 640px; margin: 2rem auto; padding: 0 1rem; color: #1a1a1a; background: #fff; line-height: 1.5; }
  h1 { font-size: 1.4rem; }
  h2 { font-size: 1.1rem; margin-top: 2rem; border-bottom: 1px solid #e5e5e5; padding-bottom: 0.25rem; }
  .date { color: #666; font-size: 0.9rem; }
  .pre { white-space: pre-line; }
  figure { margin: 1rem 0; }
  figure img { max-width: 100%; border-radius: 8px; }
  figcaption { font-size: 0.8rem; color: #666; }
  ol.items { list-style: none; padding: 0; }
  ol.items li { margin-bottom: 0.5rem; }
  .num { color: #888; }
  .source { color: #888; font-size: 0.85rem; }
  ul.prices { list-style: none; padding: 0; }
  ul.prices li { padding: 0.4rem 0; border-bottom: 1px solid #f0f0f0; }
  .up { color: #16a34a; }
  .down { color: #dc2626; }
  a { color: #2563eb; }
  footer { margin-top: 2rem; color: #888; font-size: 0.85rem; border-top: 1px solid #e5e5e5; padding-top: 0.75rem; }
  @media (prefers-color-scheme: dark) {
    body { background: #111; color: #eee; }
    h2 { border-color: #333; }
    ul.prices li { border-color: #222; }
    footer { border-color: #333; }
  }
</style>
</head>
<body>
<h1>${escapeHtml(agentName)}'s morning report</h1>
<p class="date">${escapeHtml(new Date(report.createdAt).toLocaleString())}</p>
${moodHtml}
<div class="pre">${escapeHtml(report.text)}</div>
${factItemsHtml("Headlines", facts?.headlines ?? [])}
${weatherHtml}
${pricesHtml}
${factItemsHtml("Hobby", facts?.hobby ?? [])}
${factItemsHtml("Sport", facts?.sport ?? [])}
${notesHtml}
${footerHtml}
</body>
</html>`;
}
