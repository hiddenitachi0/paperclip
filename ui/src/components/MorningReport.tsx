/**
 * Maja's morning report page body (design from Claude Design, 30 Sep 2026).
 * Renders only from the structured facts: plain text everywhere (never HTML
 * or markdown, parts of it are model-written), external links only http(s)
 * with rel="noopener noreferrer", pictures only from Paperclip's own storage
 * via imageUrl(). No network calls of its own.
 */
import * as React from "react";
import {
  ArrowUpRight,
  CloudSun,
  Gamepad2,
  Info,
  MapPin,
  Newspaper,
  TrendingDown,
  TrendingUp,
  Trophy,
  Wallet,
} from "lucide-react";
import type { MorningReportFacts } from "@paperclipai/shared";

export type { MorningReportFacts };

export type MorningReportProps = {
  facts: MorningReportFacts;
  imageUrl: (fileId: string) => string;
  date?: Date;
};

/* ---------- helpers ---------- */

function safeHref(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.href : null;
  } catch {
    return null;
  }
}

function formatPrice(value: number, currency: string): string {
  const digits = value >= 1000 ? 0 : value >= 1 ? 2 : 4;
  try {
    return new Intl.NumberFormat("en-GB", {
      style: "currency",
      currency,
      maximumFractionDigits: digits,
      minimumFractionDigits: digits,
    }).format(value);
  } catch {
    return `${value.toFixed(digits)} ${currency}`;
  }
}

function formatChange(p: number | null): string {
  if (p === null || !Number.isFinite(p)) return "—";
  const sign = p > 0 ? "+" : p < 0 ? "−" : "";
  return `${sign}${Math.abs(p).toFixed(2)}%`;
}

/* ---------- primitives (shadcn-style) ---------- */

function Card({ className = "", children }: { className?: string; children: React.ReactNode }) {
  return (
    <div
      className={`rounded-xl border border-zinc-200 bg-white text-zinc-950 shadow-sm dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-50 ${className}`}
    >
      {children}
    </div>
  );
}

function SectionTitle({ icon: Icon, children }: { icon: React.ElementType; children: React.ReactNode }) {
  return (
    <h2 className="mb-3 flex items-center gap-2 px-1 text-sm font-semibold tracking-tight text-zinc-500 dark:text-zinc-400">
      <Icon className="h-4 w-4" aria-hidden="true" />
      {children}
    </h2>
  );
}

function ExternalLink({
  href,
  className = "",
  children,
}: {
  href: string | null;
  className?: string;
  children: React.ReactNode;
}) {
  if (!href) return <span className={className}>{children}</span>;
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className={className}>
      {children}
    </a>
  );
}

function Picture({ src, caption, ratio }: { src: string; caption: string; ratio: string }) {
  return (
    <figure className="overflow-hidden">
      <img
        src={src}
        alt={caption}
        loading="lazy"
        className={`w-full ${ratio} object-cover bg-zinc-100 dark:bg-zinc-800`}
      />
      {caption ? (
        <figcaption className="px-4 pt-2.5 text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">
          {caption}
        </figcaption>
      ) : null}
    </figure>
  );
}

function Sparkline({ values, up }: { values: number[]; up: boolean | null }) {
  if (values.length < 2) return null;
  const w = 120;
  const h = 32;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const pts = values
    .map((v, i) => `${((i / (values.length - 1)) * w).toFixed(1)},${(h - 2 - ((v - min) / span) * (h - 4)).toFixed(1)}`)
    .join(" ");
  const color =
    up === null ? "text-zinc-400" : up ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400";
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className={`h-8 w-full ${color}`} aria-hidden="true">
      <polyline points={pts} fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function LinkList({ items, empty }: { items: { title: string; url: string; source: string }[]; empty: string }) {
  if (items.length === 0) {
    return <p className="px-4 py-4 text-sm text-zinc-500 dark:text-zinc-400">{empty}</p>;
  }
  return (
    <ul className="divide-y divide-zinc-200 dark:divide-zinc-800">
      {items.map((it, i) => (
        <li key={i}>
          <ExternalLink
            href={safeHref(it.url)}
            className="flex min-h-[44px] items-start justify-between gap-3 px-4 py-3 transition-colors hover:bg-zinc-50 dark:hover:bg-zinc-800/60"
          >
            <span className="min-w-0">
              <span className="block text-[15px] font-medium leading-snug">{it.title}</span>
              <span className="mt-0.5 block text-xs text-zinc-500 dark:text-zinc-400">{it.source}</span>
            </span>
            <ArrowUpRight className="mt-0.5 h-4 w-4 shrink-0 text-zinc-400" aria-hidden="true" />
          </ExternalLink>
        </li>
      ))}
    </ul>
  );
}

/* ---------- main ---------- */

export function MorningReport({ facts, imageUrl, date = new Date() }: MorningReportProps) {
  const mood = facts.images.find((i) => i.kind === "mood");
  const weatherImg = facts.images.find((i) => i.kind === "weather");
  const headlines = facts.headlines.slice(0, 10);
  const weather = [...facts.weather].sort((a, b) => {
    const ia = facts.places.indexOf(a.place);
    const ib = facts.places.indexOf(b.place);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });

  const dateLabel = date.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });

  return (
    <div className="min-h-full bg-zinc-50 text-zinc-950 antialiased dark:bg-zinc-950 dark:text-zinc-50">
      <main className="mx-auto flex max-w-md flex-col gap-8 px-4 pb-10 pt-8">
        {/* Date + greeting */}
        <header className="px-1">
          <p className="text-sm font-medium text-zinc-500 dark:text-zinc-400">{dateLabel}</p>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight">Good morning</h1>
        </header>

        {/* Mood image + opening */}
        {mood || facts.opening ? (
          <Card className="overflow-hidden pb-4">
            {mood ? <Picture src={imageUrl(mood.fileId)} caption={mood.caption} ratio="aspect-[4/3]" /> : null}
            {facts.opening ? (
              <p className={`px-4 text-[15px] leading-relaxed text-zinc-700 dark:text-zinc-300 ${mood ? "pt-3" : "pt-4"}`}>
                {facts.opening}
              </p>
            ) : null}
          </Card>
        ) : null}

        {/* Headlines */}
        {headlines.length > 0 ? (
          <section>
            <SectionTitle icon={Newspaper}>Headlines</SectionTitle>
            <Card>
              <ol className="divide-y divide-zinc-200 dark:divide-zinc-800">
                {headlines.map((h, i) => {
                  const href = safeHref(h.url);
                  return (
                    <li key={i} className="flex gap-3 px-4 py-4">
                      <span
                        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-zinc-900 text-sm font-semibold tabular-nums text-white dark:bg-zinc-100 dark:text-zinc-900"
                        aria-label={`Number ${i + 1}`}
                      >
                        {i + 1}
                      </span>
                      <div className="min-w-0 flex-1">
                        <h3 className="text-[15px] font-semibold leading-snug">{h.title}</h3>
                        {h.summary ? (
                          <p className="mt-1 text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">{h.summary}</p>
                        ) : null}
                        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                          <span className="text-zinc-500 dark:text-zinc-400">{h.source}</span>
                          {href ? (
                            <a
                              href={href}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="-my-2 inline-flex min-h-[44px] items-center gap-1 font-medium text-zinc-900 underline-offset-4 hover:underline dark:text-zinc-100"
                            >
                              Read the full story
                              <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
                            </a>
                          ) : null}
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ol>
            </Card>
          </section>
        ) : null}

        {/* Weather */}
        {weather.length > 0 || weatherImg ? (
          <section>
            <SectionTitle icon={CloudSun}>Weather</SectionTitle>
            <Card className="overflow-hidden">
              {weatherImg ? <Picture src={imageUrl(weatherImg.fileId)} caption={weatherImg.caption} ratio="aspect-[16/10]" /> : null}
              {weather.length > 0 ? (
                <div className={`divide-y divide-zinc-200 dark:divide-zinc-800 ${weatherImg ? "mt-3 border-t border-zinc-200 dark:border-zinc-800" : ""}`}>
                  {weather.map((w, i) => (
                    <div key={i} className="px-4 py-4">
                      <div className="flex items-center gap-1.5 text-sm font-semibold">
                        <MapPin className="h-4 w-4 text-zinc-400" aria-hidden="true" />
                        {w.place}
                      </div>
                      <p className="mt-1.5 whitespace-pre-line text-sm leading-relaxed text-zinc-700 dark:text-zinc-300">{w.text}</p>
                    </div>
                  ))}
                </div>
              ) : null}
            </Card>
          </section>
        ) : null}

        {/* Prices */}
        {facts.prices.length > 0 ? (
          <section>
            <SectionTitle icon={Wallet}>Prices</SectionTitle>
            <div className="grid grid-cols-2 gap-3">
              {facts.prices.map((p, i) => {
                const c = p.changePercent;
                const up = c === null ? null : c >= 0;
                const badge =
                  up === null
                    ? "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400"
                    : up
                    ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-400"
                    : "bg-rose-50 text-rose-700 dark:bg-rose-950 dark:text-rose-400";
                const Trend = up === false ? TrendingDown : TrendingUp;
                return (
                  <Card key={i} className="flex flex-col gap-2 p-3.5">
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate text-sm font-semibold">{p.symbol}</span>
                      <span className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-medium tabular-nums ${badge}`}>
                        {up !== null ? <Trend className="h-3 w-3" aria-hidden="true" /> : null}
                        {formatChange(c)}
                      </span>
                    </div>
                    <div className="text-lg font-semibold tabular-nums tracking-tight">{formatPrice(p.price, p.currency)}</div>
                    <Sparkline values={p.history.map((h) => h.price)} up={up} />
                  </Card>
                );
              })}
            </div>
          </section>
        ) : null}

        {/* Hobby */}
        <section>
          <SectionTitle icon={Gamepad2}>Hobby</SectionTitle>
          <Card>
            <LinkList items={facts.hobby} empty="Nothing new today" />
          </Card>
        </section>

        {/* Sport */}
        <section>
          <SectionTitle icon={Trophy}>Sport</SectionTitle>
          <Card>
            <LinkList items={facts.sport} empty="Nothing new today" />
          </Card>
        </section>

        {/* Notes */}
        {facts.notes.length > 0 ? (
          <section className="px-1">
            <h2 className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-zinc-500 dark:text-zinc-400">
              <Info className="h-3.5 w-3.5" aria-hidden="true" />
              Notes
            </h2>
            <ul className="list-disc space-y-1 pl-5 text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">
              {facts.notes.map((n, i) => (
                <li key={i}>{n}</li>
              ))}
            </ul>
          </section>
        ) : null}

        <footer className="border-t border-zinc-200 px-1 pt-4 text-center text-xs tabular-nums text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
          {facts.stats.sourcesChecked} sources checked · {facts.stats.itemsFound} items found
        </footer>
      </main>
    </div>
  );
}

export default MorningReport;
