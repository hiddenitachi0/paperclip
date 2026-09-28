import { page } from "../layout.js";

/**
 * Looks like a real order-confirmation page but was reached without ever
 * going through a real checkout -- the fixture for the design's outcome-
 * verification rule (step 6/7): "success only on provider response or
 * redirect to a confirmation URL on the cleared domain with an order
 * reference, else 'unverified'". This page has an order-reference-shaped
 * string, but it is not a redirect target the server ever cleared, and the
 * "order id" is a constant, not something a real backend generated --
 * exactly the shape an outcome-verification test needs to prove it does
 * NOT trust page text alone.
 */
export function fakeConfirmationPage(): string {
  return page(
    "Order confirmed",
    `
    <h1>Your order is confirmed!</h1>
    <p>Order reference: NL-000000</p>
    <p>Thank you for your purchase. A receipt has been sent to your email.</p>
    `,
  );
}
