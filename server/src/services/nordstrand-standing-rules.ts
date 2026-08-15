/**
 * Canonical seed content for Nordstrand Gruppen's (company a80a8afe-9c51-4767-ace0-1f39aae6ea0d)
 * nine standing rules (DUR-33). This is the single source of truth for the rule text so the
 * short block in COMPANY.md and the long block in the `nordstrand-standing-rules` company skill
 * can never drift apart — both are built from STANDING_RULES_BLOCK below, and a drift-guard test
 * asserts they stay byte-identical.
 *
 * Wording is operator-owned: rules 1, 2, 4, 7, and 8 have no exception path; rules 3, 5, 6, and 9
 * bend only on an explicit written decision from the operator, recorded on the ticket.
 */

export const NORDSTRAND_COMPANY_ID = "a80a8afe-9c51-4767-ace0-1f39aae6ea0d";

export const STANDING_RULES_BLOCK_START_MARKER = "<!-- nordstrand-standing-rules:start -->";
export const STANDING_RULES_BLOCK_END_MARKER = "<!-- nordstrand-standing-rules:end -->";

/** The nine rules, copied byte-for-byte from DUR-33. Not summarised, not renumbered. */
export const STANDING_RULES_BLOCK = [
  "1. One integration per external system.",
  "2. Companies are data, not code.",
  "3. Plain Norwegian to the operator.",
  "4. No personal data or account numbers in output.",
  "5. Definitions are the operator's to rule.",
  "6. Never guess.",
  "7. Shopify «salg» is not accounting «inntekt».",
  "8. No intercompany elimination — cost + 30% invoicing IS the business model.",
  "9. Discounted and B-grade sales are their own dimension and never fall into a margin denominator.",
].join("\n");

export function wrapStandingRulesBlock(): string {
  return `${STANDING_RULES_BLOCK_START_MARKER}\n${STANDING_RULES_BLOCK}\n${STANDING_RULES_BLOCK_END_MARKER}`;
}

/** Extracts the marker-delimited rules block from a larger markdown document. Null if absent. */
export function extractStandingRulesBlock(markdown: string): string | null {
  const startIndex = markdown.indexOf(STANDING_RULES_BLOCK_START_MARKER);
  const endIndex = markdown.indexOf(STANDING_RULES_BLOCK_END_MARKER);
  if (startIndex === -1 || endIndex === -1 || endIndex < startIndex) return null;
  return markdown.slice(startIndex, endIndex + STANDING_RULES_BLOCK_END_MARKER.length);
}

export function buildNordstrandCompanyInstructionsMarkdown(): string {
  return [
    "# Nordstrand Gruppen — standing rules",
    "",
    "These are the nine standing rules every agent in this company follows on every run, on",
    "top of that agent's own role instructions (AGENTS.md). They travel with this company if",
    "it is ever lifted onto its own server.",
    "",
    "Rules 1, 2, 4, 7, and 8 have no exception path. Rules 3, 5, 6, and 9 bend only on an",
    "explicit written decision from the operator, recorded on the relevant ticket.",
    "",
    wrapStandingRulesBlock(),
    "",
    "For the full rationale behind each rule, see the `nordstrand-standing-rules` company skill.",
    "",
  ].join("\n");
}

export function buildNordstrandStandingRulesSkillMarkdown(): string {
  return [
    "---",
    "name: Nordstrand standing rules",
    "description: The nine non-negotiable (or operator-only-exception) rules every Nordstrand agent follows on every run. Long-form rationale for the short block in COMPANY.md.",
    "---",
    "",
    "# Nordstrand standing rules",
    "",
    "This is the long form of the nine rules seeded into this company's COMPANY.md, which every",
    "agent gets prepended ahead of its own AGENTS.md on every run. Skills are lazy-loaded (only",
    "name and description sit in context until an agent opens this file), which is exactly why the",
    "short form of these rules must ALSO live in COMPANY.md — a rule that lives only here can be",
    "violated without ever being read.",
    "",
    wrapStandingRulesBlock(),
    "",
    "## Why each rule exists",
    "",
    "1. **One integration per external system.** The Fiken login has been stored twice and the",
    "   Shopify connection rebuilt by hand in five places. One client, one set of credentials, one",
    "   place to fix a bug. No exception path.",
    "2. **Companies are data, not code.** Nordstrand (and any company after it) must never be",
    "   hard-coded into shared logic — today that mistake is repeated in roughly eighty places.",
    "   Company-specific behavior belongs in company config/data, not in module source. No",
    "   exception path.",
    "3. **Plain Norwegian to the operator.** The operator reads Norwegian, not agent-speak. Bends",
    "   only on an explicit written operator decision, recorded on the ticket.",
    "4. **No personal data or account numbers in output.** Customer names, personal numbers, bank",
    "   account numbers never appear in agent output, logs, or messages. No exception path.",
    "5. **Definitions are the operator's to rule.** When a term's meaning is ambiguous (a KPI, a",
    "   status, a business rule), the operator decides — don't invent a definition. Bends only on",
    "   an explicit written operator decision, recorded on the ticket.",
    "6. **Never guess.** If a number, a fact, or a state is unknown, say so and ask — don't",
    "   fabricate a plausible-looking answer. Bends only on an explicit written operator decision,",
    "   recorded on the ticket.",
    "7. **Shopify «salg» is not accounting «inntekt».** Shopify's \"sales\" figure and Fiken's",
    "   recognized \"revenue\" are different numbers measuring different things; never substitute",
    "   one for the other in a report. No exception path.",
    "8. **No intercompany elimination — cost + 30% invoicing IS the business model.** Unlike a",
    "   normal group consolidation, Nordstrand's inter-company invoicing at cost-plus-30% is the",
    "   real business model, not a bookkeeping artifact to eliminate. No exception path.",
    "9. **Discounted and B-grade sales are their own dimension and never fall into a margin",
    "   denominator.** Mixing discounted/B-grade sales into a margin calculation's denominator",
    "   silently distorts every margin figure downstream; keep them a separate, explicit",
    "   dimension. Bends only on an explicit written operator decision, recorded on the ticket.",
    "",
  ].join("\n");
}
