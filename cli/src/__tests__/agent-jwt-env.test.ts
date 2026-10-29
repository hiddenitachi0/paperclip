import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ensureAgentJwtSecret,
  loadPaperclipEnvFile,
  mergePaperclipEnvEntries,
  readAgentJwtSecretFromEnv,
  readPaperclipEnvEntries,
  resolveAgentJwtEnvFile,
} from "../config/env.js";
import { agentJwtSecretCheck } from "../checks/agent-jwt-secret-check.js";

const ORIGINAL_ENV = { ...process.env };

function tempConfigPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-jwt-env-"));
  const configDir = path.join(dir, "custom");
  fs.mkdirSync(configDir, { recursive: true });
  return path.join(configDir, "config.json");
}

describe("agent jwt env helpers", () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("writes .env next to explicit config path", () => {
    const configPath = tempConfigPath();
    const result = ensureAgentJwtSecret(configPath);

    expect(result.created).toBe(true);

    const envPath = resolveAgentJwtEnvFile(configPath);
    expect(fs.existsSync(envPath)).toBe(true);
    const contents = fs.readFileSync(envPath, "utf-8");
    expect(contents).toContain("PAPERCLIP_AGENT_JWT_SECRET=");
  });

  it("loads secret from .env next to explicit config path", () => {
    const configPath = tempConfigPath();
    const envPath = resolveAgentJwtEnvFile(configPath);
    fs.writeFileSync(envPath, "PAPERCLIP_AGENT_JWT_SECRET=test-secret\n", { mode: 0o600 });

    const loaded = readAgentJwtSecretFromEnv(configPath);
    expect(loaded).toBe("test-secret");
    expect(process.env.PAPERCLIP_AGENT_JWT_SECRET).toBe("test-secret");
  });

  it("doctor check passes when secret exists in adjacent .env", () => {
    const configPath = tempConfigPath();
    const envPath = resolveAgentJwtEnvFile(configPath);
    fs.writeFileSync(envPath, "PAPERCLIP_AGENT_JWT_SECRET=check-secret\n", { mode: 0o600 });

    const result = agentJwtSecretCheck(configPath);
    expect(result.status).toBe("pass");
  });

  it("quotes hash-prefixed env values so dotenv round-trips them", () => {
    const configPath = tempConfigPath();
    const envPath = resolveAgentJwtEnvFile(configPath);

    mergePaperclipEnvEntries(
      {
        PAPERCLIP_WORKTREE_COLOR: "#439edb",
      },
      envPath,
    );

    const contents = fs.readFileSync(envPath, "utf-8");
    expect(contents).toContain('PAPERCLIP_WORKTREE_COLOR="#439edb"');
    expect(readPaperclipEnvEntries(envPath).PAPERCLIP_WORKTREE_COLOR).toBe("#439edb");
  });
});

describe("env file refused names (DUR-5042)", () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env.PAPERCLIP_CRYPTO_REAL_MONEY;
    delete process.env.PAPERCLIP_AGENT_JWT_SECRET;
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("does not load PAPERCLIP_CRYPTO_REAL_MONEY from the instance .env", () => {
    const configPath = tempConfigPath();
    fs.writeFileSync(
      resolveAgentJwtEnvFile(configPath),
      "PAPERCLIP_CRYPTO_REAL_MONEY=allowed\nPAPERCLIP_AGENT_JWT_SECRET=kept-secret\n",
      { mode: 0o600 },
    );

    loadPaperclipEnvFile(configPath);

    expect(process.env.PAPERCLIP_CRYPTO_REAL_MONEY).toBeUndefined();
    expect(process.env.PAPERCLIP_AGENT_JWT_SECRET).toBe("kept-secret");
  });

  it("keeps a real process env value over the .env file", () => {
    const configPath = tempConfigPath();
    fs.writeFileSync(
      resolveAgentJwtEnvFile(configPath),
      "PAPERCLIP_CRYPTO_REAL_MONEY=allowed\nPAPERCLIP_AGENT_JWT_SECRET=from-file\n",
      { mode: 0o600 },
    );
    process.env.PAPERCLIP_CRYPTO_REAL_MONEY = "locked";
    process.env.PAPERCLIP_AGENT_JWT_SECRET = "from-env";

    loadPaperclipEnvFile(configPath);

    expect(process.env.PAPERCLIP_CRYPTO_REAL_MONEY).toBe("locked");
    expect(process.env.PAPERCLIP_AGENT_JWT_SECRET).toBe("from-env");
  });
});
