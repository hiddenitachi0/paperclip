/**
 * DUR-3972 S3: calendar months cut in the SHOP's time zone (Shopify's
 * `shop.ianaTimezone`), never the server's. An order at 23:30 Oslo time on
 * 31 July is a July sale even though it is 21:30 UTC; an order at 22:30 UTC on
 * 31 July is already 1 August in Oslo.
 *
 * Only Intl is used (no tz library): the offset of a zone at an instant is read
 * back from Intl.DateTimeFormat, which is exact for any IANA zone Node knows.
 */

export interface ZonedParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatterCache.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatterCache.set(timeZone, formatter);
  }
  return formatter;
}

/** Throws a RangeError for an unknown zone. */
export function assertValidTimeZone(timeZone: string): void {
  formatterFor(timeZone);
}

export function zonedParts(instant: Date, timeZone: string): ZonedParts {
  const parts = formatterFor(timeZone).formatToParts(instant);
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? "NaN");
  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour") % 24,
    minute: get("minute"),
    second: get("second"),
  };
}

/** Offset of `timeZone` from UTC at `instant`, in milliseconds (Oslo summer = +2h). */
function offsetMs(instant: Date, timeZone: string): number {
  const p = zonedParts(instant, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  const wholeSeconds = Math.floor(instant.getTime() / 1000) * 1000;
  return asUtc - wholeSeconds;
}

/** The UTC instant of local wall-clock midnight on `year-month-01` in `timeZone`. */
export function zonedMonthStart(year: number, month: number, timeZone: string): Date {
  return zonedDayStart(year, month, 1, timeZone);
}

/** The UTC instant of local wall-clock midnight on `year-month-day` in `timeZone`. */
export function zonedDayStart(year: number, month: number, day: number, timeZone: string): Date {
  const normalized = new Date(Date.UTC(year, month - 1, day));
  const guess = normalized.getTime();
  let candidate = guess - offsetMs(new Date(guess), timeZone);
  // One correction step handles a DST change between the guess and the answer.
  candidate = guess - offsetMs(new Date(candidate), timeZone);
  return new Date(candidate);
}

export function monthKey(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, "0")}`;
}

/** "2026-07" for an instant, as the shop's calendar sees it. */
export function zonedMonthKey(instant: Date, timeZone: string): string {
  const p = zonedParts(instant, timeZone);
  return monthKey(p.year, p.month);
}

export function parseMonthKey(key: string): { year: number; month: number } | null {
  const match = /^(\d{4})-(\d{2})$/.exec(key);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  if (year < 2000 || year > 2100 || month < 1 || month > 12) return null;
  return { year, month };
}

export function addMonths(year: number, month: number, delta: number): { year: number; month: number } {
  const index = year * 12 + (month - 1) + delta;
  return { year: Math.floor(index / 12), month: (index % 12) + 1 };
}

export const NORWEGIAN_MONTHS = [
  "januar",
  "februar",
  "mars",
  "april",
  "mai",
  "juni",
  "juli",
  "august",
  "september",
  "oktober",
  "november",
  "desember",
] as const;

const pad2 = (value: number) => String(value).padStart(2, "0");

/** "21.09.2026 kl. 10:14" in the shop's zone. */
export function formatZonedDateTime(instant: Date, timeZone: string): string {
  const p = zonedParts(instant, timeZone);
  return `${pad2(p.day)}.${pad2(p.month)}.${p.year} kl. ${pad2(p.hour)}:${pad2(p.minute)}`;
}

/** "21.09.2026" in the shop's zone. */
export function formatZonedDate(instant: Date, timeZone: string): string {
  const p = zonedParts(instant, timeZone);
  return `${pad2(p.day)}.${pad2(p.month)}.${p.year}`;
}
