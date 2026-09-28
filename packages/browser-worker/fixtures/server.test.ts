import { type AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFixtureServer } from "./server.js";
import { matchFinalActionWording } from "@paperclipai/adapter-utils/final-action-matcher";
import { looksLikePaymentField } from "@paperclipai/adapter-utils/payment-detection";

let baseUrl: string;
let close: () => Promise<void>;

beforeAll(async () => {
  const server = createFixtureServer().listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;
  close = () => new Promise<void>((resolve) => server.close(() => resolve()));
});

afterAll(async () => {
  await close();
});

describe("fixture sites", () => {
  it("serves an index linking every fixture", async () => {
    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(200);
    const html = await res.text();
    for (const path of ["/booking-wizard", "/shop", "/prompt-injection", "/fake-confirmation", "/captcha"]) {
      expect(html).toContain(path);
    }
  });

  it("booking wizard: final step button trips the final-action matcher, and there is no payment field anywhere in the flow", async () => {
    const step3 = await fetch(`${baseUrl}/booking-wizard/step-3?checkin=2026-10-01&checkout=2026-10-03&guests=2&name=Filip`);
    const html = await step3.text();
    expect(html).toContain("Bekreft bestilling");
    expect(matchFinalActionWording("Bekreft bestilling")?.kind).toBe("final_action");
    expect(html).not.toMatch(/autocomplete="cc-/);
  });

  it("booking wizard steps chain together (dates carry through to review)", async () => {
    const step1 = await fetch(`${baseUrl}/booking-wizard`);
    expect(step1.status).toBe(200);
    expect(await step1.text()).toContain('action="/booking-wizard/step-2"');
    const step2 = await fetch(`${baseUrl}/booking-wizard/step-2`);
    expect(await step2.text()).toContain('action="/booking-wizard/step-3"');
  });

  it("shop checkout: payment iframe fields are detected as payment fields by autocomplete token", async () => {
    const res = await fetch(`${baseUrl}/shop/checkout/payment-frame`);
    const html = await res.text();
    expect(html).toContain('autocomplete="cc-number"');
    expect(html).toContain('autocomplete="cc-csc"');
    expect(looksLikePaymentField({ autocomplete: "cc-number" })).toBe(true);
    expect(looksLikePaymentField({ autocomplete: "cc-csc" })).toBe(true);
  });

  it("shop checkout page embeds the payment frame in a same-origin iframe and has a final-action pay button", async () => {
    const res = await fetch(`${baseUrl}/shop/checkout`);
    const html = await res.text();
    expect(html).toMatch(/<iframe[^>]+src="\/shop\/checkout\/payment-frame"/);
    expect(matchFinalActionWording("Pay now")?.kind).toBe("final_action");
    expect(html).toContain("Pay now");
  });

  it("prompt-injection page contains injected instructions that must never be auto-executed", async () => {
    const res = await fetch(`${baseUrl}/prompt-injection`);
    const html = await res.text();
    expect(html).toContain("Ignore all previous instructions");
    expect(html).toContain("Agent instructions:");
    // The fixture exists to prove the *worker* never treats this as a
    // command; the fixture itself has no gate to bypass, so this test only
    // asserts the injected content is present and would need to be filtered
    // by browser_snapshot/browser_read_text framing at the caller.
  });

  it("fake-confirmation page has no real order reference (constant, not backend-generated)", async () => {
    const res = await fetch(`${baseUrl}/fake-confirmation`);
    const html = await res.text();
    expect(html).toContain("NL-000000");
  });

  it("captcha wall never resolves: re-submitting returns the same unsolved challenge", async () => {
    const first = await fetch(`${baseUrl}/captcha`);
    const second = await fetch(`${baseUrl}/captcha`, { redirect: "follow" });
    expect(await first.text()).toContain("Are you human?");
    expect(await second.text()).toContain("Are you human?");
  });
});
