/**
 * DUR-4996 (security review B1): the real-money lock cannot be lifted from a
 * .env file. Agents can write the instance .env, so only the real process
 * environment (the deploy settings) may carry PAPERCLIP_CRYPTO_REAL_MONEY.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadEnvFileIntoProcessEnv } from "../env-file-loader.js";
import { isCryptoRealMoneyAllowed } from "../services/crypto-real-money-lock.js";

const dirs: string[] = [];
const tempDir = (prefix: string) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
};

const saved = {
  lock: process.env.PAPERCLIP_CRYPTO_REAL_MONEY,
  other: process.env.DUR4996_HARMLESS_SETTING,
  config: process.env.PAPERCLIP_CONFIG,
  home: process.env.PAPERCLIP_HOME,
};

function restore(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

beforeEach(() => {
  delete process.env.PAPERCLIP_CRYPTO_REAL_MONEY;
  delete process.env.DUR4996_HARMLESS_SETTING;
});

afterEach(() => {
  restore("PAPERCLIP_CRYPTO_REAL_MONEY", saved.lock);
  restore("DUR4996_HARMLESS_SETTING", saved.other);
  restore("PAPERCLIP_CONFIG", saved.config);
  restore("PAPERCLIP_HOME", saved.home);
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("real-money lock and .env files", () => {
  it("a .env file with PAPERCLIP_CRYPTO_REAL_MONEY=allowed leaves the lock on", () => {
    const dir = tempDir("dur4996-env-");
    const file = path.join(dir, ".env");
    fs.writeFileSync(file, "PAPERCLIP_CRYPTO_REAL_MONEY=allowed\nDUR4996_HARMLESS_SETTING=from-file\n");
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    loadEnvFileIntoProcessEnv(file, "the instance .env file");

    expect(process.env.PAPERCLIP_CRYPTO_REAL_MONEY).toBeUndefined();
    expect(isCryptoRealMoneyAllowed()).toBe(false);
    // Other settings still load, and the refusal is logged by name only.
    expect(process.env.DUR4996_HARMLESS_SETTING).toBe("from-file");
    const logged = stderr.mock.calls.map((c) => String(c[0])).join("");
    expect(logged).toContain("PAPERCLIP_CRYPTO_REAL_MONEY");
    expect(logged).not.toContain("allowed\n");
  });

  it("the real process environment still decides: allowed there is honoured, a .env cannot change it", () => {
    process.env.PAPERCLIP_CRYPTO_REAL_MONEY = "allowed";
    const dir = tempDir("dur4996-env-");
    const file = path.join(dir, ".env");
    fs.writeFileSync(file, "PAPERCLIP_CRYPTO_REAL_MONEY=nope\n");
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    loadEnvFileIntoProcessEnv(file, "the instance .env file");

    expect(process.env.PAPERCLIP_CRYPTO_REAL_MONEY).toBe("allowed");
  });

  it("config.ts applies this to the instance .env and the working-directory .env", async () => {
    const instanceDir = tempDir("dur4996-instance-");
    fs.writeFileSync(path.join(instanceDir, "config.json"), "{}\n");
    fs.writeFileSync(path.join(instanceDir, ".env"), "PAPERCLIP_CRYPTO_REAL_MONEY=allowed\n");
    const cwdDir = tempDir("dur4996-cwd-");
    fs.writeFileSync(path.join(cwdDir, ".env"), "PAPERCLIP_CRYPTO_REAL_MONEY=allowed\nDUR4996_HARMLESS_SETTING=from-cwd\n");
    process.env.PAPERCLIP_CONFIG = path.join(instanceDir, "config.json");
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    vi.spyOn(process, "cwd").mockReturnValue(cwdDir);

    vi.resetModules();
    await import("../config.js");

    expect(process.env.PAPERCLIP_CRYPTO_REAL_MONEY).toBeUndefined();
    expect(process.env.DUR4996_HARMLESS_SETTING).toBe("from-cwd");
    const lock = await import("../services/crypto-real-money-lock.js");
    expect(lock.isCryptoRealMoneyAllowed()).toBe(false);
  });
});
