import { describe, expect, it } from "vitest";
import {
  CRYPTO_AGENT_HARD_CEILING_USD,
  DEFAULT_CRYPTO_AGENT_LIMITS,
  DEFAULT_CRYPTO_WALLET_LIMITS,
  CRYPTO_CHAIN_INFO,
  BITCOIN_SIGNET_LABEL,
  CRYPTO_FAUCET_HINTS_AS_OF,
  DEFAULT_BITCOIN_NETWORK_VARIANT,
  DEFAULT_BITCOIN_SIGNET_RPC_ENDPOINT,
  cryptoEndpointSlot,
  cryptoNetworkLabel,
  defaultCryptoRpcEndpoint,
  createCryptoWalletSchema,
  cryptoPaymentLink,
  cryptoAgentLimitsSchema,
  formatCryptoAmount,
  looksLikeCryptoAddress,
  parseCryptoAmount,
  updateCompanyCryptoSettingsSchema,
} from "./crypto-wallets.js";
import { isSecretKindBindable } from "./secret-kinds.js";

describe("crypto wallet amounts", () => {
  it("parses decimals into base units without ever rounding", () => {
    expect(parseCryptoAmount("0.0015", 8)).toBe(150_000n);
    expect(parseCryptoAmount("1", 18)).toBe(10n ** 18n);
    expect(parseCryptoAmount("0.000000001", 9)).toBe(1n);
    expect(parseCryptoAmount("0.0000000001", 9)).toBeNull();
    expect(parseCryptoAmount("-1", 8)).toBeNull();
    expect(parseCryptoAmount("1e3", 8)).toBeNull();
    expect(parseCryptoAmount("01", 8)).toBeNull();
  });

  it("formats base units back to plain decimals", () => {
    expect(formatCryptoAmount(150_000n, 8)).toBe("0.0015");
    expect(formatCryptoAmount("1000000000000000000", 18)).toBe("1");
    expect(formatCryptoAmount(0n, 6)).toBe("0");
  });

  it("has default wallet limits that go up and parse for every chain", () => {
    for (const [chain, limits] of Object.entries(DEFAULT_CRYPTO_WALLET_LIMITS)) {
      const decimals = CRYPTO_CHAIN_INFO[chain as keyof typeof CRYPTO_CHAIN_INFO].decimals;
      const perTx = parseCryptoAmount(limits.perTransaction, decimals)!;
      const daily = parseCryptoAmount(limits.daily, decimals)!;
      const total = parseCryptoAmount(limits.total, decimals)!;
      const approval = parseCryptoAmount(limits.approvalAbove!, decimals)!;
      expect(perTx <= daily && daily <= total && approval <= perTx).toBe(true);
    }
  });
});

describe("crypto wallet validators", () => {
  it("defaults a new wallet to the test network", () => {
    const parsed = createCryptoWalletSchema.parse({ agentId: "11111111-1111-4111-8111-111111111111", chain: "solana", label: "x", mode: "generate" });
    expect(parsed.network).toBe("testnet");
  });

  it("needs a key to import and refuses one when generating", () => {
    const base = { agentId: "11111111-1111-4111-8111-111111111111", chain: "ethereum", label: "x" } as const;
    expect(createCryptoWalletSchema.safeParse({ ...base, mode: "import" }).success).toBe(false);
    expect(createCryptoWalletSchema.safeParse({ ...base, mode: "generate", privateKey: "abc" }).success).toBe(false);
    const failed = createCryptoWalletSchema.safeParse({ ...base, mode: "import", privateKey: "x".repeat(500) });
    expect(failed.success).toBe(false);
    // A validation error never repeats the key back.
    expect(JSON.stringify(failed.error)).not.toContain("x".repeat(50));
  });

  it("keeps agent limits under the hard ceiling", () => {
    expect(cryptoAgentLimitsSchema.safeParse(DEFAULT_CRYPTO_AGENT_LIMITS).success).toBe(true);
    expect(cryptoAgentLimitsSchema.safeParse({ ...DEFAULT_CRYPTO_AGENT_LIMITS, totalUsd: CRYPTO_AGENT_HARD_CEILING_USD.total + 1 }).success).toBe(false);
    expect(CRYPTO_AGENT_HARD_CEILING_USD).toEqual({ perTransaction: 1_000, daily: 2_000, total: 10_000 });
  });

  it("only accepts https network addresses", () => {
    expect(updateCompanyCryptoSettingsSchema.safeParse({ rpcEndpoints: { solana: { testnet: "http://x.example.org" } } }).success).toBe(false);
    expect(updateCompanyCryptoSettingsSchema.safeParse({ rpcEndpoints: { solana: { testnet: "https://x.example.org" } } }).success).toBe(true);
  });

  it("does a quick format check per chain and network", () => {
    expect(looksLikeCryptoAddress("bitcoin", "mainnet", "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4")).toBe(true);
    expect(looksLikeCryptoAddress("bitcoin", "testnet", "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4")).toBe(false);
    expect(looksLikeCryptoAddress("ethereum", "testnet", "0x52908400098527886e0f7030069857d2e4169ee7")).toBe(true);
    expect(looksLikeCryptoAddress("solana", "testnet", "11111111111111111111111111111111")).toBe(true);
  });

  it("never lets a wallet key be bound to an agent's environment", () => {
    expect(isSecretKindBindable("crypto_wallet_key")).toBe(false);
  });
});

describe("test-network funding hints and payment links", () => {
  it("dates the faucet hints and covers every network", () => {
    expect(CRYPTO_FAUCET_HINTS_AS_OF).toBe("27 Oct 2026");
    expect(CRYPTO_CHAIN_INFO.bitcoin.testnetFaucetHint).toContain("coinfaucet.eu");
    expect(CRYPTO_CHAIN_INFO.bitcoin.testnetFaucetNotes.join(" ")).toContain("alt.signetfaucet.com");
    expect(CRYPTO_CHAIN_INFO.ethereum.testnetFaucetHint).toContain("pk910");
    expect(CRYPTO_CHAIN_INFO.ethereum.testnetFaucetNotes.join(" ")).toContain("Never use a faucet that needs real ETH");
    expect(CRYPTO_CHAIN_INFO.hyperliquid.testnetFaucetHint).toContain("no-real-money rule");
    expect(CRYPTO_CHAIN_INFO.solana.testnetFaucetHint).toContain("forbids AI agents");
  });

  it("names the network in payment links", () => {
    const eth = "0x1111111111111111111111111111111111111111";
    expect(cryptoPaymentLink("ethereum", "testnet", eth)).toBe(`ethereum:${eth}@11155111`);
    expect(cryptoPaymentLink("ethereum", "mainnet", eth)).toBe(`ethereum:${eth}@1`);
    expect(cryptoPaymentLink("bitcoin", "testnet", "tb1qabc")).toBe("bitcoin:tb1qabc?label=TEST%20NETWORK%20ONLY");
    expect(cryptoPaymentLink("bitcoin", "mainnet", "bc1qabc")).toBe("bitcoin:bc1qabc");
    expect(cryptoPaymentLink("solana", "testnet", "x")).toBeNull();
    expect(cryptoPaymentLink("hyperliquid", "testnet", eth)).toBeNull();
  });
});

describe("test network per wallet: bitcoin variant and Ethereum chain ID (DUR-5024)", () => {
  const base = { agentId: "11111111-1111-4111-8111-111111111111", label: "W", mode: "generate" as const };

  it("makes signet the default for new bitcoin test wallets", () => {
    expect(DEFAULT_BITCOIN_NETWORK_VARIANT).toBe("signet");
    expect(DEFAULT_BITCOIN_SIGNET_RPC_ENDPOINT).toBe("https://mempool.space/signet/api");
  });

  it("gives signet and testnet4 separate network-address slots, keeping the old testnet slot for testnet4", () => {
    expect(cryptoEndpointSlot("bitcoin", "testnet", "signet")).toBe("signet");
    expect(cryptoEndpointSlot("bitcoin", "testnet", "testnet4")).toBe("testnet");
    expect(cryptoEndpointSlot("bitcoin", "testnet", null)).toBe("testnet");
    expect(cryptoEndpointSlot("bitcoin", "mainnet", "signet")).toBe("mainnet");
    expect(cryptoEndpointSlot("ethereum", "testnet")).toBe("testnet");
    expect(defaultCryptoRpcEndpoint("bitcoin", "signet")).toBe("https://mempool.space/signet/api");
    expect(defaultCryptoRpcEndpoint("bitcoin", "testnet")).toBe("https://mempool.space/testnet4/api");
    expect(defaultCryptoRpcEndpoint("solana", "signet")).toBeUndefined();
    expect(updateCompanyCryptoSettingsSchema.safeParse({ rpcEndpoints: { bitcoin: { signet: "https://example.org/api" } } }).success).toBe(true);
  });

  it("only accepts a variant on a bitcoin test wallet and a chain ID on an Ethereum test wallet from the allow-list", () => {
    expect(createCryptoWalletSchema.safeParse({ ...base, chain: "bitcoin", networkVariant: "signet" }).success).toBe(true);
    expect(createCryptoWalletSchema.safeParse({ ...base, chain: "bitcoin", networkVariant: "testnet3" }).success).toBe(false);
    expect(createCryptoWalletSchema.safeParse({ ...base, chain: "solana", networkVariant: "signet" }).success).toBe(false);
    expect(createCryptoWalletSchema.safeParse({ ...base, chain: "bitcoin", network: "mainnet", networkVariant: "signet" }).success).toBe(false);
    expect(createCryptoWalletSchema.safeParse({ ...base, chain: "ethereum", evmChainId: 560048 }).success).toBe(true);
    for (const evmChainId of [1, 8453, 42161, 0, -1]) {
      expect(createCryptoWalletSchema.safeParse({ ...base, chain: "ethereum", evmChainId }).success).toBe(false);
    }
    expect(createCryptoWalletSchema.safeParse({ ...base, chain: "ethereum", network: "mainnet", evmChainId: 11155111 }).success).toBe(false);
  });

  it("labels and links a wallet by its own stored network", () => {
    expect(cryptoNetworkLabel("bitcoin", "testnet", { networkVariant: "signet" })).toBe(BITCOIN_SIGNET_LABEL);
    expect(cryptoNetworkLabel("bitcoin", "testnet", { networkVariant: "testnet4" })).toBe(CRYPTO_CHAIN_INFO.bitcoin.testnetLabel);
    expect(cryptoNetworkLabel("bitcoin", "testnet")).toBe(CRYPTO_CHAIN_INFO.bitcoin.testnetLabel);
    expect(cryptoNetworkLabel("ethereum", "testnet", { evmChainId: 560048 })).toBe("Ethereum test network (Hoodi)");
    const eth = "0x1111111111111111111111111111111111111111";
    expect(cryptoPaymentLink("ethereum", "testnet", eth, 560048)).toBe(`ethereum:${eth}@560048`);
    expect(cryptoPaymentLink("ethereum", "mainnet", eth, 560048)).toBe(`ethereum:${eth}@1`);
  });
});
