/**
 * DUR-3995: Paperclip's own Claude key, set from the settings page.
 *
 * Covers: the key is stored encrypted (never in plaintext), it is live
 * without a restart, it wins over the key from the server's environment and
 * falls back to it when removed, nothing that leaves the service carries the
 * value, the Test button reports Claude's exact error, and -- the DUR-3994
 * invariant this feature must not undo -- a real spawned child never sees the
 * value anywhere in its environment.
 *
 * Every value used here is a random decoy ("canary"); assertions compare
 * booleans so a failure never prints a key.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { createDb, instanceServerAnthropicKey } from "@paperclipai/db";
import { runChildProcess } from "@paperclipai/adapter-utils/server-utils";
import { stripServerSecrets } from "@paperclipai/adapter-utils/server-env-secrets";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  captureServerOnlyAnthropicApiKey,
  readAnthropicApiKey,
  resetCapturedServerAnthropicApiKeyForTests,
} from "../env-values.js";
import {
  describeAnthropicTestError,
  describeServerAnthropicKeyStatus,
  installServerAnthropicKeyReader,
  resetServerAnthropicKeyCacheForTests,
  scrubKey,
  serverAnthropicKeyHint,
  serverAnthropicKeyService,
} from "../services/server-anthropic-key.js";

const canaryKey = () => `sk-ant-api03-DUR3995${randomBytes(24).toString("hex")}`;

describe("DUR-3995 pure helpers", () => {
  it("shows at most the last four characters of a key", () => {
    const key = canaryKey();
    const hint = serverAnthropicKeyHint(key);
    expect(hint).toBe(`…${key.slice(-4)}`);
    expect(hint.length).toBe(5);
    expect(key.includes(hint.slice(1))).toBe(true);
    expect(serverAnthropicKeyHint("abc")).toBe("…");
  });

  it("never lets a key travel back out inside a message", () => {
    const key = canaryKey();
    const scrubbed = scrubKey(`upstream said: ${key} is invalid`, key);
    expect(scrubbed.includes(key)).toBe(false);
    expect(scrubbed).toContain("[key]");
    // Even a DIFFERENT key-shaped string in the message is removed.
    expect(scrubKey(`saw ${canaryKey()}`, "unrelated").includes("sk-ant-")).toBe(false);
  });

  it("reports an unexpected failure in plain words, without the key", () => {
    const key = canaryKey();
    const message = describeAnthropicTestError(new Error(`connect ECONNREFUSED for ${key}`), key);
    expect(message.includes(key)).toBe(false);
    expect(message).toContain("Could not reach Claude");
  });

  it("tells a stored key, a server-file key and no key at all apart", () => {
    const none = describeServerAnthropicKeyStatus(null, false);
    expect(none.configured).toBe(false);
    expect(none.source).toBe(null);

    const fromEnv = describeServerAnthropicKeyStatus(null, true);
    expect(fromEnv.configured).toBe(true);
    expect(fromEnv.source).toBe("environment");
    expect(fromEnv.hint).toBe(null);

    const stored = describeServerAnthropicKeyStatus(
      {
        hint: "…ab12",
        fingerprintSha256: "0123456789ab",
        savedAt: new Date("2026-09-22T10:00:00.000Z"),
        savedByUserId: "user-1",
        lastTestAt: null,
        lastTestOk: null,
        lastTestMessage: null,
      },
      true,
    );
    // A stored key always wins over the server-file one, in the status too.
    expect(stored.source).toBe("stored");
    expect(stored.headline).toContain("Press Test");
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping DUR-3995 database tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("DUR-3995 server Anthropic key service", () => {
  let stopDb: (() => Promise<void>) | null = null;
  let db!: ReturnType<typeof createDb>;
  const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const previousPlainKey = process.env.ANTHROPIC_API_KEY;
  const secretsTmpDir = path.join(os.tmpdir(), `paperclip-dur3995-${randomUUID()}`);

  beforeAll(async () => {
    mkdirSync(secretsTmpDir, { recursive: true });
    process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(secretsTmpDir, "master.key");
    delete process.env.ANTHROPIC_API_KEY;
    const started = await startEmbeddedPostgresTestDatabase("dur3995-server-anthropic-key");
    stopDb = started.cleanup;
    db = createDb(started.connectionString);
  }, 30_000);

  afterEach(async () => {
    resetServerAnthropicKeyCacheForTests();
    resetCapturedServerAnthropicApiKeyForTests();
    delete process.env.ANTHROPIC_API_KEY;
    await db.delete(instanceServerAnthropicKey);
  });

  afterAll(async () => {
    await stopDb?.();
    if (previousKeyFile === undefined) delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
    else process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = previousKeyFile;
    if (previousPlainKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previousPlainKey;
    rmSync(secretsTmpDir, { recursive: true, force: true });
  });

  function service(onCall?: (key: string) => Promise<void>) {
    return serverAnthropicKeyService(db as never, {
      callAnthropic: onCall ?? (async () => {}),
    });
  }

  it("stores the key encrypted, never in plaintext, and never returns it", async () => {
    const key = canaryKey();
    await installServerAnthropicKeyReader(db as never);
    const result = await service().save({ key, userId: "user-1" });

    const [row] = await db.select().from(instanceServerAnthropicKey);
    expect(row.keySealed.startsWith("instance-server-anthropic-key:")).toBe(true);
    expect(row.keySealed.includes(key)).toBe(false);
    expect(JSON.stringify(row).includes(key)).toBe(false);
    expect(row.hint).toBe(`…${key.slice(-4)}`);

    expect(result.ok).toBe(true);
    expect(JSON.stringify(result).includes(key)).toBe(false);
    expect(result.status.source).toBe("stored");
  });

  it("is live for the server's own Claude calls without a restart", async () => {
    const key = canaryKey();
    await installServerAnthropicKeyReader(db as never);
    expect(readAnthropicApiKey()).toBeUndefined();

    await service().save({ key, userId: null });
    // No restart, no re-install: the very next read sees it.
    expect(readAnthropicApiKey() === key).toBe(true);
  });

  it("is picked up at start-up by a server that was restarted", async () => {
    const key = canaryKey();
    await installServerAnthropicKeyReader(db as never);
    await service().save({ key, userId: null });

    // Simulate a restart: forget everything held in memory, then boot again.
    resetServerAnthropicKeyCacheForTests();
    expect(readAnthropicApiKey()).toBeUndefined();
    await installServerAnthropicKeyReader(db as never);
    expect(readAnthropicApiKey() === key).toBe(true);
  });

  it("wins over the key from the server's environment, and falls back to it when removed", async () => {
    const envKey = canaryKey();
    const storedKey = canaryKey();
    captureServerOnlyAnthropicApiKey({ PAPERCLIP_SERVER_ANTHROPIC_API_KEY: envKey });
    await installServerAnthropicKeyReader(db as never);

    // Existing installs keep working with nothing saved.
    expect(readAnthropicApiKey() === envKey).toBe(true);
    expect((await service().getStatus()).source).toBe("environment");

    await service().save({ key: storedKey, userId: null });
    expect(readAnthropicApiKey() === storedKey).toBe(true);

    const afterRemove = await service().remove();
    expect(afterRemove.source).toBe("environment");
    expect(readAnthropicApiKey() === envKey).toBe(true);
  });

  it("reports exactly what Claude said when the key is wrong, without the key", async () => {
    const key = canaryKey();
    await installServerAnthropicKeyReader(db as never);
    const failing = service(async () => {
      throw new Error(`invalid x-api-key ${key}`);
    });

    const result = await failing.save({ key, userId: null });
    expect(result.ok).toBe(false);
    expect(result.message.includes(key)).toBe(false);
    expect(result.message).toContain("invalid x-api-key");
    // The key is kept even though the check failed, and the page says so.
    expect(result.status.source).toBe("stored");
    expect(result.status.lastTestOk).toBe(false);
    expect(result.status.headline).toContain("did not accept");

    const retested = await failing.test();
    expect(retested.ok).toBe(false);
    expect(JSON.stringify(retested).includes(key)).toBe(false);
  });

  it("says so plainly when there is no key to test", async () => {
    await installServerAnthropicKeyReader(db as never);
    const result = await service().test();
    expect(result.ok).toBe(false);
    expect(result.message).toBe("There is no Claude key to test yet.");
  });

  // ─────────────────────────────────────────────────────────────────────────
  // DUR-3994 Stage 0/1 invariant: this key must never reach a spawned agent.
  // ─────────────────────────────────────────────────────────────────────────
  it("never reaches a spawned agent's environment", async () => {
    const key = canaryKey();
    await installServerAnthropicKeyReader(db as never);
    await service().save({ key, userId: null });
    // The server itself can use it...
    expect(readAnthropicApiKey() === key).toBe(true);

    // ...but it is held in memory, so there is nothing in process.env for a
    // child to inherit in the first place.
    expect(JSON.stringify(process.env).includes(key)).toBe(false);

    // A real child, spawned the way agents are: its whole environment must
    // not contain the value under ANY name.
    const child = await runChildProcess(
      "dur3995-child",
      process.execPath,
      ["-e", "process.stdout.write(JSON.stringify(process.env))"],
      { cwd: process.cwd(), env: {}, timeoutSec: 20, graceSec: 2, onLog: async () => {} },
    );
    expect(child.exitCode).toBe(0);
    expect(child.stdout.includes(key)).toBe(false);

    // And if anything ever did try to forward it under the server-only name,
    // the existing name rule still removes it.
    expect(stripServerSecrets({ PAPERCLIP_SERVER_ANTHROPIC_API_KEY: key }, {})).toEqual({});
  }, 30_000);
});
