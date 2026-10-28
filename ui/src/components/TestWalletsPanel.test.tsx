// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TestWalletsPanel } from "./TestWalletsPanel";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const walletsApi = vi.hoisted(() => ({ list: vi.fn(), balance: vi.fn() }));
const agentsApi = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock("../api/cryptoWallets", () => ({ cryptoWalletsApi: walletsApi }));
vi.mock("../api/agents", () => ({ agentsApi }));
vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompany: { id: "c1", issuePrefix: "PAP" }, selectedCompanyId: "c1", companies: [] }),
}));

const holder = { id: "a1", name: "Wallet holder", urlKey: "wallet-holder" };

const wallet = {
  id: "w1",
  companyId: "c1",
  agentId: "a1",
  chain: "ethereum",
  network: "testnet",
  address: "0x1111111111111111111111111111111111111111",
  label: "Practice",
  keyOrigin: "generated",
  status: "active",
  frozenReason: null,
  limits: { perTransaction: "0.2", daily: "0.4", total: "2", approvalAbove: "0.08" },
  maxLeverage: 1,
  lastBalance: "1500000000000000000",
  lastBalanceAt: "2026-10-28T00:00:00Z",
  createdAt: "2026-10-17T00:00:00Z",
  updatedAt: "2026-10-17T00:00:00Z",
};

async function render() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter>
          <TestWalletsPanel companyId="c1" />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
  return { container, root };
}

describe("TestWalletsPanel", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("lists test wallets with the badge, address, balance, funding steps and the one-line explanation", async () => {
    walletsApi.list.mockResolvedValue([wallet, { ...wallet, id: "w2", network: "mainnet", address: "0xREAL" }, { ...wallet, id: "w3", status: "archived", address: "0xGONE" }]);
    agentsApi.list.mockResolvedValue([holder]);
    const { container, root } = await render();
    const text = container.textContent ?? "";
    expect(walletsApi.list).toHaveBeenCalledWith("c1");
    expect(container.querySelectorAll('[data-testid="test-wallet-row"]')).toHaveLength(1);
    expect(container.querySelector('[data-testid="test-wallet-badge"]')?.textContent).toBe("TEST NETWORK: no value");
    expect(text).toContain(wallet.address);
    expect(text).not.toContain("0xREAL");
    expect(text).not.toContain("0xGONE");
    expect(text).toContain("1.5 ETH");
    expect(text).toContain("How to add test coins");
    expect(text).toContain(
      "Test networks check that sending and approvals work. Whether a strategy is good is measured on real prices in paper trading.",
    );
    expect(container.querySelector('a[href="/PAP/agents/wallet-holder/configuration"]')).not.toBeNull();
    expect(text.toLowerCase()).not.toContain("private key");
    root.unmount();
  });

  it("explains how to get a first wallet when there are none", async () => {
    walletsApi.list.mockResolvedValue([]);
    agentsApi.list.mockResolvedValue([holder]);
    const { container, root } = await render();
    expect(container.querySelector('[data-testid="test-wallets-empty"]')?.textContent).toContain("No test wallets yet.");
    expect(container.querySelector('a[href="/PAP/agents/wallet-holder/configuration"]')).not.toBeNull();
    root.unmount();
  });

  it("still points somewhere useful when no Wallet holder agent exists", async () => {
    walletsApi.list.mockResolvedValue([]);
    agentsApi.list.mockResolvedValue([]);
    const { container, root } = await render();
    expect(container.querySelector('[data-testid="test-wallets-empty"]')?.textContent).toContain('no agent called "Wallet holder"');
    root.unmount();
  });
});
