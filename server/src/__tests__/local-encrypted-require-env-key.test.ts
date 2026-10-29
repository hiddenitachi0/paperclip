import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync, chmodSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { localEncryptedProvider } from "../secrets/local-encrypted-provider.js";
import { resetServerSecretsForTests } from "../server-secrets.js";

const NAMES = [
  "PAPERCLIP_SECRETS_REQUIRE_ENV_KEY",
  "PAPERCLIP_SECRETS_MASTER_KEY",
  "PAPERCLIP_SECRETS_MASTER_KEY_FILE",
] as const;

describe("local_encrypted PAPERCLIP_SECRETS_REQUIRE_ENV_KEY (DUR-5064)", () => {
  const previous = new Map<string, string | undefined>();
  let dir: string;
  let keyFile: string;

  beforeEach(() => {
    for (const name of NAMES) previous.set(name, process.env[name]);
    for (const name of NAMES) delete process.env[name];
    resetServerSecretsForTests(["PAPERCLIP_SECRETS_MASTER_KEY"]);
    dir = mkdtempSync(path.join(os.tmpdir(), "paperclip-require-env-key-"));
    keyFile = path.join(dir, "secrets", "master.key");
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = keyFile;
  });

  afterEach(() => {
    for (const name of NAMES) {
      const value = previous.get(name);
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  const envKey = () => randomBytes(32).toString("base64");

  it("flag set + env key present: works and never touches a key file", async () => {
    process.env.PAPERCLIP_SECRETS_REQUIRE_ENV_KEY = "true";
    process.env.PAPERCLIP_SECRETS_MASTER_KEY = envKey();

    const prepared = await localEncryptedProvider.createSecret!({ value: "hunter2" } as never);
    const resolved = await localEncryptedProvider.resolveVersion!({ material: prepared.material } as never);
    expect(resolved).toBe("hunter2");
    expect(existsSync(path.dirname(keyFile))).toBe(false);

    const health = await localEncryptedProvider.healthCheck();
    expect(health).toMatchObject({ status: "ok", details: { keySource: "env" } });
  });

  it.each(["true", "1", "TRUE"])("flag=%s + no key: create and resolve throw, no file is created", async (flag) => {
    process.env.PAPERCLIP_SECRETS_REQUIRE_ENV_KEY = flag;

    await expect(localEncryptedProvider.createSecret!({ value: "x" } as never)).rejects.toThrow(
      /PAPERCLIP_SECRETS_MASTER_KEY was not provided/,
    );
    await expect(localEncryptedProvider.createVersion!({ value: "x" } as never)).rejects.toThrow(
      /PAPERCLIP_SECRETS_REQUIRE_ENV_KEY/,
    );
    await expect(
      localEncryptedProvider.resolveVersion!({
        material: { scheme: "local_encrypted_v1", iv: "", tag: "", ciphertext: "" },
      } as never),
    ).rejects.toThrow(/was not provided/);
    expect(existsSync(path.dirname(keyFile))).toBe(false);
  });

  it("flag set + no key + an existing key file: the file is not read or chmodded", async () => {
    process.env.PAPERCLIP_SECRETS_REQUIRE_ENV_KEY = "1";
    mkdirSync(path.dirname(keyFile), { recursive: true });
    writeFileSync(keyFile, envKey(), { mode: 0o644 });
    chmodSync(keyFile, 0o644);

    await expect(localEncryptedProvider.createSecret!({ value: "x" } as never)).rejects.toThrow();
    expect(statSync(keyFile).mode & 0o777).toBe(0o644);

    const health = await localEncryptedProvider.healthCheck({ deploymentMode: "authenticated" });
    expect(health).toMatchObject({ status: "error", details: { keySource: "missing" } });
    expect(health.details).not.toHaveProperty("keyFilePath");
    expect(statSync(keyFile).mode & 0o777).toBe(0o644);
  });

  it("flag set + no key: health is an error naming the problem, with no key material", async () => {
    process.env.PAPERCLIP_SECRETS_REQUIRE_ENV_KEY = "true";
    const health = await localEncryptedProvider.healthCheck();
    expect(health.status).toBe("error");
    expect(health.details).toEqual({ keySource: "missing" });
    expect(health.message).toContain("PAPERCLIP_SECRETS_MASTER_KEY");
    expect(existsSync(path.dirname(keyFile))).toBe(false);
  });

  it("error text never contains a key value", async () => {
    process.env.PAPERCLIP_SECRETS_REQUIRE_ENV_KEY = "true";
    process.env.PAPERCLIP_SECRETS_MASTER_KEY = "not-a-valid-key-value-zzz";
    const health = await localEncryptedProvider.healthCheck();
    expect(health.status).toBe("error");
    expect(JSON.stringify(health)).not.toContain("not-a-valid-key-value-zzz");
    await expect(localEncryptedProvider.createSecret!({ value: "x" } as never)).rejects.toThrow(
      expect.objectContaining({ message: expect.not.stringContaining("not-a-valid-key-value-zzz") }),
    );
  });

  it("flag unset: existing behaviour is unchanged (key file is created and used)", async () => {
    const prepared = await localEncryptedProvider.createSecret!({ value: "hunter2" } as never);
    expect(existsSync(keyFile)).toBe(true);
    expect(statSync(keyFile).mode & 0o777).toBe(0o600);
    expect(await localEncryptedProvider.resolveVersion!({ material: prepared.material } as never)).toBe("hunter2");

    const health = await localEncryptedProvider.healthCheck();
    expect(health).toMatchObject({ status: "ok", details: { keySource: "file", keyFilePath: keyFile } });
    expect(health.warnings ?? []).toEqual([]);
  });

  it.each(["false", "0", ""])("flag=%j is treated as unset", async (flag) => {
    process.env.PAPERCLIP_SECRETS_REQUIRE_ENV_KEY = flag;
    await localEncryptedProvider.createSecret!({ value: "x" } as never);
    expect(existsSync(keyFile)).toBe(true);
  });

  it("key from a file in an authenticated deployment warns that agent runs can read it", async () => {
    await localEncryptedProvider.createSecret!({ value: "x" } as never);

    const authenticated = await localEncryptedProvider.healthCheck({ deploymentMode: "authenticated" });
    expect(authenticated.status).toBe("warn");
    expect(authenticated.details).toMatchObject({ keySource: "file" });
    expect(authenticated.warnings?.join("\n")).toContain("readable by agent runs");
    expect(authenticated.warnings?.join("\n")).toContain("secrets-master-key-move");

    const local = await localEncryptedProvider.healthCheck({ deploymentMode: "local_trusted" });
    expect(local.warnings ?? []).toEqual([]);
  });

  it("key from env in an authenticated deployment has no agent-readable warning", async () => {
    process.env.PAPERCLIP_SECRETS_MASTER_KEY = envKey();
    const health = await localEncryptedProvider.healthCheck({ deploymentMode: "authenticated" });
    expect(health).toMatchObject({ status: "ok", details: { keySource: "env" } });
    expect(health.warnings ?? []).toEqual([]);
  });
});
