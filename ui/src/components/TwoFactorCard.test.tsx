// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TwoFactorApiError } from "../api/twoFactor";
import { TwoFactorCard } from "./TwoFactorCard";

const api = vi.hoisted(() => ({
  getStatus: vi.fn(),
  startEnrollment: vi.fn(),
  finishEnrollment: vi.fn(),
  regenerateRecoveryCodes: vi.fn(),
  disable: vi.fn(),
}));

vi.mock("../api/twoFactor", async () => {
  const actual = await vi.importActual<typeof import("../api/twoFactor")>("../api/twoFactor");
  return { ...actual, twoFactorApi: api };
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const START = {
  enrollmentToken: "token-1",
  secret: "JBSWY3DPEHPK3PXP",
  otpauthUri: "otpauth://totp/Paperclip:jane@example.com?secret=JBSWY3DPEHPK3PXP&issuer=Paperclip",
  recoveryCodes: ["AAAA-1111", "BBBB-2222"],
};

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

describe("TwoFactorCard", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  async function mount() {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <TwoFactorCard />
        </QueryClientProvider>,
      );
    });
    await flush();
    await flush();
  }

  const button = (label: string) =>
    Array.from(document.body.querySelectorAll("button")).find((b) => b.textContent?.trim() === label) as
      | HTMLButtonElement
      | undefined;

  async function click(el: HTMLElement | undefined) {
    expect(el).toBeDefined();
    await act(async () => {
      el!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();
  }

  async function submitCode(value: string) {
    const input = document.body.querySelector('input[autocomplete="one-time-code"]') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    await act(async () => {
      setter!.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      (input.closest("form") as HTMLFormElement).dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await flush();
    await flush();
  }

  it("shows nothing at all while two-step sign-in is switched off", async () => {
    api.getStatus.mockResolvedValue(null);
    await mount();
    expect(container.textContent).toBe("");
  });

  it("walks through turning it on: a real QR picture, the key, then the backup codes once", async () => {
    api.getStatus.mockResolvedValue({ enabled: false, verificationRequired: false, enabledAt: null, recoveryCodesRemaining: 0 });
    api.startEnrollment.mockResolvedValue(START);
    api.finishEnrollment.mockResolvedValue({ enabled: true });
    await mount();

    expect(container.textContent).toContain("Two-step sign-in is off.");
    await click(button("Turn on"));

    const qr = document.body.querySelector('[data-testid="qr-code"]');
    expect(qr).not.toBeNull();
    await flush();
    // A real drawn picture: an svg with many filled squares, not an empty box.
    expect(qr!.querySelector("svg path")).not.toBeNull();
    expect((document.body.querySelector("#two-factor-setup-key") as HTMLInputElement).value).toBe(START.secret);
    expect(document.body.textContent).not.toContain("AAAA-1111");

    await submitCode("123456");
    expect(api.finishEnrollment).toHaveBeenCalledWith({ enrollmentToken: "token-1", totpCode: "123456" });
    expect(document.body.querySelector('[data-testid="backup-codes"]')?.textContent).toContain("AAAA-1111");
  });

  it("tells the person to start again when the set-up ran out of time", async () => {
    api.getStatus.mockResolvedValue({ enabled: false, verificationRequired: false, enabledAt: null, recoveryCodesRemaining: 0 });
    api.startEnrollment.mockResolvedValue(START);
    api.finishEnrollment.mockRejectedValue(new TwoFactorApiError("Enrollment expired", 400, "two_factor_enrollment_expired", null));
    await mount();
    await click(button("Turn on"));
    await submitCode("123456");

    expect(document.body.querySelector('[role="alert"]')?.textContent).toBe("Set-up took too long. Please start again.");
    expect(button("Start again")).toBeDefined();
  });

  it("shows how many backup codes are left and turns two-step sign-in off with a code", async () => {
    api.getStatus.mockResolvedValue({
      enabled: true,
      verificationRequired: false,
      enabledAt: "2026-10-01T10:00:00.000Z",
      recoveryCodesRemaining: 7,
    });
    api.disable.mockResolvedValue({ disabled: true });
    await mount();
    expect(container.textContent).toContain("You have 7 backup codes left.");

    await click(button("Turn off"));
    await submitCode("654321");
    expect(api.disable).toHaveBeenCalledWith({ totpCode: "654321", isRecoveryCode: false });
  });

  it("can use a backup code to get new backup codes, and shows the new ones once", async () => {
    api.getStatus.mockResolvedValue({ enabled: true, verificationRequired: false, enabledAt: null, recoveryCodesRemaining: 1 });
    api.regenerateRecoveryCodes.mockResolvedValue({ recoveryCodes: ["NEW-0001", "NEW-0002"] });
    await mount();

    await click(button("Get new backup codes"));
    await click(button("I lost my phone — use a backup code"));
    await submitCode("OLD-9999");
    expect(api.regenerateRecoveryCodes).toHaveBeenCalledWith({ totpCode: "OLD-9999", isRecoveryCode: true });
    expect(document.body.querySelector('[data-testid="backup-codes"]')?.textContent).toContain("NEW-0001");
  });
});
