/**
 * Cards that must be read on their own page before they are approved: a
 * deploy, a wallet payment, a wallet address, a strategy's new rules. A
 * one-tap Approve in a list would let the owner approve one without seeing
 * what it does, so lists show an "Open" link instead.
 *
 * Mirrors isApprovalCardOnlyKind in server/src/services/approvals.ts. The
 * server enforces who may approve; this only decides which button a list
 * row shows. Keep the two lists in step.
 */
const CARD_ONLY_KINDS = new Set([
  "operator_action",
  "deploy",
  "crypto_wallet_tx",
  "crypto_sweep_address",
  "crypto_topup_request",
  "trading_strategy_version",
]);

// Same test the server uses for made-up "deploy_release"-style kinds.
const DEPLOY_LIKE_KIND = /deploy|release|rollout|ship/i;

export function isCardOnlyApproval(
  type: string,
  payload: Record<string, unknown> | null | undefined,
): boolean {
  if (type !== "request_board_approval") return false;
  const kind = payload?.kind;
  if (typeof kind !== "string") return false;
  const normalized = kind.trim();
  if (CARD_ONLY_KINDS.has(kind)) return true;
  return normalized !== "" && normalized !== "deploy" && DEPLOY_LIKE_KIND.test(normalized);
}
