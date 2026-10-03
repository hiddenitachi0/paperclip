// @vitest-environment jsdom

import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CompanySecret, PaymentCardSummary } from "@paperclipai/shared";
import { PaymentsAndLoginsSection } from "./PaymentsAndLoginsSection";

/**
 * Connections → payment cards / website logins (DUR-4020/DUR-4038). Covers: the
 * client-side Luhn check blocking submit with a plain-language message, that a
 * card/password value is never sent back to a text field (type="password", no GET
 * prefill), that the payment-card list (from the payment_cards metadata table,
 * DUR-4040) never renders a card number or CVC — including for a known canary card
 * number — and that Disable / Mark as used up require confirmation and call the
 * right routes.
 */

const COMPANY = "11111111-1111-4111-8111-111111111111";
// A well-known test card number (Visa test PAN). Used only to prove the UI never
// echoes it back anywhere, even if it somehow ended up in a field this component
// reads.
const CANARY_CARD_NUMBER = "4242424242424242";

const mockSecretsApi = vi.hoisted(() => ({ list: vi.fn(), create: vi.fn() }));
const mockPaymentCardsApi = vi.hoisted(() => ({ list: vi.fn(), disable: vi.fn(), markUsedUp: vi.fn() }));
const mockPushToast = vi.hoisted(() => vi.fn());

vi.mock("../api/secrets", () => ({ secretsApi: mockSecretsApi }));
vi.mock("../api/payment-cards", () => ({ paymentCardsApi: mockPaymentCardsApi }));
vi.mock("../context/ToastContext", () => ({
  useToast: () => ({ pushToast: mockPushToast }),
  useToastActions: () => ({ pushToast: mockPushToast }),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function secret(overrides: Partial<CompanySecret> = {}): CompanySecret {
  return {
    id: "33333333-3333-4333-8333-333333333333",
    companyId: COMPANY,
    key: "card__1",
    name: "Hotel card",
    provider: "local_encrypted",
    status: "active",
    managedMode: "paperclip_managed",
    externalRef: null,
    providerConfigId: null,
    providerMetadata: { brand: "Visa", last4: "4242" },
    latestVersion: 1,
    description: null,
    kind: "payment_card_single_use",
    lastTestAt: null,
    lastTestOk: null,
    lastTestMessage: null,
    lastResolvedAt: null,
    lastRotatedAt: null,
    deletedAt: null,
    createdByAgentId: null,
    createdByUserId: null,
    createdAt: new Date("2026-09-20T00:00:00Z"),
    updatedAt: new Date("2026-09-20T00:00:00Z"),
    ...overrides,
  };
}

function paymentCard(overrides: Partial<PaymentCardSummary> = {}): PaymentCardSummary {
  return {
    id: "44444444-4444-4444-8444-444444444444",
    companyId: COMPANY,
    secretId: "33333333-3333-4333-8333-333333333333",
    label: "Hotel booking card",
    brand: "Visa",
    last4: "4242",
    currency: "NOK",
    loadedAmountCents: 150000,
    remainingAmountCents: 150000,
    singleUse: true,
    status: "available",
    expiresOn: "2027-06-30",
    allowedAgentIds: [],
    reservedForClearanceId: null,
    reservedAt: null,
    usedAt: null,
    usedByPurchaseId: null,
    disabledAt: null,
    disabledReason: null,
    createdAt: "2026-09-20T00:00:00Z",
    updatedAt: "2026-09-20T00:00:00Z",
    ...overrides,
  };
}

async function act(callback: () => void | Promise<void>) {
  await callback();
  await Promise.resolve();
  await new Promise((resolve) => window.setTimeout(resolve, 0));
}

async function flushReact() {
  for (let i = 0; i < 3; i += 1) {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  }
}

function fire(el: HTMLInputElement | HTMLSelectElement, value: string) {
  const proto = el instanceof HTMLSelectElement ? window.HTMLSelectElement.prototype : window.HTMLInputElement.prototype;
  const valueSetter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  valueSetter?.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

describe("PaymentsAndLoginsSection", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockPaymentCardsApi.list.mockResolvedValue([]);
    mockSecretsApi.list.mockResolvedValue([]);
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  async function render(node: React.ReactNode) {
    const root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(<QueryClientProvider client={queryClient}>{node}</QueryClientProvider>);
    });
    await flushReact();
    return root;
  }

  it("shows label, brand, last4, amounts, status and expiry for a saved card, never the card number", async () => {
    mockPaymentCardsApi.list.mockResolvedValue([paymentCard()]);
    const root = await render(<PaymentsAndLoginsSection companyId={COMPANY} readOnly={false} />);
    const cardCard = container.querySelector('[data-testid="connections-payment-cards"]');
    expect(cardCard?.textContent).toContain("Hotel booking card");
    expect(cardCard?.textContent).toContain("Visa ending 4242");
    expect(cardCard?.textContent).toContain("Available");
    expect(cardCard?.textContent).toMatch(/left of/);
    expect(cardCard?.textContent).toContain("Expires 30 Jun 2027");
    expect(cardCard?.textContent).not.toMatch(/\d{13,19}/);
    expect(document.body.textContent).not.toContain(CANARY_CARD_NUMBER);
    await act(async () => {
      root.unmount();
    });
  });

  it("never renders a canary card number anywhere on the page even across many cards", async () => {
    mockPaymentCardsApi.list.mockResolvedValue([
      paymentCard({ id: "a", label: "Card A", last4: "4242" }),
      paymentCard({ id: "b", label: "Card B", last4: "1111", status: "used" }),
      paymentCard({ id: "c", label: "Card C", last4: "0005", status: "disabled" }),
    ]);
    const root = await render(<PaymentsAndLoginsSection companyId={COMPANY} readOnly={false} />);
    expect(document.body.textContent).not.toContain(CANARY_CARD_NUMBER);
    expect(document.body.textContent).not.toMatch(/\d{13,19}/);
    await act(async () => {
      root.unmount();
    });
  });

  it("disables a card only after the operator confirms, then calls the disable route", async () => {
    const card = paymentCard();
    mockPaymentCardsApi.list.mockResolvedValue([card]);
    mockPaymentCardsApi.disable.mockResolvedValue({ ...card, status: "disabled" });
    const root = await render(<PaymentsAndLoginsSection companyId={COMPANY} readOnly={false} />);

    const disableButton = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Disable")!;
    await act(async () => {
      disableButton.click();
    });
    await flushReact();

    expect(mockPaymentCardsApi.disable).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Disable this card?");

    const confirm = Array.from(document.querySelectorAll("button")).find((b) => b.textContent === "Disable card")!;
    await act(async () => {
      confirm.click();
    });
    await flushReact();

    expect(mockPaymentCardsApi.disable).toHaveBeenCalledWith(COMPANY, card.id);
    await act(async () => {
      root.unmount();
    });
  });

  it("marks a card as used up only after confirmation, then calls the mark-used-up route", async () => {
    const card = paymentCard();
    mockPaymentCardsApi.list.mockResolvedValue([card]);
    mockPaymentCardsApi.markUsedUp.mockResolvedValue({ ...card, status: "used" });
    const root = await render(<PaymentsAndLoginsSection companyId={COMPANY} readOnly={false} />);

    const markButton = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent === "Mark as used up",
    )!;
    await act(async () => {
      markButton.click();
    });
    await flushReact();

    expect(mockPaymentCardsApi.markUsedUp).not.toHaveBeenCalled();

    // The confirm button in the dialog shares its label with the row's own trigger
    // button, so take the last match (the dialog renders after the row).
    const confirmButtons = Array.from(document.querySelectorAll("button")).filter(
      (b) => b.textContent === "Mark as used up",
    );
    await act(async () => {
      confirmButtons[confirmButtons.length - 1].click();
    });
    await flushReact();

    expect(mockPaymentCardsApi.markUsedUp).toHaveBeenCalledWith(COMPANY, card.id);
    await act(async () => {
      root.unmount();
    });
  });

  it("hides Mark as used up for a disabled card, and hides Disable for an already-disabled card", async () => {
    mockPaymentCardsApi.list.mockResolvedValue([paymentCard({ status: "disabled" })]);
    const root = await render(<PaymentsAndLoginsSection companyId={COMPANY} readOnly={false} />);
    const cardCard = container.querySelector('[data-testid="connections-payment-cards"]');
    expect(Array.from(cardCard!.querySelectorAll("button")).some((b) => b.textContent === "Disable")).toBe(false);
    expect(Array.from(cardCard!.querySelectorAll("button")).some((b) => b.textContent === "Mark as used up")).toBe(
      false,
    );
    await act(async () => {
      root.unmount();
    });
  });

  it("blocks submit on a bad card checksum with the plain-language error, not a generic message", async () => {
    const root = await render(<PaymentsAndLoginsSection companyId={COMPANY} readOnly={false} />);

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="connections-payment-cards"] button')!.click();
    });
    await flushReact();

    const cardNumberInput = document.getElementById("card-number") as HTMLInputElement;
    expect(cardNumberInput.type).toBe("password");
    await act(async () => {
      fire(cardNumberInput, "4242424242424241");
      cardNumberInput.focus();
      cardNumberInput.blur();
    });
    await flushReact();

    expect(document.body.textContent).toContain("That card number doesn't look right. Please check it and try again.");
    const submit = Array.from(document.querySelectorAll("button")).find((b) => b.textContent === "Save card");
    expect(submit?.disabled).toBe(true);
    expect(mockSecretsApi.create).not.toHaveBeenCalled();
    await act(async () => {
      root.unmount();
    });
  });

  it("saves a valid card as label/kind + opaque value, keeping only brand/last4 as metadata", async () => {
    mockSecretsApi.create.mockResolvedValue(secret());
    const root = await render(<PaymentsAndLoginsSection companyId={COMPANY} readOnly={false} />);

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="connections-payment-cards"] button')!.click();
    });
    await flushReact();

    fire(document.getElementById("card-label") as HTMLInputElement, "Hotel card");
    fire(document.getElementById("card-number") as HTMLInputElement, "4242 4242 4242 4242");
    fire(document.getElementById("card-exp-month") as HTMLSelectElement, "09");
    fire(document.getElementById("card-exp-year") as HTMLSelectElement, "2030");
    fire(document.getElementById("card-cvc") as HTMLInputElement, "123");
    fire(document.getElementById("card-name") as HTMLInputElement, "F Filip");
    fire(document.getElementById("card-postal") as HTMLInputElement, "0150");
    await flushReact();

    const submit = Array.from(document.querySelectorAll("button")).find((b) => b.textContent === "Save card")!;
    expect(submit.disabled).toBe(false);
    await act(async () => {
      submit.click();
    });
    await flushReact();

    expect(mockSecretsApi.create).toHaveBeenCalledTimes(1);
    const payload = mockSecretsApi.create.mock.calls[0][1];
    expect(payload.name).toBe("Hotel card");
    expect(payload.kind).toBe("payment_card_single_use");
    expect(payload.providerMetadata).toEqual({ brand: "Visa", last4: "4242" });
    const stored = JSON.parse(payload.value);
    expect(stored).toEqual({
      cardNumber: "4242424242424242",
      expMonth: "09",
      expYear: "2030",
      cvc: "123",
      nameOnCard: "F Filip",
      postalCode: "0150",
    });
    await act(async () => {
      root.unmount();
    });
  });

  it("saves a website login with the password only in the opaque value, site in metadata", async () => {
    mockSecretsApi.create.mockResolvedValue(secret({ kind: "site_login" }));
    const root = await render(<PaymentsAndLoginsSection companyId={COMPANY} readOnly={false} />);

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="connections-site-logins"] button')!.click();
    });
    await flushReact();

    const passwordInput = document.getElementById("login-password") as HTMLInputElement;
    expect(passwordInput.type).toBe("password");
    fire(document.getElementById("login-label") as HTMLInputElement, "Hotel account");
    fire(document.getElementById("login-site") as HTMLInputElement, "hotel.example.com");
    fire(document.getElementById("login-username") as HTMLInputElement, "filip");
    fire(passwordInput, "hunter2");
    await flushReact();

    const submit = Array.from(document.querySelectorAll("button")).find((b) => b.textContent === "Save login")!;
    expect(submit.disabled).toBe(false);
    await act(async () => {
      submit.click();
    });
    await flushReact();

    expect(mockSecretsApi.create).toHaveBeenCalledTimes(1);
    const payload = mockSecretsApi.create.mock.calls[0][1];
    expect(payload.kind).toBe("site_login");
    expect(payload.providerMetadata).toEqual({ site: "hotel.example.com" });
    expect(JSON.parse(payload.value)).toEqual({ username: "filip", password: "hunter2" });
    await act(async () => {
      root.unmount();
    });
  });

  it("is read-only for a non-manager: no Add buttons, no dialogs, no card action buttons", async () => {
    mockPaymentCardsApi.list.mockResolvedValue([paymentCard()]);
    mockSecretsApi.list.mockResolvedValue([secret({ kind: "site_login", name: "Hotel account" })]);
    const root = await render(<PaymentsAndLoginsSection companyId={COMPANY} readOnly />);
    const cardCard = container.querySelector('[data-testid="connections-payment-cards"]');
    expect(cardCard?.querySelector("button")).toBeNull();
    expect(container.querySelector('[data-testid="connections-site-logins"] button')).toBeNull();
    await act(async () => {
      root.unmount();
    });
  });
});
