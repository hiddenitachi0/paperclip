import { describe, expect, it } from "vitest";
import {
  openSecretBundle,
  sealSecretBundle,
  SecretBundlePassphraseError,
} from "../services/portable-secret-bundle.js";

describe("portable secret bundle", () => {
  const values = {
    "agent:fork-lead:GITHUB_TOKEN": "ghp_write_xxx",
    "project:dashboard:OPENAI_API_KEY": "sk-yyy",
    "CLAUDE_CODE_OAUTH_TOKEN": "sk-ant-oat-zzz",
  };

  it("round-trips values with the correct passphrase", () => {
    const blob = sealSecretBundle(values, "correct horse battery staple");
    expect(openSecretBundle(blob, "correct horse battery staple")).toEqual(values);
  });

  it("produces an opaque blob that does not leak plaintext values", () => {
    const blob = sealSecretBundle(values, "pw");
    expect(blob).not.toContain("ghp_write_xxx");
    expect(blob).not.toContain("sk-ant-oat-zzz");
    // Decoding the base64 envelope must not reveal plaintext either.
    expect(Buffer.from(blob, "base64").toString("utf8")).not.toContain("ghp_write_xxx");
  });

  it("uses a fresh salt+iv so the same input seals to different blobs", () => {
    expect(sealSecretBundle(values, "pw")).not.toEqual(sealSecretBundle(values, "pw"));
  });

  it("throws a clean passphrase error on the wrong passphrase", () => {
    const blob = sealSecretBundle(values, "right");
    expect(() => openSecretBundle(blob, "wrong")).toThrow(SecretBundlePassphraseError);
  });

  it("rejects a tampered ciphertext (GCM auth)", () => {
    const blob = sealSecretBundle(values, "pw");
    const env = JSON.parse(Buffer.from(blob, "base64").toString("utf8"));
    const ct = Buffer.from(env.ct, "base64");
    ct[0] ^= 0xff; // flip a byte
    env.ct = ct.toString("base64");
    const tampered = Buffer.from(JSON.stringify(env), "utf8").toString("base64");
    expect(() => openSecretBundle(tampered, "pw")).toThrow(SecretBundlePassphraseError);
  });

  it("rejects malformed / non-bundle input", () => {
    expect(() => openSecretBundle("not-base64-json", "pw")).toThrow(SecretBundlePassphraseError);
  });

  it("requires a non-empty passphrase to seal", () => {
    expect(() => sealSecretBundle(values, "")).toThrow();
  });
});
