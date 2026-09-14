import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { UsageSummary } from "@paperclipai/adapter-utils";
import { PROMPT_CACHE_USAGE_KEYS, pickPromptCacheUsageFields } from "../services/heartbeat.ts";

// DUR-3943: heartbeat_runs.usage_json recorded cache READS (cachedInputTokens)
// but never cache WRITES, although writes are billed at 1.25x-2x fresh input.
// In a real Claude run (Opus 4.8, 32 turns) writes cost $0.62 against $0.60
// for all reads, yet usage_json showed only the reads. These fields make the
// write side, and the standing context size, visible per run.

describe("pickPromptCacheUsageFields", () => {
  it("copies cache writes, the 1-hour share and the first-call prompt size from adapter usage", () => {
    const usage: UsageSummary = {
      inputTokens: 3742,
      cachedInputTokens: 1_194_217,
      outputTokens: 20_348,
      cacheCreationInputTokens: 61_868,
      cacheCreation1hInputTokens: 61_868,
      firstCallPromptTokens: 22_897,
    };

    expect(pickPromptCacheUsageFields(usage)).toStrictEqual({
      cacheCreationInputTokens: 61_868,
      cacheCreation1hInputTokens: 61_868,
      firstCallPromptTokens: 22_897,
    });
  });

  it("adds nothing for adapters that report no prompt cache detail", () => {
    expect(pickPromptCacheUsageFields({ inputTokens: 10, outputTokens: 5, cachedInputTokens: 2 })).toStrictEqual({});
    expect(pickPromptCacheUsageFields(null)).toStrictEqual({});
    expect(pickPromptCacheUsageFields(undefined)).toStrictEqual({});
  });

  it("keeps a reported zero (a run that read everything from cache) and drops non-numbers", () => {
    const usage = {
      inputTokens: 1,
      outputTokens: 1,
      cacheCreationInputTokens: 0,
      cacheCreation1hInputTokens: Number.NaN,
      firstCallPromptTokens: "big" as unknown as number,
    } satisfies UsageSummary;

    expect(pickPromptCacheUsageFields(usage)).toStrictEqual({ cacheCreationInputTokens: 0 });
  });

  it("stores whole non-negative token counts", () => {
    expect(
      pickPromptCacheUsageFields({ inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: -4, firstCallPromptTokens: 12.9 }),
    ).toStrictEqual({ cacheCreationInputTokens: 0, firstCallPromptTokens: 12 });
  });

  it("never copies the token totals that heartbeat nets against earlier runs of the same session", () => {
    // inputTokens / cachedInputTokens / outputTokens go through
    // resolveNormalizedUsageForSession; the per-run cache fields must not
    // overwrite them when both are spread into usage_json.
    expect(PROMPT_CACHE_USAGE_KEYS).not.toContain("inputTokens");
    expect(PROMPT_CACHE_USAGE_KEYS).not.toContain("cachedInputTokens");
    expect(PROMPT_CACHE_USAGE_KEYS).not.toContain("outputTokens");
  });

  it("is spread into the usage_json that heartbeat stores for every run", () => {
    // usage_json is assembled inside the run executor, which no unit test
    // drives end to end; read the real source so dropping the wiring fails here.
    const source = readFileSync(fileURLToPath(new URL("../services/heartbeat.ts", import.meta.url)), "utf8");
    const usageJsonStart = source.indexOf("const usageJson =");
    expect(usageJsonStart).toBeGreaterThan(-1);
    const usageJsonBlock = source.slice(usageJsonStart, source.indexOf("const resolvedAdapterConfigMetadata", usageJsonStart));
    expect(usageJsonBlock).toContain("...pickPromptCacheUsageFields(adapterResult.usage)");
  });
});
