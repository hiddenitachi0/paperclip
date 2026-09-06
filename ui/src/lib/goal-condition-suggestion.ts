/**
 * DUR-72: offers a starting point for the Goal field on the New Task form by pulling a
 * plain-English condition out of the ticket's own description. Deliberately simple —
 * two passes, no NLP:
 *   1. an "acceptance criteria" / "definition of done" style section, if one exists
 *   2. otherwise, the last bullet or numbered list in the description
 * Returns null when neither is found, so callers can fall back to an empty field.
 */

const HEADING_LINE_RE = /^#{1,6}\s+/;
const BULLET_LINE_RE = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/;
const ACCEPTANCE_HEADING_RE = /^(acceptance criteria|acceptance|criteria for (done|completion)|definition of done)\s*:?\s*$/i;

const MAX_SUGGESTION_LENGTH = 400;

function stripHeadingMarkers(line: string): string {
  return line.replace(/^#{1,6}\s*/, "").replace(/\*\*/g, "").trim();
}

function isAcceptanceHeading(line: string): boolean {
  return ACCEPTANCE_HEADING_RE.test(stripHeadingMarkers(line));
}

function truncate(input: string, max = MAX_SUGGESTION_LENGTH): string {
  const trimmed = input.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 1).trimEnd()}…`;
}

function collectBullets(lines: string[]): string[] {
  return lines
    .map((line) => line.match(BULLET_LINE_RE)?.[1]?.trim())
    .filter((value): value is string => Boolean(value));
}

/** Finds an acceptance-criteria-style section and returns its content joined into one line. */
function extractFromAcceptanceSection(lines: string[]): string | null {
  for (let i = 0; i < lines.length; i += 1) {
    if (!isAcceptanceHeading(lines[i]!)) continue;

    const sectionLines: string[] = [];
    for (let j = i + 1; j < lines.length; j += 1) {
      if (HEADING_LINE_RE.test(lines[j]!)) break;
      sectionLines.push(lines[j]!);
    }

    const bullets = collectBullets(sectionLines);
    if (bullets.length > 0) return truncate(bullets.join("; "));

    const nonEmpty = sectionLines.map((line) => line.trim()).filter(Boolean);
    if (nonEmpty.length > 0) return truncate(nonEmpty.join(" "));
  }
  return null;
}

/** Falls back to the last contiguous bullet/numbered list anywhere in the description. */
function extractFromLastBulletList(lines: string[]): string | null {
  let lastList: string[] = [];
  let current: string[] = [];
  for (const line of lines) {
    const bulletMatch = line.match(BULLET_LINE_RE);
    if (bulletMatch) {
      current.push(bulletMatch[1]!.trim());
      continue;
    }
    if (line.trim() === "") continue; // blank lines don't break a list
    if (current.length > 0) lastList = current;
    current = [];
  }
  if (current.length > 0) lastList = current;
  return lastList.length > 0 ? truncate(lastList.join("; ")) : null;
}

export function extractSuggestedGoalCondition(description: string | null | undefined): string | null {
  const text = (description ?? "").trim();
  if (!text) return null;
  const lines = text.split(/\r?\n/);
  return extractFromAcceptanceSection(lines) ?? extractFromLastBulletList(lines);
}
