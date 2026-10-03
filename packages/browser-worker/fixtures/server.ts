/**
 * DUR-4013: local fixture sites for testing the browser worker (its
 * final-action refusal matrix, payment-field detection, prompt-injection
 * framing, outcome verification and hand-over behaviour) without touching
 * the real internet. Five sites per the design:
 *
 *  - /booking-wizard  a free-booking flow with no payment field
 *  - /shop            a checkout with a same-origin payment-provider iframe
 *  - /prompt-injection a page that tries to instruct the agent directly
 *  - /fake-confirmation a look-alike "order confirmed" page reached with no real order
 *  - /captcha         an unsolvable bot-check wall
 *
 * Deliberately server-rendered with plain forms/links (no client JS) so
 * these fixtures work the same whether hit with a real browser, Playwright,
 * or a plain HTTP client in a unit test.
 */

import express, { type Express } from "express";
import { page } from "./layout.js";
import { bookingWizardStep1, bookingWizardStep2, bookingWizardStep3 } from "./pages/booking-wizard.js";
import { captchaPage } from "./pages/captcha.js";
import { fakeConfirmationPage } from "./pages/fake-confirmation.js";
import { promptInjectionPage } from "./pages/prompt-injection.js";
import { shopCart, shopCheckout, shopHome, shopPaymentFrame } from "./pages/shop.js";

export function createFixtureServer(): Express {
  const app = express();

  app.get("/", (_req, res) => {
    res.type("html").send(
      page(
        "Browser worker fixtures",
        `
        <h1>Browser worker fixtures</h1>
        <ul>
          <li><a href="/booking-wizard">Booking wizard (free booking, no payment field)</a></li>
          <li><a href="/shop">Shop (payment-provider iframe)</a></li>
          <li><a href="/prompt-injection">Prompt-injection page</a></li>
          <li><a href="/fake-confirmation">Fake confirmation page</a></li>
          <li><a href="/captcha">Captcha wall</a></li>
        </ul>
        `,
      ),
    );
  });

  app.get("/booking-wizard", (_req, res) => res.type("html").send(bookingWizardStep1()));
  app.get("/booking-wizard/step-2", (_req, res) => res.type("html").send(bookingWizardStep2()));
  app.get("/booking-wizard/step-3", (req, res) => {
    const q = req.query as Record<string, string | undefined>;
    res.type("html").send(bookingWizardStep3({ checkin: q.checkin, checkout: q.checkout, guests: q.guests, name: q.name }));
  });
  app.get("/booking-wizard/confirm", (_req, res) => res.type("html").send(fakeConfirmationPage()));

  app.get("/shop", (_req, res) => res.type("html").send(shopHome()));
  app.get("/shop/cart", (req, res) => res.type("html").send(shopCart(req.query.item as string | undefined)));
  app.get("/shop/checkout", (_req, res) => res.type("html").send(shopCheckout()));
  app.get("/shop/checkout/payment-frame", (_req, res) => res.type("html").send(shopPaymentFrame()));
  app.get("/shop/checkout/confirm", (_req, res) => res.type("html").send(fakeConfirmationPage()));

  app.get("/prompt-injection", (_req, res) => res.type("html").send(promptInjectionPage()));
  app.get("/fake-confirmation", (_req, res) => res.type("html").send(fakeConfirmationPage()));
  app.get("/captcha", (_req, res) => res.type("html").send(captchaPage()));

  return app;
}

const isMain = (() => {
  const entry = process.argv[1];
  return Boolean(entry) && import.meta.url === `file://${entry}`;
})();

if (isMain) {
  const port = Number(process.env.PAPERCLIP_BROWSER_FIXTURES_PORT ?? 3129);
  createFixtureServer().listen(port, () => {
    // eslint-disable-next-line no-console -- this process has no other log sink
    console.log(`browser-worker fixtures listening on :${port}`);
  });
}
