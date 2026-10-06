import { describe, expect, it } from "vitest";
import { containsUnredactedSecret, isSecretBearingPath, maskFileForScreen, redactForScreen } from "../services/brag-secret-mask.js";

describe("brag secret mask (DUR-4520)", () => {
  it("never reads credential-bearing paths", () => {
    for (const p of [".env", ".env.production", "apps/api/.env.local", "certs/server.pem", "id_rsa", ".ssh/config", "docker-compose.prod.yml", "infra/prod.tfvars", ".npmrc", "x/.aws/credentials"]) {
      expect(isSecretBearingPath(p), p).toBe(true);
    }
    for (const p of ["README.md", "src/index.ts", "docs/env-guide.md", "package.json"]) {
      expect(isSecretBearingPath(p), p).toBe(false);
    }
  });

  it("skips a secret file entirely, with no content", () => {
    expect(maskFileForScreen(".env", "API_KEY=abcd1234efgh5678")).toEqual({ path: ".env", content: null, skipped: true });
  });

  it("redacts key=value, url credentials, private keys, bearer headers and opaque tokens", () => {
    const input = [
      "DATABASE_PASSWORD=hunter2hunter2",
      '"api_key": "sk_live_abcdefghijkl"',
      "postgres://admin:s3cretpw@db.internal:5432/app",
      "Authorization: Bearer abcdef0123456789abcdef",
      "-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----",
      "token a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8",
      "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
    ].join("\n");
    const out = redactForScreen(input);
    for (const leak of ["hunter2hunter2", "sk_live_abcdefghijkl", "s3cretpw", "abcdef0123456789abcdef", "MIIEow", "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8", "ghp_abcdefghijklmnopqrstuvwxyz0123456789"]) {
      expect(out).not.toContain(leak);
    }
  });

  it("leaves ordinary prose alone and is idempotent", () => {
    const prose = "Paperclip runs your AI company with a budget for every agent.";
    expect(redactForScreen(prose)).toBe(prose);
    const once = redactForScreen("SECRET_KEY=topsecretvalue1");
    expect(redactForScreen(once)).toBe(once);
    expect(containsUnredactedSecret(once)).toBe(false);
  });
});
