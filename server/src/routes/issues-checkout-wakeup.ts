type CheckoutWakeInput = {
  // "service" (DUR-3977) never reaches checkout; widened for type soundness.
  actorType: "board" | "agent" | "board_delegate" | "service" | "none";
  actorAgentId: string | null;
  checkoutAgentId: string;
  checkoutRunId: string | null;
};

export function shouldWakeAssigneeOnCheckout(input: CheckoutWakeInput): boolean {
  if (input.actorType !== "agent") return true;
  if (!input.actorAgentId) return true;
  if (input.actorAgentId !== input.checkoutAgentId) return true;
  if (!input.checkoutRunId) return true;
  return false;
}
