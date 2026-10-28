import { describe, expect, it } from "vitest";
import { SAFE_FOR_WORK_AVOID, evaluateLora } from "@paperclipai/plugin-sdk/media";

// The server and the Media Studio plugin worker share the safety rules through
// this subpath; this fails if the SDK's exports map or build stops providing it.
describe("@paperclipai/plugin-sdk/media from the server", () => {
  it("resolves and applies the always-refused rule", () => {
    expect(SAFE_FOR_WORK_AVOID).toContain("nsfw");
    expect(evaluateLora({ id: "krea2-filter-bypass-2" }, "mature")).toMatchObject({ allowed: false, alwaysRefused: true });
  });
});
