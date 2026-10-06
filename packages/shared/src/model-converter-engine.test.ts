import { describe, expect, it } from "vitest";
import {
  applyOutputConverters,
  applyRequestConverters,
  type ConverterCallRequest,
  modelConverterOpListSchema,
  modelConverterOpsIssue,
  parseModelConverterOps,
  resolveConverterRetry,
} from "./model-converter-engine.js";

function baseRequest(): ConverterCallRequest {
  return {
    params: { reasoning_effort: "none", temperature: 0.7 },
    tools: [
      { name: "clock", description: "Tells the current time, with timezone handling and DST notes.", shortDescription: "Clock", plainDescription: "Tells the time." },
      { name: "generate_image", description: "Generates an image from a prompt." },
    ],
    systemPrompt: "You are a helpful assistant.",
    textToolCallParsingEnabled: false,
  };
}

describe("model converter engine: allow-list", () => {
  it("refuses an operation not on the allow-list", () => {
    const result = modelConverterOpListSchema.safeParse([{ op: "delete_company", companyId: "x" }]);
    expect(result.success).toBe(false);
    expect(() => parseModelConverterOps([{ op: "delete_company" }])).toThrow();
  });

  it("gives a plain-English reason for an unknown op", () => {
    expect(modelConverterOpsIssue([{ op: "run_shell", cmd: "rm -rf /" }])).toMatch(/isn't a converter operation/);
  });

  it("refuses a malformed shape of a known op", () => {
    expect(modelConverterOpsIssue([{ op: "drop_param" }])).toBeTruthy();
    expect(modelConverterOpsIssue([{ op: "drop_param", param: "x", extra: true }])).toBeTruthy();
  });

  it("accepts an empty list", () => {
    expect(parseModelConverterOps([])).toEqual([]);
  });
});

describe("model converter engine: drop_param", () => {
  it("removes the named param", () => {
    const ops = parseModelConverterOps([{ op: "drop_param", param: "reasoning_effort" }]);
    const { request } = applyRequestConverters(baseRequest(), ops);
    expect(request.params).not.toHaveProperty("reasoning_effort");
    expect(request.params.temperature).toBe(0.7);
  });

  it("is a no-op when the param is absent", () => {
    const ops = parseModelConverterOps([{ op: "drop_param", param: "max_tokens" }]);
    const { request } = applyRequestConverters(baseRequest(), ops);
    expect(request.params).toEqual(baseRequest().params);
  });
});

describe("model converter engine: rename_param", () => {
  it("moves the value to the new key", () => {
    const ops = parseModelConverterOps([{ op: "rename_param", from: "reasoning_effort", to: "reasoning" }]);
    const { request } = applyRequestConverters(baseRequest(), ops);
    expect(request.params).not.toHaveProperty("reasoning_effort");
    expect(request.params.reasoning).toBe("none");
  });
});

describe("model converter engine: set_default_param", () => {
  it("sets the param only when not already present", () => {
    const ops = parseModelConverterOps([
      { op: "set_default_param", param: "temperature", value: 0.1 },
      { op: "set_default_param", param: "max_tokens", value: 512 },
    ]);
    const { request } = applyRequestConverters(baseRequest(), ops);
    expect(request.params.temperature).toBe(0.7); // caller's value wins
    expect(request.params.max_tokens).toBe(512); // default fills the gap
  });
});

describe("model converter engine: cap_tool_count", () => {
  it("truncates tools to the cap", () => {
    const ops = parseModelConverterOps([{ op: "cap_tool_count", max: 1 }]);
    const { request } = applyRequestConverters(baseRequest(), ops);
    expect(request.tools).toHaveLength(1);
    expect(request.tools[0]!.name).toBe("clock");
  });

  it("leaves tools alone when already under the cap", () => {
    const ops = parseModelConverterOps([{ op: "cap_tool_count", max: 10 }]);
    const { request } = applyRequestConverters(baseRequest(), ops);
    expect(request.tools).toHaveLength(2);
  });
});

describe("model converter engine: tool_description_variant", () => {
  it("swaps in the short variant where available", () => {
    const ops = parseModelConverterOps([{ op: "tool_description_variant", variant: "short" }]);
    const { request } = applyRequestConverters(baseRequest(), ops);
    expect(request.tools[0]!.description).toBe("Clock");
    // generate_image has no shortDescription, so it keeps its original description.
    expect(request.tools[1]!.description).toBe("Generates an image from a prompt.");
  });

  it("swaps in the plain variant where available", () => {
    const ops = parseModelConverterOps([{ op: "tool_description_variant", variant: "plain" }]);
    const { request } = applyRequestConverters(baseRequest(), ops);
    expect(request.tools[0]!.description).toBe("Tells the time.");
  });
});

describe("model converter engine: system_prompt_hint", () => {
  it("appends the hint to the system prompt", () => {
    const ops = parseModelConverterOps([{ op: "system_prompt_hint", hint: "Prefer generate_image over describing a picture." }]);
    const { request } = applyRequestConverters(baseRequest(), ops);
    expect(request.systemPrompt).toBe("You are a helpful assistant.\n\nPrefer generate_image over describing a picture.");
  });

  it("works with an empty starting prompt", () => {
    const ops = parseModelConverterOps([{ op: "system_prompt_hint", hint: "Be concise." }]);
    const { request } = applyRequestConverters({ ...baseRequest(), systemPrompt: "" }, ops);
    expect(request.systemPrompt).toBe("Be concise.");
  });
});

describe("model converter engine: parse_text_tool_call", () => {
  it("flips the flag on", () => {
    const ops = parseModelConverterOps([{ op: "parse_text_tool_call" }]);
    const { request } = applyRequestConverters(baseRequest(), ops);
    expect(request.textToolCallParsingEnabled).toBe(true);
  });
});

describe("model converter engine: strip_output_wrapper", () => {
  it("strips a <think> block from model output", () => {
    const ops = parseModelConverterOps([{ op: "strip_output_wrapper", wrapper: "think" }]);
    const text = "<think>planning the tool call...</think>Here is your answer.";
    expect(applyOutputConverters(text, ops)).toBe("Here is your answer.");
  });

  it("leaves text without a wrapper untouched", () => {
    const ops = parseModelConverterOps([{ op: "strip_output_wrapper", wrapper: "think" }]);
    expect(applyOutputConverters("Plain answer.", ops)).toBe("Plain answer.");
  });

  it("is not applied as a request-shaping op", () => {
    const ops = parseModelConverterOps([{ op: "strip_output_wrapper", wrapper: "think" }]);
    const { request, appliedOps } = applyRequestConverters(baseRequest(), ops);
    expect(request).toEqual(baseRequest());
    expect(appliedOps).toEqual([]);
  });
});

describe("model converter engine: retry_once", () => {
  it("returns the retry params for a matching error", () => {
    const ops = parseModelConverterOps([
      { op: "retry_once", onError: "no_endpoints_for_parameters", withParams: { reasoning_effort: null } },
    ]);
    expect(resolveConverterRetry(ops, "no_endpoints_for_parameters")).toEqual({ reasoning_effort: null });
  });

  it("returns null for a non-matching error", () => {
    const ops = parseModelConverterOps([
      { op: "retry_once", onError: "no_endpoints_for_parameters", withParams: { reasoning_effort: null } },
    ]);
    expect(resolveConverterRetry(ops, "rate_limited")).toBeNull();
  });

  it("is not applied as a request-shaping op", () => {
    const ops = parseModelConverterOps([{ op: "retry_once", onError: "x", withParams: { a: 1 } }]);
    const { request, appliedOps } = applyRequestConverters(baseRequest(), ops);
    expect(request).toEqual(baseRequest());
    expect(appliedOps).toEqual([]);
  });
});

describe("model converter engine: ordering and composition", () => {
  it("applies several ops in order, matching the qwen3 + reasoning_effort tonight's cases", () => {
    const ops = parseModelConverterOps([
      { op: "drop_param", param: "reasoning_effort" },
      { op: "cap_tool_count", max: 1 },
      { op: "tool_description_variant", variant: "short" },
      { op: "system_prompt_hint", hint: "Think silently; only the final answer should be visible." },
    ]);
    const { request, appliedOps } = applyRequestConverters(baseRequest(), ops);
    expect(request.params).not.toHaveProperty("reasoning_effort");
    expect(request.tools).toHaveLength(1);
    expect(request.tools[0]!.description).toBe("Clock");
    expect(request.systemPrompt).toContain("Think silently");
    expect(appliedOps).toHaveLength(4);
  });
});
