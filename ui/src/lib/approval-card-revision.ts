/**
 * The deploy card revision shown to the person (payload.cardRevision), or undefined when the
 * card has none. Sent back on approve so a card that changed after the person opened it is
 * refused instead of approved unseen.
 */
export function approvalCardRevision(approval: { payload?: Record<string, unknown> | null }): number | undefined {
  const value = approval.payload?.cardRevision;
  return typeof value === "number" && Number.isInteger(value) && value >= 1 ? value : undefined;
}
