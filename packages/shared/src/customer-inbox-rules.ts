/**
 * DUR-68: Filip's customer-inbox sorting rules live in a fenced block inside
 * the secretary's AGENTS.md, between these literal markers. Shared between
 * the server (validates rule names on save) and the UI (the Sorteringsregler
 * editor box) so the marker format and block-extraction logic can't drift
 * between the two.
 */
export const SORTERINGSREGLER_START_MARKER = "<!-- SORTERINGSREGLER -->";
export const SORTERINGSREGLER_END_MARKER = "<!-- /SORTERINGSREGLER -->";

export function extractSorteringsreglerBlock(content: string): string | null {
  const startIdx = content.indexOf(SORTERINGSREGLER_START_MARKER);
  const endIdx = content.indexOf(SORTERINGSREGLER_END_MARKER);
  if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) return null;
  return content.slice(startIdx + SORTERINGSREGLER_START_MARKER.length, endIdx).trim();
}

export function withSorteringsreglerBlock(content: string, rules: string): string {
  const block = `${SORTERINGSREGLER_START_MARKER}\n${rules.trim()}\n${SORTERINGSREGLER_END_MARKER}`;
  const startIdx = content.indexOf(SORTERINGSREGLER_START_MARKER);
  const endIdx = content.indexOf(SORTERINGSREGLER_END_MARKER);
  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    return content.slice(0, startIdx) + block + content.slice(endIdx + SORTERINGSREGLER_END_MARKER.length);
  }
  const separator = content.trim().length > 0 ? "\n\n" : "";
  return `${content}${separator}${block}\n`;
}

/** One rule per line, each ending in the name of the agent it routes to (after the line's last colon). */
export function parseSorteringsreglerRuleTargetNames(block: string): { ruleIndex: number; name: string }[] {
  const lines = block.split("\n").map((line) => line.trim()).filter((line) => line.length > 0);
  const rules: { ruleIndex: number; name: string }[] = [];
  lines.forEach((line, index) => {
    const lastColon = line.lastIndexOf(":");
    if (lastColon === -1) return;
    const name = line.slice(lastColon + 1).trim().replace(/[.\s]+$/, "");
    if (!name) return;
    rules.push({ ruleIndex: index + 1, name });
  });
  return rules;
}
