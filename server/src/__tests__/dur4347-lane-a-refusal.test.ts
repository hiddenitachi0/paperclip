import { describe, expect, it } from "vitest";
import { detectTextRefusal, detectTextRefusalByPattern } from "../services/lane-a-refusal.js";

describe("detectTextRefusalByPattern", () => {
  it("catches common refusal openers", () => {
    expect(detectTextRefusalByPattern("I'm sorry, but I can't help with that request.")).toEqual({
      isRefusal: true,
      rule: "pattern:sorry_cant",
    });
    expect(detectTextRefusalByPattern("I cannot assist with that.")).toEqual({
      isRefusal: true,
      rule: "pattern:cannot_assist",
    });
    expect(detectTextRefusalByPattern("I'm not able to provide that information.")).toEqual({
      isRefusal: true,
      rule: "pattern:not_able",
    });
    expect(detectTextRefusalByPattern("As an AI, I cannot generate that content.")).toEqual({
      isRefusal: true,
      rule: "pattern:as_an_ai",
    });
  });

  it("does not flag an ordinary answer", () => {
    expect(detectTextRefusalByPattern("The weather in Oslo today is 8°C and cloudy.")).toEqual({
      isRefusal: false,
      rule: null,
    });
  });

  it("does not flag a reply that mentions 'can't' mid-sentence, not as its opener", () => {
    expect(
      detectTextRefusalByPattern("Many people say they can't live without coffee, but here's a recipe anyway."),
    ).toEqual({ isRefusal: false, rule: null });
  });

  it("only looks at the opening of the reply", () => {
    const longPreamble = "x".repeat(400);
    expect(detectTextRefusalByPattern(`${longPreamble} I'm sorry, but I can't help with that.`)).toEqual({
      isRefusal: false,
      rule: null,
    });
  });
});

describe("detectTextRefusal", () => {
  it("returns the pattern result without ever calling the classifier when a pattern already matched", async () => {
    let classifyCalled = false;
    const result = await detectTextRefusal("I cannot assist with that.", {
      useClassifier: true,
      classify: async () => {
        classifyCalled = true;
        return false;
      },
    });
    expect(result).toEqual({ isRefusal: true, rule: "pattern:cannot_assist" });
    expect(classifyCalled).toBe(false);
  });

  it("skips the classifier pass entirely when useClassifier is false", async () => {
    let classifyCalled = false;
    const result = await detectTextRefusal("Sure, here is a poem about the sea.", {
      useClassifier: false,
      classify: async () => {
        classifyCalled = true;
        return true;
      },
    });
    expect(result).toEqual({ isRefusal: false, rule: null });
    expect(classifyCalled).toBe(false);
  });

  it("falls through to the classifier when the pattern pass finds nothing and useClassifier is on", async () => {
    const result = await detectTextRefusal("Unfortunately that is something I will not do.", {
      useClassifier: true,
      classify: async (text) => text.includes("will not do"),
    });
    expect(result).toEqual({ isRefusal: true, rule: "classifier" });
  });

  it("treats a classifier failure as 'not a refusal' rather than letting it propagate", async () => {
    const result = await detectTextRefusal("Something ambiguous.", {
      useClassifier: true,
      classify: async () => {
        throw new Error("classifier timed out");
      },
    });
    expect(result).toEqual({ isRefusal: false, rule: null });
  });

  it("treats useClassifier: true with no classify function as classifier-unavailable, not an error", async () => {
    const result = await detectTextRefusal("Something ambiguous.", { useClassifier: true });
    expect(result).toEqual({ isRefusal: false, rule: null });
  });
});
