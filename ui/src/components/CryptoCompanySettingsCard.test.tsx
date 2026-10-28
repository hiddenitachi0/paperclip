// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CryptoCompanySettingsCard } from "./CryptoCompanySettingsCard";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const api = vi.hoisted(() => ({ settings: vi.fn(), updateSettings: vi.fn() }));
vi.mock("../api/cryptoWallets", () => ({ cryptoWalletsApi: api }));
vi.mock("../context/ToastContext", () => ({ useToastActions: () => ({ pushToast: vi.fn() }) }));
vi.mock("../hooks/useCompanyRole", () => ({
  useCompanyRole: () => ({ role: "owner", isInstanceAdmin: false, localBoard: false, canManageConnections: true, isLoading: false }),
}));

async function renderCard() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <QueryClientProvider client={new QueryClient()}>
        <CryptoCompanySettingsCard companyId="c1" />
      </QueryClientProvider>,
    );
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
  return { container, root };
}

const base = { companyId: "c1", mainnetEnabled: false, mainnetEnabledAt: null, allWalletsFrozen: false, frozenReason: null, rpcEndpoints: {} };

describe("CryptoCompanySettingsCard", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("hides the real-money control and says so when the server has real money switched off", async () => {
    api.settings.mockResolvedValue({ ...base, realMoneyLocked: true });
    const { container, root } = await renderCard();
    const text = container.textContent ?? "";
    expect(text).toContain("Real money is switched off on this server (administrator setting)");
    expect(text).not.toContain("Turn real money on");
    expect(text).not.toContain("Turn real money off");
    root.unmount();
  });

  it("still offers the owner the real-money control when the server allows it", async () => {
    api.settings.mockResolvedValue({ ...base, realMoneyLocked: false });
    const { container, root } = await renderCard();
    expect(container.textContent).toContain("Turn real money on");
    expect(container.textContent).not.toContain("switched off on this server");
    root.unmount();
  });
});
