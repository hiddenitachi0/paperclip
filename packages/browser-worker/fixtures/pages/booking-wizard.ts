import { page } from "../layout.js";

/**
 * A three-step free (no-deposit) booking flow: dates -> guest details ->
 * review-and-confirm. The final step's submit button uses Norwegian
 * final-action wording ("Bekreft bestilling") deliberately, so a test can
 * assert the worker's evaluateFinalActionRisk() refuses a raw click/Enter
 * on it and instead requires request_booking (design step 4: "Every
 * booking, including free ones with no deposit, needs Filip's approval").
 * No payment field anywhere in this fixture -- see fixtures/pages/shop.ts
 * for the payment-provider-iframe fixture.
 */
export function bookingWizardStep1(): string {
  return page(
    "Fjord View Cabins — Book your stay",
    `
    <h1>Fjord View Cabins</h1>
    <form method="get" action="/booking-wizard/step-2">
      <label>Check-in <input type="date" name="checkin" required /></label>
      <label>Check-out <input type="date" name="checkout" required /></label>
      <label>Guests <input type="number" name="guests" value="2" min="1" max="6" /></label>
      <button type="submit">Next</button>
    </form>
    `,
  );
}

export function bookingWizardStep2(): string {
  return page(
    "Fjord View Cabins — Your details",
    `
    <h1>Your details</h1>
    <form method="get" action="/booking-wizard/step-3">
      <label>Full name <input type="text" name="name" autocomplete="name" required /></label>
      <label>Email <input type="email" name="email" autocomplete="email" required /></label>
      <label>Phone <input type="tel" name="phone" autocomplete="tel" /></label>
      <button type="submit">Next</button>
    </form>
    `,
  );
}

export function bookingWizardStep3(params: { checkin?: string; checkout?: string; guests?: string; name?: string }): string {
  return page(
    "Fjord View Cabins — Review your booking",
    `
    <h1>Review your booking</h1>
    <dl>
      <dt>Cabin</dt><dd>Fjordutsikt Hytte 3</dd>
      <dt>Check-in</dt><dd>${escapeHtml(params.checkin ?? "")}</dd>
      <dt>Check-out</dt><dd>${escapeHtml(params.checkout ?? "")}</dd>
      <dt>Guests</dt><dd>${escapeHtml(params.guests ?? "")}</dd>
      <dt>Name</dt><dd>${escapeHtml(params.name ?? "")}</dd>
      <dt>Price</dt><dd>No deposit required — pay at check-in</dd>
    </dl>
    <form method="get" action="/booking-wizard/confirm">
      <button type="submit">Bekreft bestilling</button>
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
