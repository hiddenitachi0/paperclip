// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentCryptoWalletsSection } from "./AgentCryptoWalletsSection";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const api = vi.hoisted(() => ({
  settings: vi.fn(),
  list: vi.fn(),
  agentLimits: vi.fn(),
  create: vi.fn(),
  balance: vi.fn(),
  destinations: vi.fn(),
  transactions: vi.fn(),
}));
vi.mock("../api/cryptoWallets", () => ({ cryptoWalletsApi: api }));
vi.mock("../context/ToastContext", () => ({ useToastActions: () => ({ pushToast: vi.fn() }) }));
const role = vi.hoisted(() => ({ current: { role: "owner", isInstanceAdmin: false, localBoard: false, canManageConnections: true, isLoading: false } }));
vi.mock("../hooks/useCompanyRole", () => ({ useCompanyRole: () => role.current }));

const wallet = {
  id: "w1",
  companyId: "c1",
  agentId: "a1",
  chain: "solana",
  network: "testnet",
  address: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin",
  label: "Purchases",
  keyOrigin: "generated",
  status: "active",
  frozenReason: null,
  limits: { perTransaction: "0.2", daily: "0.4", total: "2", approvalAbove: "0.08" },
  maxLeverage: 1,
  lastBalance: null,
  lastBalanceAt: null,
  createdAt: "2026-10-17T00:00:00Z",
  updatedAt: "2026-10-17T00:00:00Z",
};

async function flush() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

describe("AgentCryptoWalletsSection", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("shows the wallet as test coins with its address, explains the risks, and offers no way to see the key", async () => {
    api.settings.mockResolvedValue({ companyId: "c1", mainnetEnabled: false, mainnetEnabledAt: null, allWalletsFrozen: false, frozenReason: null, rpcEndpoints: {} });
    api.list.mockResolvedValue([wallet]);
    api.agentLimits.mockResolvedValue({ perTransactionUsd: 25, dailyUsd: 50, totalUsd: 200, approvalAboveUsd: 10 });
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={new QueryClient()}>
          <AgentCryptoWalletsSection companyId="c1" agentId="a1" />
        </QueryClientProvider>,
      );
    });
    await flush();
    const text = container.textContent ?? "";
    expect(text).toContain(wallet.address);
    expect(text).toContain("Test coins");
    expect(text).toContain("Real money is off for this company");
    expect(text).toContain("Nobody can read it back");
    expect(text.toLowerCase()).not.toContain("show key");
    expect(text.toLowerCase()).not.toContain("export key");
    expect(api.list).toHaveBeenCalledWith("c1", "a1");
    root.unmount();
  });

  it("does not let an admin unfreeze a frozen real-money wallet", async () => {
    role.current = { ...role.current, role: "admin" };
    api.settings.mockResolvedValue({ companyId: "c1", mainnetEnabled: true, mainnetEnabledAt: null, allWalletsFrozen: false, frozenReason: null, rpcEndpoints: {} });
    api.list.mockResolvedValue([{ ...wallet, network: "mainnet", status: "frozen", frozenReason: "Coins left this wallet that Paperclip did not send." }]);
    api.agentLimits.mockResolvedValue({ perTransactionUsd: 25, dailyUsd: 50, totalUsd: 200, approvalAboveUsd: 10 });
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={new QueryClient()}>
          <AgentCryptoWalletsSection companyId="c1" agentId="a1" />
        </QueryClientProvider>,
      );
    });
    await flush();
    const unfreeze = [...container.querySelectorAll("button")].find((b) => b.textContent === "Unfreeze")!;
    expect(unfreeze.disabled).toBe(true);
    expect(unfreeze.title).toMatch(/Only the owner/);
    root.unmount();
  });

  it("shows dated funding hints, the real-coins warning and a payment link that names the network", async () => {
    api.settings.mockResolvedValue({ companyId: "c1", mainnetEnabled: false, mainnetEnabledAt: null, allWalletsFrozen: false, frozenReason: null, rpcEndpoints: {} });
    const eth = "0x1111111111111111111111111111111111111111";
    api.list.mockResolvedValue([{ ...wallet, chain: "ethereum", address: eth }]);
    api.agentLimits.mockResolvedValue({ perTransactionUsd: 25, dailyUsd: 50, totalUsd: 200, approvalAboveUsd: 10 });
    api.destinations.mockResolvedValue([]);
    api.transactions.mockResolvedValue([]);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(
        <QueryClientProvider client={new QueryClient()}>
          <AgentCryptoWalletsSection companyId="c1" agentId="a1" />
        </QueryClientProvider>,
      );
    });
    await flush();
    expect(container.querySelector("[data-testid=crypto-testnet-warning]")?.textContent).toBe("Do not send real coins here. They cannot be recovered.");
    const toggle = [...container.querySelectorAll("button")].find((b) => b.textContent?.startsWith("Funding"))!;
    await act(async () => {
      toggle.click();
    });
    await flush();
    const text = container.textContent ?? "";
    expect(text).toContain("pk910");
    expect(text).toContain("Never use a faucet that needs real ETH on this address");
    expect(container.querySelector("[data-testid=crypto-faucet-stamp]")?.textContent).toBe("As of 27 Oct 2026. Faucets change often.");
    expect(container.querySelector("[data-testid=crypto-payment-link]")?.getAttribute("href")).toBe(`ethereum:${eth}@11155111`);
    root.unmount();
  });
});
