import { describe, expect, it, vi } from "vitest";
import { BrowserToolHandler, type AccessibilitySnapshot, type BrowserDriver, type ElementDescriptor } from "./tools.js";

const EMPTY_SNAPSHOT: AccessibilitySnapshot = { tree: "", url: "https://example.com", title: "" };

function fakeDriver(overrides: Partial<BrowserDriver> = {}): BrowserDriver {
  return {
    navigate: vi.fn(async () => EMPTY_SNAPSHOT),
    snapshot: vi.fn(async () => EMPTY_SNAPSHOT),
    readText: vi.fn(async () => ""),
    describeElement: vi.fn(async () => null),
    performClick: vi.fn(async () => EMPTY_SNAPSHOT),
    performType: vi.fn(async () => EMPTY_SNAPSHOT),
    performSelect: vi.fn(async () => EMPTY_SNAPSHOT),
    performCheck: vi.fn(async () => EMPTY_SNAPSHOT),
    focusedFormSubmitTarget: vi.fn(async () => null),
    performPressKey: vi.fn(async () => EMPTY_SNAPSHOT),
    screenshot: vi.fn(async () => new Uint8Array()),
    wait: vi.fn(async () => undefined),
    back: vi.fn(async () => EMPTY_SNAPSHOT),
    close: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe("BrowserToolHandler.navigate", () => {
  it("refuses a non-https URL before reaching the driver", async () => {
    const driver = fakeDriver();
    const handler = new BrowserToolHandler(driver);
    await expect(handler.navigate("http://example.com")).rejects.toThrow(/https/);
    expect(driver.navigate).not.toHaveBeenCalled();
  });

  it("allows an https URL", async () => {
    const driver = fakeDriver();
    const handler = new BrowserToolHandler(driver);
    await handler.navigate("https://example.com");
    expect(driver.navigate).toHaveBeenCalledWith("https://example.com");
  });
});

describe("BrowserToolHandler.click", () => {
  it("refuses a click on a final-action-worded element without calling performClick", async () => {
    const descriptor: ElementDescriptor = { ref: "e1", role: "button", name: "Bekreft" };
    const driver = fakeDriver({ describeElement: vi.fn(async () => descriptor) });
    const handler = new BrowserToolHandler(driver);
    const outcome = await handler.click("e1", "finishing the booking");
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.refusal.reason).toBe("final_action_wording");
    expect(driver.performClick).not.toHaveBeenCalled();
  });

  it("refuses a generic submit inside a payment form", async () => {
    const descriptor: ElementDescriptor = { ref: "e2", role: "button", name: "Next", isFormSubmit: true, formHasPaymentField: true };
    const driver = fakeDriver({ describeElement: vi.fn(async () => descriptor) });
    const handler = new BrowserToolHandler(driver);
    const outcome = await handler.click("e2", "next step");
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.refusal.reason).toBe("submit_in_payment_form");
  });

  it("allows an ordinary click", async () => {
    const descriptor: ElementDescriptor = { ref: "e3", role: "link", name: "View details" };
    const driver = fakeDriver({ describeElement: vi.fn(async () => descriptor) });
    const handler = new BrowserToolHandler(driver);
    const outcome = await handler.click("e3", "read more");
    expect(outcome.ok).toBe(true);
    expect(driver.performClick).toHaveBeenCalledWith("e3");
  });

  it("throws (does not silently allow) when the ref does not resolve to a real element", async () => {
    const driver = fakeDriver();
    const handler = new BrowserToolHandler(driver);
    await expect(handler.click("unknown", "why")).rejects.toThrow(/Unknown element ref/);
    expect(driver.performClick).not.toHaveBeenCalled();
  });
});

describe("BrowserToolHandler.type", () => {
  it("throws (does not silently allow) when the ref does not resolve to a real element", async () => {
    const driver = fakeDriver();
    const handler = new BrowserToolHandler(driver);
    await expect(handler.type("unknown", "hello")).rejects.toThrow(/Unknown element ref/);
    expect(driver.performType).not.toHaveBeenCalled();
  });

  it("refuses typing a card number", async () => {
    const descriptor: ElementDescriptor = { ref: "e1", role: "textbox", name: "Notes" };
    const driver = fakeDriver({ describeElement: vi.fn(async () => descriptor) });
    const handler = new BrowserToolHandler(driver);
    const outcome = await handler.type("e1", "4242424242424242");
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.refusal.reason).toBe("card_number_in_text");
    expect(driver.performType).not.toHaveBeenCalled();
  });

  it("refuses typing into a payment field even with safe text", async () => {
    const descriptor: ElementDescriptor = { ref: "e2", role: "textbox", name: "", autocomplete: "cc-csc" };
    const driver = fakeDriver({ describeElement: vi.fn(async () => descriptor) });
    const handler = new BrowserToolHandler(driver);
    const outcome = await handler.type("e2", "123");
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.refusal.reason).toBe("payment_field");
  });

  it("allows typing ordinary text into an ordinary field", async () => {
    const descriptor: ElementDescriptor = { ref: "e3", role: "textbox", name: "City" };
    const driver = fakeDriver({ describeElement: vi.fn(async () => descriptor) });
    const handler = new BrowserToolHandler(driver);
    const outcome = await handler.type("e3", "Oslo");
    expect(outcome.ok).toBe(true);
    expect(driver.performType).toHaveBeenCalledWith("e3", "Oslo");
  });
});

describe("BrowserToolHandler.pressKey", () => {
  it("refuses Enter when the focused form's submit target is final-action-worded", async () => {
    const target: ElementDescriptor = { ref: "e1", role: "button", name: "Fullfør kjøp", isFormSubmit: true };
    const driver = fakeDriver({ focusedFormSubmitTarget: vi.fn(async () => target) });
    const handler = new BrowserToolHandler(driver);
    const outcome = await handler.pressKey("Enter");
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.refusal.reason).toBe("final_action_wording");
    expect(driver.performPressKey).not.toHaveBeenCalled();
  });

  it("allows Enter when there is no risky focused form target", async () => {
    const driver = fakeDriver();
    const handler = new BrowserToolHandler(driver);
    const outcome = await handler.pressKey("Enter");
    expect(outcome.ok).toBe(true);
    expect(driver.performPressKey).toHaveBeenCalledWith("Enter");
  });

  it("allows non-Enter keys without checking the form target at all", async () => {
    const driver = fakeDriver();
    const handler = new BrowserToolHandler(driver);
    await handler.pressKey("Tab");
    expect(driver.focusedFormSubmitTarget).not.toHaveBeenCalled();
    expect(driver.performPressKey).toHaveBeenCalledWith("Tab");
  });
});
