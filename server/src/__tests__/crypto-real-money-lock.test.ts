import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  bitcoinAdapter,
  eip712Digest,
  ethereumAdapter,
  hyperliquidAdapter,
  hyperliquidL1ActionDigest,
  hyperliquidWithdrawDigest,
  solanaAdapter,
  type ChainContext,
  type CryptoLibs,
} from "../services/crypto-wallet-chains.ts";
import {
  CRYPTO_REAL_MONEY_ENV,
  describeCryptoRealMoneyLockForBoot,
  isCryptoRealMoneyAllowed,
} from "../services/crypto-real-money-lock.ts";
import type { OutboundFetch } from "../services/safe-outbound-fetch.ts";

/**
 * The server-wide real-money lock, at the signing layer. Every case here
 * must refuse with a 403 and a plain sentence BEFORE any key is used or any
 * network call is made, so the fetch is a tripwire and the libs are inert.
 */

const LOCK_MESSAGE = /Real money is switched off on this server \(administrator setting\)/;

const networkTripwire = vi.fn(async () => {
  throw new Error("the network must not be called");
});
const mainnet: ChainContext = { network: "mainnet", rpcUrl: "https://example.org", fetch: networkTripwire as unknown as OutboundFetch };
const testnet: ChainContext = { network: "testnet", rpcUrl: "https://example.org", fetch: networkTripwire as unknown as OutboundFetch };

const inertLibs = async () => {
  throw new Error("the signing library must not be loaded");
};
const noLibs = {} as CryptoLibs;
const key = "11".repeat(32);
const sendInput = { privateKey: key, from: "from", to: "to", amount: 1n, maxFee: 1_000_000n };

async function refusal(promise: Promise<unknown>) {
  const err = (await promise.then(
    () => null,
    (e: unknown) => e,
  )) as (Error & { status?: number }) | null;
  expect(err, "expected a refusal").not.toBeNull();
  return err!;
}

function expectLocked(err: Error & { status?: number }) {
  expect(err.status).toBe(403);
  expect(err.message).toMatch(LOCK_MESSAGE);
  expect(err.message).not.toContain(key);
}

describe("server-wide real-money lock", () => {
  let previous: string | undefined;
  beforeEach(() => {
    previous = process.env[CRYPTO_REAL_MONEY_ENV];
    delete process.env[CRYPTO_REAL_MONEY_ENV];
    networkTripwire.mockClear();
  });
  afterEach(() => {
    if (previous === undefined) delete process.env[CRYPTO_REAL_MONEY_ENV];
    else process.env[CRYPTO_REAL_MONEY_ENV] = previous;
  });

  it("allows real money only for exactly 'allowed'", () => {
    expect(isCryptoRealMoneyAllowed({})).toBe(false);
    for (const value of ["", "true", "1", "yes", "Allowed", "ALLOWED", " allowed", "allowed ", "forbidden"]) {
      expect(isCryptoRealMoneyAllowed({ [CRYPTO_REAL_MONEY_ENV]: value }), JSON.stringify(value)).toBe(false);
    }
    expect(isCryptoRealMoneyAllowed({ [CRYPTO_REAL_MONEY_ENV]: "allowed" })).toBe(true);
  });

  it("describes the lock for the boot log without leaking anything but the variable name", () => {
    expect(describeCryptoRealMoneyLockForBoot({})).toMatch(/locked off/);
    expect(describeCryptoRealMoneyLockForBoot({ [CRYPTO_REAL_MONEY_ENV]: "allowed" })).toMatch(/ALLOWED/);
  });

  it("refuses a Bitcoin, Ethereum and Solana send on the main network", async () => {
    for (const adapter of [bitcoinAdapter(inertLibs), ethereumAdapter(inertLibs), solanaAdapter()]) {
      expectLocked(await refusal(adapter.signTransfer(mainnet, sendInput)));
    }
    expect(networkTripwire).not.toHaveBeenCalled();
  });

  it("refuses a Hyperliquid order, leverage change and withdraw3 on the main network", async () => {
    const hl = hyperliquidAdapter(inertLibs);
    expectLocked(
      await refusal(hl.signOrder(mainnet, { privateKey: key, coin: "BTC", isBuy: true, size: "1", limitPrice: "100", reduceOnly: false, leverage: 1 })),
    );
    expectLocked(await refusal(hl.signTransfer(mainnet, sendInput)));
    expect(networkTripwire).not.toHaveBeenCalled();
  });

  it("refuses to build a Hyperliquid L1 action signature with source 'a'", () => {
    expect(() => hyperliquidL1ActionDigest(noLibs, { type: "dummy" }, 0n, "mainnet")).toThrow(LOCK_MESSAGE);
    // Same check where the digest is made, whoever calls it:
    expect(() =>
      eip712Digest(
        noLibs,
        { name: "Exchange", version: "1", chainId: 1337n, verifyingContract: "0x0000000000000000000000000000000000000000" },
        "Agent",
        [{ name: "source", type: "string" }],
        { source: "a" },
      ),
    ).toThrow(LOCK_MESSAGE);
  });

  it("refuses user-signed Hyperliquid actions for 'Mainnet': withdraw3 and usdSend", () => {
    expect(() => hyperliquidWithdrawDigest(noLibs, { hyperliquidChain: "Mainnet", destination: "0xabc", amount: "1", time: 1n })).toThrow(LOCK_MESSAGE);
    expect(() =>
      eip712Digest(
        noLibs,
        { name: "HyperliquidSignTransaction", version: "1", chainId: 0x66een, verifyingContract: "0x0000000000000000000000000000000000000000" },
        "HyperliquidTransaction:UsdSend",
        [
          { name: "hyperliquidChain", type: "string" },
          { name: "destination", type: "string" },
          { name: "amount", type: "string" },
          { name: "time", type: "uint64" },
        ],
        { hyperliquidChain: "Mainnet", destination: "0xabc", amount: "1", time: 1n },
      ),
    ).toThrow(LOCK_MESSAGE);
  });

  it("the refusals carry a 403 status", () => {
    try {
      hyperliquidL1ActionDigest(noLibs, { type: "dummy" }, 0n, "mainnet");
      expect.unreachable();
    } catch (err) {
      expectLocked(err as Error & { status?: number });
    }
  });

  it("does not touch test-network signing: Testnet and source 'b' are not refused by the lock", async () => {
    // Testnet digests get past the lock (and then need real libs, which this test does not have).
    for (const make of [
      () => hyperliquidL1ActionDigest(noLibs, { type: "dummy" }, 0n, "testnet"),
      () => hyperliquidWithdrawDigest(noLibs, { hyperliquidChain: "Testnet", destination: "0xabc", amount: "1", time: 1n }),
    ]) {
      expect(make).toThrow(/^(?!.*switched off on this server)/s);
    }
    // Testnet sends go past the lock and fail later (no libs, no network), never with a 403.
    for (const adapter of [bitcoinAdapter(inertLibs), ethereumAdapter(inertLibs), hyperliquidAdapter(inertLibs)]) {
      const err = await refusal(adapter.signTransfer(testnet, sendInput));
      expect((err as { status?: number }).status).not.toBe(403);
      expect(err.message).not.toMatch(LOCK_MESSAGE);
    }
  });

  it("signs for the main network again only when the variable is exactly 'allowed'", () => {
    process.env[CRYPTO_REAL_MONEY_ENV] = "allowed";
    // Past the lock, the digest needs real libs; the point is that the lock no longer refuses.
    expect(() => hyperliquidL1ActionDigest(noLibs, { type: "dummy" }, 0n, "mainnet")).toThrow(/^(?!.*switched off on this server)/s);
  });
});
