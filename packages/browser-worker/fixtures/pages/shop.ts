import { page } from "../layout.js";

/**
 * A shop checkout whose card form lives in a same-origin iframe, the way a
 * real Stripe/Adyen/Nets Easy "Elements"-style embed does. Field
 * autocomplete tokens match the HTML spec exactly (cc-number/cc-exp/cc-csc),
 * so payment-detection.ts's looksLikePaymentField() is exercised against
 * markup shaped like the real thing, not a hand-picked test string. The pay
 * button uses English final-action wording ("Pay now") for the same reason.
 */
export function shopHome(): string {
  return page(
    "Nordlys Gear — Shop",
    `
    <h1>Nordlys Gear</h1>
    <ul>
      <li>Wool beanie — 249 NOK <a href="/shop/cart?item=beanie">Add to cart</a></li>
      <li>Trail poles — 899 NOK <a href="/shop/cart?item=poles">Add to cart</a></li>
    </ul>
    `,
  );
}

export function shopCart(item: string | undefined): string {
  return page(
    "Nordlys Gear — Cart",
    `
    <h1>Your cart</h1>
    <p>Item: ${escapeHtml(item ?? "beanie")}</p>
    <a href="/shop/checkout">Go to checkout</a>
    `,
  );
}

export function shopCheckout(): string {
  return page(
    "Nordlys Gear — Checkout",
    `
    <h1>Checkout</h1>
    <form method="get" action="/shop/checkout/confirm">
      <label>Shipping name <input type="text" name="name" autocomplete="name" /></label>
      <label>Email <input type="email" name="email" autocomplete="email" /></label>
      <h2>Payment</h2>
      <iframe src="/shop/checkout/payment-frame" title="Payment" width="400" height="220"></iframe>
      <button type="submit">Pay now</button>
    </form>
    `,
  );
}

/** Served on its own origin path so it behaves like a provider-hosted iframe would in a real checkout. */
export function shopPaymentFrame(): string {
  return page(
    "Secure payment",
    `
    <form>
      <label>Card number <input type="text" name="cardNumber" autocomplete="cc-number" inputmode="numeric" /></label>
      <label>Name on card <input type="text" name="cardName" autocomplete="cc-name" /></label>
      <label>Expiry <input type="text" name="cardExpiry" autocomplete="cc-exp" placeholder="MM/YY" /></label>
      <label>CVC <input type="text" name="cardCvc" autocomplete="cc-csc" inputmode="numeric" /></label>
    </form>
    `,
  );
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
