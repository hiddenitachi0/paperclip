import { createPublicKey, generateKeyPairSync, randomBytes, verify } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  base58Decode,
  base58Encode,
  bytesToHex,
  decodeSegwitAddress,
  encodeSegwitAddress,
  hexToBytes,
  msgpackEncode,
  normalizeDecimalString,
  rlpEncode,
} from "../services/crypto-wallet-encoding.ts";
import {
  bitcoinAdapter,
  cappedEvmFees,
  CryptoChainError,
  loadCryptoLibs,
  solanaAdapter,
  ethereumAdapter,
  eip712Digest,
  hyperliquidAdapter,
  hyperliquidL1ActionDigest,
  type ChainContext,
  type CryptoLibsLoader,
} from "../services/crypto-wallet-chains.ts";
import { createCryptoRpcOutboundPolicy } from "../services/safe-outbound-fetch.ts";
import type { OutboundFetch } from "../services/safe-outbound-fetch.ts";

/**
 * Offline tests for the crypto wallet chain adapters and their encoders.
 * No network: every RPC is a fake fetch. Bitcoin addresses use Node's own
 * secp256k1; Solana signs with Node's own Ed25519. Ethereum/Hyperliquid
 * signing needs the optional noble libraries and is covered by the wallet
 * service tests through a fake adapter.
 */

const missingLibs: CryptoLibsLoader = async () => {
  throw new CryptoChainError("libs_missing", "not installed");
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("crypto wallet encoders", () => {
  it("base58 round-trips and keeps leading zero bytes", () => {
    expect(base58Encode(new TextEncoder().encode("Hello World!"))).toBe("2NEpo7TZRRrLZSi2U");
    expect(bytesToHex(base58Decode("2NEpo7TZRRrLZSi2U"))).toBe(bytesToHex(new TextEncoder().encode("Hello World!")));
    expect(base58Encode(Uint8Array.of(0, 0, 1))).toBe("112");
    expect(base58Encode(new Uint8Array(32))).toBe("11111111111111111111111111111111");
    expect(() => base58Decode("0OIl")).toThrow();
  });

  it("bech32 decodes the BIP-173 example and rejects a typo", () => {
    const decoded = decodeSegwitAddress("bc", "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4");
    expect(decoded?.version).toBe(0);
    expect(bytesToHex(decoded!.program)).toBe("751e76e8199196d454941c45d1b3a323f1433bd6");
    expect(decodeSegwitAddress("bc", "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t5")).toBeNull();
    expect(decodeSegwitAddress("tb", "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4")).toBeNull();
    expect(encodeSegwitAddress("bc", 0, hexToBytes("751e76e8199196d454941c45d1b3a323f1433bd6"))).toBe("bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4");
  });

  it("RLP matches the Ethereum yellow-paper examples", () => {
    const enc = (s: string) => new TextEncoder().encode(s);
    expect(bytesToHex(rlpEncode(enc("dog")))).toBe("83646f67");
    expect(bytesToHex(rlpEncode([enc("cat"), enc("dog")]))).toBe("c88363617483646f67");
    expect(bytesToHex(rlpEncode(new Uint8Array(0)))).toBe("80");
    expect(bytesToHex(rlpEncode([]))).toBe("c0");
    expect(bytesToHex(rlpEncode(Uint8Array.of(0x0f)))).toBe("0f");
    expect(bytesToHex(rlpEncode(Uint8Array.of(0x04, 0x00)))).toBe("820400");
    expect(bytesToHex(rlpEncode([[], [[]], [[], [[]]]]))).toBe("c7c0c1c0c3c0c1c0");
    const lorem = enc("Lorem ipsum dolor sit amet, consectetur adipisicing elit");
    expect(bytesToHex(rlpEncode(lorem)).slice(0, 4)).toBe("b838");
  });

  it("MessagePack keeps map order and encodes the small types Hyperliquid uses", () => {
    expect(bytesToHex(msgpackEncode({ a: 1, b: true, c: null }))).toBe("83a16101a162c3a163c0");
    expect(bytesToHex(msgpackEncode({ b: 1, a: 2 }))).toBe("82a16201a16102");
    expect(bytesToHex(msgpackEncode(300))).toBe("cd012c");
    expect(bytesToHex(msgpackEncode(1_700_000_000_000))).toBe("cf0000018bcfe56800");
    expect(bytesToHex(msgpackEncode(-1))).toBe("ff");
    expect(bytesToHex(msgpackEncode(["x"]))).toBe("91a178");
    expect(() => msgpackEncode(1.5)).toThrow();
  });

  it("normalizes decimal text the way Hyperliquid expects", () => {
    expect(normalizeDecimalString("1.500")).toBe("1.5");
    expect(normalizeDecimalString("2.0")).toBe("2");
    expect(normalizeDecimalString("0.010")).toBe("0.01");
    expect(normalizeDecimalString("007")).toBe("7");
  });
});

describe("crypto network endpoint policy", () => {
  it("allows a public https host and refuses everything else", () => {
    expect(createCryptoRpcOutboundPolicy("https://api.devnet.solana.com").hostPattern.test("api.devnet.solana.com")).toBe(true);
    expect(() => createCryptoRpcOutboundPolicy("http://api.devnet.solana.com")).toThrow(/https/);
    expect(() => createCryptoRpcOutboundPolicy("https://127.0.0.1")).toThrow();
    expect(() => createCryptoRpcOutboundPolicy("https://localhost")).toThrow();
    expect(() => createCryptoRpcOutboundPolicy("https://node.internal")).toThrow();
    expect(() => createCryptoRpcOutboundPolicy("https://user:pw@rpc.example.org")).toThrow(/username/);
    expect(() => createCryptoRpcOutboundPolicy("https://rpc.example.org:8545")).toThrow(/port/);
  });
});

describe("bitcoin adapter (offline parts)", () => {
  const btc = bitcoinAdapter(missingLibs);

  it("derives the right native segwit address from a key (private key 1 is the BIP-173 example)", async () => {
    const key = "0000000000000000000000000000000000000000000000000000000000000001";
    const imported = await btc.importKey(key, "mainnet");
    expect(imported.address).toBe("bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4");
    expect((await btc.importKey(key, "testnet")).address).toBe(encodeSegwitAddress("tb", 0, hexToBytes("751e76e8199196d454941c45d1b3a323f1433bd6")));
  });

  it("imports a WIF key and refuses recovery words or a key for the other network", async () => {
    const wif = "KwDiBf89QgGbjEhKnhXJuH7LrciVrZi3qYjgd9M7rFU73sVHnoWn";
    expect((await btc.importKey(wif, "mainnet")).address).toBe("bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4");
    await expect(btc.importKey(wif, "testnet")).rejects.toThrow(/not a bitcoin private key/);
    const words = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
    const err = await btc.importKey(words, "mainnet").catch((e: Error) => e);
    expect(err).toBeInstanceOf(CryptoChainError);
    expect((err as Error).message).not.toContain("abandon");
  });

  it("generates a key whose address it can derive again", async () => {
    const made = await btc.generateKey("testnet");
    expect(made.address.startsWith("tb1q")).toBe(true);
    expect(await btc.deriveAddress(made.privateKey, "testnet")).toBe(made.address);
    expect(await btc.validateAddress(made.address, "testnet")).toBe(made.address);
    expect(await btc.validateAddress(made.address, "mainnet")).toBeNull();
  });

  it("refuses to sign when the signing library is not installed, with a plain message", async () => {
    const made = await btc.generateKey("testnet");
    const ctx: ChainContext = { network: "testnet", rpcUrl: "https://mempool.space/testnet4/api", fetch: (async () => json({})) as OutboundFetch };
    await expect(btc.signTransfer(ctx, { privateKey: made.privateKey, from: made.address, to: made.address, amount: 1000n, maxFee: 10_000n })).rejects.toThrow(/not installed/);
  });

  it("reads the balance from an Esplora-style service", async () => {
    const fetch = (async (url: string) => {
      expect(url).toBe("https://mempool.space/testnet4/api/address/tb1qxyz");
      return json({ chain_stats: { funded_txo_sum: 5000, spent_txo_sum: 1000 }, mempool_stats: { funded_txo_sum: 200, spent_txo_sum: 0 } });
    }) as unknown as OutboundFetch;
    const result = await btc.getBalance({ network: "testnet", rpcUrl: "https://mempool.space/testnet4/api", fetch }, "tb1qxyz");
    expect(result.balance).toBe(4200n);
  });
});

describe("ethereum adapter without the signing library", () => {
  it("accepts plain lower-case addresses but will not guess at a mixed-case checksum", async () => {
    const eth = ethereumAdapter(missingLibs);
    expect(await eth.validateAddress("0x52908400098527886e0f7030069857d2e4169ee7", "testnet")).toBe("0x52908400098527886e0f7030069857d2e4169ee7");
    await expect(eth.validateAddress("0x52908400098527886E0F7030069857D2E4169EE7", "testnet")).resolves.toBe(
      "0x52908400098527886e0f7030069857d2e4169ee7",
    );
    await expect(eth.validateAddress("0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed", "testnet")).rejects.toThrow(/not installed/);
    expect(await eth.validateAddress("0x123", "testnet")).toBeNull();
    expect(await eth.validateAddress("0x0000000000000000000000000000000000000000", "testnet")).toBeNull();
    await expect(eth.generateKey("testnet")).rejects.toThrow(/not installed/);
  });
});

const libsAvailable = await loadCryptoLibs()
  .then(() => true)
  .catch(() => false);

describe.skipIf(!libsAvailable)("Hyperliquid signing with the signing library installed", () => {
  it("matches the official SDK's L1 action signature vectors (mainnet and testnet)", async () => {
    // The mainnet vector needs the server-wide real-money lock open (see crypto-real-money-lock.test.ts).
    vi.stubEnv("PAPERCLIP_CRYPTO_REAL_MONEY", "allowed");
    const libs = await loadCryptoLibs();
    const key = hexToBytes("0123456789012345678901234567890123456789012345678901234567890123");
    const hex32 = (v: bigint) => `0x${v.toString(16).padStart(64, "0")}`;
    const main = libs.secp256k1SignDigest(hyperliquidL1ActionDigest(libs, { type: "dummy", num: 100000000000 }, 0n, "mainnet"), key);
    expect([hex32(main.r), hex32(main.s), 27 + main.recovery]).toEqual([
      "0x053749d5b30552aeb2fca34b530185976545bb22d0b3ce6f62e31be961a59298",
      "0x755c40ba9bf05223521753995abb2f73ab3229be8ec921f350cb447e384d8ed8",
      27,
    ]);
    const test = libs.secp256k1SignDigest(hyperliquidL1ActionDigest(libs, { type: "dummy", num: 100000000000 }, 0n, "testnet"), key);
    expect([hex32(test.r), hex32(test.s), 27 + test.recovery]).toEqual([
      "0x542af61ef1f429707e3c76c5293c80d01f74ef853e34b76efffcb57e574f9510",
      "0x17b8b32f086e8cdede991f1e2c529f5dd5297cbe8128500e00cbaf766204a613",
      28,
    ]);
    vi.unstubAllEnvs();
  });

  it("hashes EIP-712 data like the spec's Ether Mail example", async () => {
    const libs = await loadCryptoLibs();
    const digest = eip712Digest(
      libs,
      { name: "Ether Mail", version: "1", chainId: 1n, verifyingContract: "0xCcCCccccCCCCcCCCCCCcCcCccCcCCCcCcccccccC" },
      "Person",
      [
        { name: "name", type: "string" },
        { name: "wallet", type: "address" },
      ],
      { name: "Cow", wallet: "0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826" },
    );
    const personHash = hexToBytes("fc71e5fa27ff56c350aa531bc129ebdf613b772b6604664f5d8dbe21b85eb0c8");
    const domain = hexToBytes("f2cee375fa42b42143804025fc449deafd50cc031ca257e0b194a650a912090f");
    expect(bytesToHex(digest)).toBe(bytesToHex(libs.keccak256(new Uint8Array([0x19, 0x01, ...domain, ...personHash]))));
  });
});

describe.skipIf(!libsAvailable)("ethereum adapter with the signing library installed", () => {
  it("derives the well-known address for a well-known key and checks EIP-55", async () => {
    const eth = ethereumAdapter();
    const imported = await eth.importKey("0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318", "testnet");
    expect(imported.address).toBe("0x2c7536e3605d9c16a7a3d7b1898e529396a65c23");
    expect(await eth.validateAddress("0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed", "testnet")).toBe("0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed");
    expect(await eth.validateAddress("0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAeD", "testnet")).toBeNull();
  });
});

describe("solana adapter (Node's own Ed25519, fake RPC)", () => {
  const sol = solanaAdapter();

  function exportedSecret(): { secretBase58: string; seedHex: string; address: string } {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const seed = (privateKey.export({ format: "der", type: "pkcs8" }) as Buffer).subarray(-32);
    const pub = (publicKey.export({ format: "der", type: "spki" }) as Buffer).subarray(-32);
    return {
      secretBase58: base58Encode(new Uint8Array(Buffer.concat([seed, pub]))),
      seedHex: seed.toString("hex"),
      address: base58Encode(new Uint8Array(pub)),
    };
  }

  it("imports Phantom-style and solana-keygen-style keys to the same address", async () => {
    const exp = exportedSecret();
    const fromBase58 = await sol.importKey(exp.secretBase58, "testnet");
    expect(fromBase58.address).toBe(exp.address);
    const asArray = JSON.stringify([...base58Decode(exp.secretBase58)]);
    expect((await sol.importKey(asArray, "testnet")).address).toBe(exp.address);
    expect(fromBase58.privateKey).toBe(exp.seedHex);
    await expect(sol.importKey("not a key at all", "testnet")).rejects.toThrow(/not a Solana private key/);
  });

  it("builds and signs a transfer whose signature verifies, and never puts the key in the transaction", async () => {
    const exp = exportedSecret();
    const to = base58Encode(new Uint8Array(randomBytes(32)));
    const blockhash = base58Encode(new Uint8Array(randomBytes(32)));
    const calls: string[] = [];
    const fetch = (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      calls.push(body.method);
      if (body.method === "getGenesisHash") return json({ result: "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG" });
      if (body.method === "getBalance") return json({ result: { value: 0 } });
      if (body.method === "getLatestBlockhash") return json({ result: { value: { blockhash, lastValidBlockHeight: 1150 } } });
      throw new Error(`unexpected ${body.method}`);
    }) as unknown as OutboundFetch;
    const ctx: ChainContext = { network: "testnet", rpcUrl: "https://api.devnet.solana.com", fetch };
    const signed = await sol.signTransfer(ctx, { privateKey: exp.seedHex, from: exp.address, to, amount: 1_000_000n, maxFee: 7_500n });

    const tx = Buffer.from(signed.raw, "base64");
    expect(tx[0]).toBe(1); // one signature
    const signature = tx.subarray(1, 65);
    const message = tx.subarray(65);
    const pub = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), Buffer.from(base58Decode(exp.address))]), format: "der", type: "spki" });
    expect(verify(null, message, pub, signature)).toBe(true);
    expect(signed.txHash).toBe(base58Encode(new Uint8Array(signature)));
    // Transfer instruction: index 2, little-endian lamports at the end.
    expect(message.subarray(-8).readBigUInt64LE()).toBe(1_000_000n);
    expect(tx.toString("hex")).not.toContain(exp.seedHex);
    expect(calls).toEqual(["getGenesisHash", "getBalance", "getLatestBlockhash"]);
    expect(signed.chainDetail).toEqual({ lastValidBlockHeight: 1150 });
  });

  it("refuses a first payment below the network's minimum to a brand-new address", async () => {
    const exp = exportedSecret();
    const fetch = (async (_url: string, init?: RequestInit) =>
      json({ result: JSON.parse(String(init?.body)).method === "getGenesisHash" ? "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG" : { value: 0 } })) as unknown as OutboundFetch;
    const ctx: ChainContext = { network: "testnet", rpcUrl: "https://api.devnet.solana.com", fetch };
    await expect(
      sol.signTransfer(ctx, { privateKey: exp.seedHex, from: exp.address, to: base58Encode(new Uint8Array(randomBytes(32))), amount: 1000n, maxFee: 7_500n }),
    ).rejects.toThrow(/refuses a first payment/);
  });
});

describe("network fees are capped, whatever the network service says (B1)", () => {
  const gwei = 1_000_000_000n;

  it("clamps the tip and the price per gas, and refuses when the base fee alone is above the ceiling", () => {
    expect(cappedEvmFees(50n * gwei, 100_000n * gwei)).toEqual({ priority: 5n * gwei, maxFee: 105n * gwei });
    expect(cappedEvmFees(150n * gwei, 1n * gwei)).toEqual({ priority: 1n * gwei, maxFee: 200n * gwei });
    expect(() => cappedEvmFees(199n * gwei, 5n * gwei)).toThrow(/unusually high/);
  });

  it("estimates an Ethereum fee from a hostile node at the capped price, and refuses an impossible one", async () => {
    const answers: Record<string, unknown> = {
      eth_getBlockByNumber: { baseFeePerGas: `0x${(10n * gwei).toString(16)}` },
      eth_maxPriorityFeePerGas: `0x${(100_000n * gwei).toString(16)}`,
      eth_estimateGas: "0x5208",
    };
    const fetch = (async (_url: string, init?: RequestInit) => json({ result: answers[JSON.parse(String(init?.body)).method] })) as unknown as OutboundFetch;
    const eth = ethereumAdapter(missingLibs);
    const ctx: ChainContext = { network: "testnet", rpcUrl: "https://rpc.example.org", fetch };
    const fee = await eth.estimateFee(ctx, { from: "0x2c7536e3605d9c16a7a3d7b1898e529396a65c23", to: "0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed", amount: 10n ** 16n });
    expect(fee).toBe(21_000n * 25n * gwei); // 2 x 10 gwei base + 5 gwei capped tip
    answers.eth_estimateGas = `0x${(99_000).toString(16)}`;
    answers.eth_getBlockByNumber = { baseFeePerGas: `0x${(90n * gwei).toString(16)}` };
    await expect(eth.estimateFee(ctx, { from: "0x2c7536e3605d9c16a7a3d7b1898e529396a65c23", to: "0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed", amount: 1n })).rejects.toThrow(/ceiling/);
  });
});

describe("unclear answers are never treated as failures (B2)", () => {
  const rpc = (handler: (method: string, params: unknown[]) => Response) =>
    (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      return handler(body.method, body.params);
    }) as unknown as OutboundFetch;

  it("Ethereum: 'already known' is a success, a 502 is unclear, and a missing receipt only fails once the nonce is used elsewhere", async () => {
    const eth = ethereumAdapter(missingLibs);
    const signed = { raw: "0x02aa", txHash: "0xabc", feeUpperBound: 1n, chainDetail: { nonce: "7" } };
    const known: ChainContext = { network: "testnet", rpcUrl: "https://rpc.example.org", fetch: rpc(() => json({ error: { message: "already known" } })) };
    await expect(eth.broadcast(known, signed)).resolves.toEqual({ status: "pending" });
    const gateway: ChainContext = { network: "testnet", rpcUrl: "https://rpc.example.org", fetch: rpc(() => new Response("bad gateway", { status: 502 })) };
    await expect(eth.broadcast(gateway, signed)).rejects.toThrow(/HTTP 502/);
    await expect(eth.getTxStatus(gateway, { txHash: "0xabc", raw: null, chainDetail: { nonce: "7" }, from: "0x01" })).rejects.toThrow();

    let latestNonce = "0x7";
    const node: ChainContext = {
      network: "testnet",
      rpcUrl: "https://rpc.example.org",
      fetch: rpc((method) => json({ result: method === "eth_getTransactionCount" ? latestNonce : null })),
    };
    await expect(eth.getTxStatus(node, { txHash: "0xabc", raw: null, chainDetail: { nonce: "7" }, from: "0x01" })).resolves.toBe("pending");
    latestNonce = "0x8";
    await expect(eth.getTxStatus(node, { txHash: "0xabc", raw: null, chainDetail: { nonce: "7" }, from: "0x01" })).resolves.toBe("failed");
  });

  it("Bitcoin: a 5xx or 429 is unknown, and a missing transaction only fails once its inputs are spent elsewhere", async () => {
    const btc = bitcoinAdapter(missingLibs);
    const tx = { txHash: "aa".repeat(32), raw: "00", chainDetail: { inputs: [{ txid: "bb".repeat(32), vout: 0 }] }, from: "tb1qx" };
    for (const status of [429, 500, 503]) {
      const ctx: ChainContext = { network: "testnet", rpcUrl: "https://mempool.space/testnet4/api", fetch: (async () => new Response("busy", { status })) as unknown as OutboundFetch };
      await expect(btc.getTxStatus(ctx, tx)).rejects.toThrow();
    }
    let spentBy: string | null = null;
    const ctx: ChainContext = {
      network: "testnet",
      rpcUrl: "https://mempool.space/testnet4/api",
      fetch: (async (url: string) =>
        url.endsWith("/status") ? new Response("Transaction not found", { status: 404 }) : json(spentBy ? { spent: true, txid: spentBy } : { spent: false })) as unknown as OutboundFetch,
    };
    await expect(btc.getTxStatus(ctx, tx)).resolves.toBe("unknown");
    spentBy = "cc".repeat(32);
    await expect(btc.getTxStatus(ctx, tx)).resolves.toBe("failed");

    const known: ChainContext = { ...ctx, fetch: (async () => new Response("sendrawtransaction RPC error: txn-already-known", { status: 400 })) as unknown as OutboundFetch };
    await expect(btc.broadcast(known, { raw: "00", txHash: tx.txHash, feeUpperBound: 1n })).resolves.toEqual({ status: "pending" });
    const broken: ChainContext = { ...ctx, fetch: (async () => new Response("oops", { status: 502 })) as unknown as OutboundFetch };
    await expect(btc.broadcast(broken, { raw: "00", txHash: tx.txHash, feeUpperBound: 1n })).rejects.toThrow(/did not accept the payment cleanly/);
  });

  it("Solana: a refused fee budget or a node on the wrong network never signs", async () => {
    const sol = solanaAdapter();
    const made = await sol.generateKey("testnet");
    const to = base58Encode(new Uint8Array(randomBytes(32)));
    const onMainnet: ChainContext = {
      network: "testnet",
      rpcUrl: "https://api.devnet.solana.com",
      fetch: rpc((method) => json({ result: method === "getGenesisHash" ? "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d" : { value: 0 } })),
    };
    await expect(sol.signTransfer(onMainnet, { privateKey: made.privateKey, from: made.address, to, amount: 10_000_000n, maxFee: 10_000n })).rejects.toThrow(/not on the test network/);
    await expect(sol.signTransfer(onMainnet, { privateKey: made.privateKey, from: made.address, to, amount: 10_000_000n, maxFee: 1n })).rejects.toThrow(/reserve enough/);
  });
});

describe("Hyperliquid answers", () => {
  const hl = hyperliquidAdapter(missingLibs);
  const ctxWith = (answer: () => Response): ChainContext => ({ network: "testnet", rpcUrl: "https://api.hyperliquid-testnet.xyz", fetch: (async () => answer()) as unknown as OutboundFetch });
  const withdraw = { raw: JSON.stringify({ action: { type: "withdraw3" }, nonce: 1 }), txHash: "hyperliquid-withdraw-1", feeUpperBound: 1_000_000n };
  const order = { raw: JSON.stringify({ action: { type: "order" }, nonce: 2 }), txHash: "hyperliquid-order-2", feeUpperBound: 0n };

  it("treats HTTP trouble as unclear, a re-used nonce as already accepted, and a clear refusal as a refusal", async () => {
    await expect(hl.broadcast(ctxWith(() => new Response("", { status: 502 })), withdraw)).rejects.toThrow(/HTTP 502/);
    await expect(hl.broadcast(ctxWith(() => json({ status: "err", response: "Nonce already used" })), withdraw)).resolves.toMatchObject({ status: "confirmed" });
    await expect(hl.broadcast(ctxWith(() => json({ status: "err", response: "Insufficient balance" })), withdraw)).resolves.toMatchObject({ status: "failed" });
    await expect(hl.broadcast(ctxWith(() => json({ status: "ok", response: { data: { statuses: [{ error: "Order price too far" }] } } })), order)).resolves.toMatchObject({ status: "failed" });
    await expect(hl.broadcast(ctxWith(() => json({ status: "ok", response: { data: { statuses: [{ resting: { oid: 5 } }] } } })), order)).resolves.toMatchObject({ status: "confirmed" });
  });

  it("refuses account numbers that are not numbers (S3)", async () => {
    await expect(hl.accountState(ctxWith(() => json({ marginSummary: { accountValue: "lots" }, withdrawable: "1" })), "0x01")).rejects.toThrow(/not a number/);
  });
});

describe("mined-but-rejected payments keep their paid fee (follow-up 1)", () => {
  it("Ethereum: a reverted receipt reports gasUsed x effectiveGasPrice, never more than the fee budget", async () => {
    const eth = ethereumAdapter(missingLibs);
    let receipt: Record<string, unknown> = { status: "0x0", gasUsed: "0x5208", effectiveGasPrice: "0x3b9aca00" };
    const ctx: ChainContext = {
      network: "testnet",
      rpcUrl: "https://rpc.example.org",
      fetch: (async () => json({ result: receipt })) as unknown as OutboundFetch,
    };
    const tx = { txHash: "0xabc", raw: null, chainDetail: { nonce: "1" }, from: "0x01", feeUpperBound: 10n ** 15n, checkedAt: new Date() };
    await expect(eth.getTxStatus(ctx, tx)).resolves.toEqual({ status: "reverted", feePaid: 21_000n * 1_000_000_000n });
    receipt = { status: "0x0", gasUsed: "0x5208", effectiveGasPrice: "0xffffffffffff" }; // more than the budget: a lying node
    await expect(eth.getTxStatus(ctx, tx)).resolves.toEqual({ status: "reverted", feePaid: 10n ** 15n });
    receipt = { status: "0x0" };
    await expect(eth.getTxStatus(ctx, tx)).resolves.toEqual({ status: "reverted", feePaid: 10n ** 15n });
  });
});

describe("Hyperliquid status lookups (follow-up 3)", () => {
  const hl = hyperliquidAdapter(missingLibs);
  const nonce = Date.parse("2026-10-17T10:00:00Z");
  const order = { txHash: `hyperliquid-order-${nonce}`, raw: JSON.stringify({ action: { type: "order" } }), chainDetail: { nonce, cloid: "0x" + "ab".repeat(16) }, from: "0x01", feeUpperBound: 0n };
  const withdraw = { txHash: `hyperliquid-withdraw-${nonce}`, raw: JSON.stringify({ action: { type: "withdraw3" } }), chainDetail: { nonce }, from: "0x01", feeUpperBound: 1_000_000n };
  const soon = new Date(nonce + 60 * 60_000);
  const late = new Date(nonce + 3 * 24 * 60 * 60_000);
  const ctxWith = (answer: (body: any) => Response): ChainContext => ({
    network: "testnet",
    rpcUrl: "https://api.hyperliquid-testnet.xyz",
    fetch: (async (_u: string, init?: RequestInit) => answer(JSON.parse(String(init?.body)))) as unknown as OutboundFetch,
  });

  it("finds an order by its own order id, and only gives up once the nonce can no longer be accepted", async () => {
    let seen: unknown = null;
    const found = ctxWith((body) => {
      seen = body;
      return json({ status: "order", order: { status: "filled", order: {} } });
    });
    await expect(hl.getTxStatus(found, { ...order, checkedAt: soon })).resolves.toBe("confirmed");
    expect(seen).toEqual({ type: "orderStatus", user: "0x01", oid: order.chainDetail.cloid });
    const rejected = ctxWith(() => json({ status: "order", order: { status: "perpMarginRejected" } }));
    await expect(hl.getTxStatus(rejected, { ...order, checkedAt: soon })).resolves.toBe("failed");
    const unknown = ctxWith(() => json({ status: "unknownOid" }));
    await expect(hl.getTxStatus(unknown, { ...order, checkedAt: soon })).resolves.toBe("unknown");
    await expect(hl.getTxStatus(unknown, { ...order, checkedAt: late })).resolves.toBe("failed");
    const down = ctxWith(() => new Response("", { status: 502 }));
    await expect(hl.getTxStatus(down, { ...order, checkedAt: late })).rejects.toThrow(/HTTP 502/);
  });

  it("finds a withdrawal in the account history by its nonce", async () => {
    const history = (entries: unknown[]) => ctxWith(() => json(entries));
    await expect(hl.getTxStatus(history([{ time: nonce + 1, delta: { type: "withdraw", usdc: "10.0", nonce, fee: "1.0" } }]), { ...withdraw, checkedAt: soon })).resolves.toBe("confirmed");
    await expect(hl.getTxStatus(history([{ delta: { type: "withdraw", nonce: nonce + 5 } }]), { ...withdraw, checkedAt: soon })).resolves.toBe("unknown");
    await expect(hl.getTxStatus(history([]), { ...withdraw, checkedAt: late })).resolves.toBe("failed");
  });
});
