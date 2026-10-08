import { describe, expect, it } from "vitest";
import {
  OPENROUTER_NO_TOOL_HOST_WARNING,
  cleanOpenRouterHostList,
  describeOpenRouterHostsChange,
  diffOpenRouterHosts,
  isOpenRouterModelId,
  openRouterHostChoicesFromRouting,
  openRouterHostSlugFromTag,
  openRouterHostsAllowed,
  openRouterHostsSeen,
  openRouterNoToolHostWarning,
  resolveOpenRouterHostRouting,
} from "./openrouter-hosts.js";
import { modelDirectorySpecsSchema } from "./validators/model-directory.js";

const hosts = [
  { slug: "deepinfra", supportsTools: true },
  { slug: "novita", supportsTools: true },
  { slug: "venice", supportsTools: false },
  { slug: "parasail", supportsTools: false },
];

describe("OpenRouter host helpers", () => {
  it("reads a host slug from an endpoint tag and cleans host lists", () => {
    expect(openRouterHostSlugFromTag("deepinfra/fp8")).toBe("deepinfra");
    expect(openRouterHostSlugFromTag("google-vertex")).toBe("google-vertex");
    expect(openRouterHostSlugFromTag("Not a slug")).toBeNull();
    expect(openRouterHostSlugFromTag(42)).toBeNull();
    expect(cleanOpenRouterHostList([" Venice", "venice", "bad host", 3, "novita"])).toEqual(["venice", "novita"]);
  });

  it("accepts maker/model ids only", () => {
    expect(isOpenRouterModelId("qwen/qwen3.8-27b")).toBe(true);
    expect(isOpenRouterModelId("openai/gpt-oss-20b:free")).toBe(true);
    for (const bad of ["qwen", "a/b/c", "../x", "a/..", "", null]) expect(isOpenRouterModelId(bad)).toBe(false);
  });

  it("maps a saved routing to per-host choices", () => {
    expect(openRouterHostChoicesFromRouting({ only: ["novita"], ignore: ["venice"] })).toEqual({ novita: "use", venice: "never" });
    expect(openRouterHostChoicesFromRouting(null)).toEqual({});
  });
});

describe("resolveOpenRouterHostRouting (precedence)", () => {
  const rules = { preferred: ["novita", "parasail"], blocked: ["venice"] };

  it("no choices and no rules: OpenRouter chooses (null)", () => {
    expect(resolveOpenRouterHostRouting({ choices: {}, hosts })).toBeNull();
  });

  it("all Default: preferred hosts that run the model become the Use list when one has tools; blocked go to Never", () => {
    expect(resolveOpenRouterHostRouting({ choices: {}, rules, hosts })).toEqual({ only: ["novita", "parasail"], ignore: ["venice"] });
  });

  it("preferred hosts are not applied when none of them runs the model with tools", () => {
    const noTools = hosts.map((host) => (host.slug === "novita" ? { ...host, supportsTools: false } : host));
    expect(resolveOpenRouterHostRouting({ choices: {}, rules, hosts: noTools })).toEqual({ ignore: ["venice"] });
    // Preferred hosts that do not run this model are left out.
    expect(
      resolveOpenRouterHostRouting({ choices: {}, rules: { preferred: ["novita", "together"], blocked: [] }, hosts }),
    ).toEqual({ only: ["novita"] });
    // Without the live list the preferred list cannot be checked, so it is not applied.
    expect(resolveOpenRouterHostRouting({ choices: {}, rules })).toEqual({ ignore: ["venice"] });
  });

  it("an explicit Use overrides the preferred list", () => {
    expect(resolveOpenRouterHostRouting({ choices: { deepinfra: "use" }, rules, hosts })).toEqual({
      only: ["deepinfra"],
      ignore: ["venice"],
      allowFallbacks: false,
    });
  });

  it("an explicit Use on a blocked host is an exception; an explicit Never always wins over preferred", () => {
    expect(resolveOpenRouterHostRouting({ choices: { venice: "use" }, rules, hosts })).toEqual({
      only: ["venice"],
      allowFallbacks: false,
    });
    // novita is the only preferred host with tools; marked Never, the rest (parasail, no tools) is not applied.
    expect(resolveOpenRouterHostRouting({ choices: { novita: "never" }, rules, hosts })).toEqual({
      ignore: ["novita", "venice"],
    });
  });

  it("keeps a saved order (minus never-hosts) and fallback choice", () => {
    expect(
      resolveOpenRouterHostRouting({
        choices: { novita: "use" },
        rules: { preferred: [], blocked: ["venice"] },
        hosts,
        base: { only: ["novita"], order: ["venice", "novita"], allowFallbacks: true },
      }),
    ).toEqual({ only: ["novita"], order: ["novita"], ignore: ["venice"], allowFallbacks: true });
  });

  it("blocked hosts that do not run the model today are still listed", () => {
    expect(resolveOpenRouterHostRouting({ choices: {}, rules: { preferred: [], blocked: ["chutes"] }, hosts })).toEqual({
      ignore: ["chutes"],
    });
  });
});

describe("tool-support warning and refresh diff", () => {
  it("warns only when no allowed host supports tools", () => {
    expect(openRouterNoToolHostWarning(null, hosts)).toBeNull();
    expect(openRouterNoToolHostWarning({ only: ["venice"] }, hosts)).toBe(OPENROUTER_NO_TOOL_HOST_WARNING);
    expect(openRouterNoToolHostWarning({ ignore: ["deepinfra", "novita"] }, hosts)).toBe(OPENROUTER_NO_TOOL_HOST_WARNING);
    expect(openRouterNoToolHostWarning({ only: ["venice"] }, [])).toBeNull();
    expect(openRouterHostsAllowed({ only: ["venice", "novita"], ignore: ["novita"] }, hosts).map((h) => h.slug)).toEqual(["venice"]);
  });

  it("remembers hosts (tools if any endpoint of a host has it) and says what changed", () => {
    const seen = openRouterHostsSeen([...hosts, { slug: "venice", supportsTools: true }]);
    expect(seen).toEqual([
      { slug: "deepinfra", tools: true },
      { slug: "novita", tools: true },
      { slug: "venice", tools: true },
      { slug: "parasail", tools: false },
    ]);
    const change = diffOpenRouterHosts(
      [
        { slug: "deepinfra", tools: true },
        { slug: "venice", tools: false },
        { slug: "chutes", tools: true },
        { slug: "parasail", tools: true },
      ],
      seen,
    );
    expect(change).toEqual({ added: ["novita"], removed: ["chutes"], toolsGained: ["venice"], toolsLost: ["parasail"] });
    expect(describeOpenRouterHostsChange(change)).toBe(
      "New host: novita. Gone: chutes. Now supports tool calling: venice. No longer supports tool calling: parasail.",
    );
    expect(describeOpenRouterHostsChange(diffOpenRouterHosts(seen, seen))).toBe("Nothing changed.");
  });

  it("specs keep the last host check, strict and bounded", () => {
    const good = { openrouterHostsSeen: [{ slug: "venice", tools: false }], openrouterHostsCheckedAt: "2026-10-08T12:00:00.000Z" };
    expect(modelDirectorySpecsSchema.parse(good)).toEqual(good);
    expect(modelDirectorySpecsSchema.safeParse({ openrouterHostsSeen: [{ slug: "venice", tools: false, extra: 1 }] }).success).toBe(false);
    expect(modelDirectorySpecsSchema.safeParse({ openrouterHostsSeen: [{ slug: "Bad Host", tools: false }] }).success).toBe(false);
    expect(
      modelDirectorySpecsSchema.safeParse({ openrouterHostsSeen: Array.from({ length: 101 }, (_, i) => ({ slug: `h${i}`, tools: true })) }).success,
    ).toBe(false);
    expect(modelDirectorySpecsSchema.safeParse({ openrouterHostsCheckedAt: "yesterday" }).success).toBe(false);
  });
});
