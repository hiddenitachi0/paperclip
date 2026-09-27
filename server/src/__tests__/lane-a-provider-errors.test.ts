import { describe, expect, it } from "vitest";
import { laneAProviderErrorToHttp } from "../services/lane-a.js";
import { LaneAProviderError } from "../services/lane-a-providers.js";
import { HttpError } from "../errors.js";

/**
 * 27 Sep: a quick agent set to model "DeepSeek-V3" on Hugging Face (the real
 * id is "deepseek-ai/DeepSeek-V3") was refused with 400 model_not_found. The
 * answer was a generic 502, which the Telegram bridge treats as "quick answers
 * unavailable" and turned the message into a full Claude task.
 */
describe("laneAProviderErrorToHttp", () => {
  it("answers a refused request (wrong model name) as a setup problem with the service's own words", () => {
    const err = new LaneAProviderError({
      kind: "upstream",
      provider: "local",
      status: 400,
      message:
        'Local model answered 400: {"error":{"message":"The requested model \'DeepSeek-V3\' does not exist.","type":"invalid_request_error","param":"model","code":"model_not_found"}}',
    });

    const mapped = laneAProviderErrorToHttp(err, "chat") as HttpError;

    expect(mapped).toBeInstanceOf(HttpError);
    expect(mapped.status).toBe(422);
    expect((mapped.details as { code?: string }).code).toBe("LANE_A_SETUP_REFUSED");
    expect(mapped.message).toContain("The requested model 'DeepSeek-V3' does not exist.");
    expect(mapped.message).toContain("Check the model name and the address");
    expect(mapped.message).not.toContain("invalid_request_error");
  });

  it("keeps a 404 from a wrong address a setup problem too", () => {
    const err = new LaneAProviderError({ kind: "upstream", provider: "local", status: 404, message: "Local model answered 404: Not Found" });
    const mapped = laneAProviderErrorToHttp(err, "chat") as HttpError;
    expect(mapped.status).toBe(422);
    expect(mapped.message).toContain("Local model answered 404: Not Found.");
  });

  it("leaves outages as 502, so they can still be handed over as a task", () => {
    const err = new LaneAProviderError({ kind: "upstream", provider: "local", status: 503, message: "Local model answered 503: overloaded" });
    const mapped = laneAProviderErrorToHttp(err, "chat") as HttpError;
    expect(mapped.status).toBe(502);
  });

  it("keeps a refused key a 503 with its own code, and rate limits a 429", () => {
    const auth = laneAProviderErrorToHttp(new LaneAProviderError({ kind: "auth", provider: "local", status: 401, message: "Local model refused the key." }), "chat") as HttpError;
    expect(auth.status).toBe(503);
    expect((auth.details as { code?: string }).code).toBe("LANE_A_KEY_REFUSED");
    const limited = laneAProviderErrorToHttp(new LaneAProviderError({ kind: "rate_limit", provider: "local", status: 429, message: "Local model is rate limited." }), "chat") as HttpError;
    expect(limited.status).toBe(429);
  });
});
