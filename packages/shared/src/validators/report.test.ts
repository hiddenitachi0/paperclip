import { describe, expect, it } from "vitest";
import {
  createReportFixtureSchema,
  createReportScriptSchema,
  createReportScriptVersionSchema,
  REPORT_SCRIPT_MAX_FILES,
} from "./report.js";

describe("createReportScriptSchema", () => {
  it("accepts a lowercase slug key", () => {
    const parsed = createReportScriptSchema.parse({ key: "quarterly-kpis", name: "Quarterly KPIs" });
    expect(parsed).toEqual({ key: "quarterly-kpis", name: "Quarterly KPIs" });
  });

  it("rejects an uppercase or spaced key", () => {
    expect(() => createReportScriptSchema.parse({ key: "Quarterly KPIs", name: "x" })).toThrow();
  });
});

describe("createReportScriptVersionSchema", () => {
  it("accepts files with a matching entrypoint and defaults", () => {
    const parsed = createReportScriptVersionSchema.parse({
      files: { "main.py": "print('hi')" },
    });
    expect(parsed.entrypoint).toBe("main.py");
    expect(parsed.inputSchema).toEqual({});
    expect(parsed.outputSchema).toEqual({});
  });

  it("rejects an entrypoint that is not among the files", () => {
    expect(() =>
      createReportScriptVersionSchema.parse({
        files: { "helper.py": "x = 1" },
        entrypoint: "main.py",
      }),
    ).toThrow();
  });

  it("rejects a path that escapes the runtime directory", () => {
    expect(() =>
      createReportScriptVersionSchema.parse({
        files: { "../evil.py": "x = 1" },
      }),
    ).toThrow();
  });

  it("rejects an absolute path", () => {
    expect(() =>
      createReportScriptVersionSchema.parse({
        files: { "/etc/passwd": "x = 1" },
      }),
    ).toThrow();
  });

  it("rejects more files than the cap", () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < REPORT_SCRIPT_MAX_FILES + 1; i += 1) files[`f${i}.py`] = "x = 1";
    files["main.py"] = "x = 1";
    expect(() => createReportScriptVersionSchema.parse({ files })).toThrow();
  });

  it("rejects an empty files map", () => {
    expect(() => createReportScriptVersionSchema.parse({ files: {} })).toThrow();
  });
});

describe("createReportFixtureSchema", () => {
  it("defaults tolerance to 0 (exact match)", () => {
    const parsed = createReportFixtureSchema.parse({
      name: "q1-2026",
      input: { period: "2026-Q1" },
      expectedOutput: { total: 100 },
    });
    expect(parsed.tolerance).toBe(0);
  });

  it("rejects a negative tolerance", () => {
    expect(() =>
      createReportFixtureSchema.parse({
        name: "q1-2026",
        input: {},
        expectedOutput: {},
        tolerance: -1,
      }),
    ).toThrow();
  });
});
