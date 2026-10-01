import { describe, expect, it } from "vitest";
import { createJobSchema, createJobTriggerSchema, jobVariableSchema, runJobSchema } from "./jobs.js";

describe("jobVariableSchema", () => {
  it("defaults an omitted label/defaultValue to null rather than undefined", () => {
    const parsed = jobVariableSchema.parse({ name: "counterparty" });
    expect(parsed.label).toBeNull();
    expect(parsed.defaultValue).toBeNull();
    expect(parsed.type).toBe("text");
    expect(parsed.required).toBe(true);
  });

  it("requires at least one option for a select variable", () => {
    const result = jobVariableSchema.safeParse({ name: "tone", type: "select", options: [] });
    expect(result.success).toBe(false);
  });

  it("rejects options on a non-select variable", () => {
    const result = jobVariableSchema.safeParse({ name: "tone", type: "text", options: ["a"] });
    expect(result.success).toBe(false);
  });

  it("rejects a select default that isn't one of the declared options", () => {
    const result = jobVariableSchema.safeParse({
      name: "tone",
      type: "select",
      options: ["formal", "casual"],
      defaultValue: "sarcastic",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a default value on a file_upload variable", () => {
    const result = jobVariableSchema.safeParse({
      name: "attachment",
      type: "file_upload",
      defaultValue: "not-allowed",
    });
    expect(result.success).toBe(false);
  });

  it("rejects a non-calendar-date default on a date variable", () => {
    const result = jobVariableSchema.safeParse({ name: "due", type: "date", defaultValue: "not-a-date" });
    expect(result.success).toBe(false);
  });
});

describe("createJobSchema", () => {
  it("fills in run mode, status, and position defaults", () => {
    const parsed = createJobSchema.parse({ title: "Revise contract" });
    expect(parsed.runMode).toBe("full_agent");
    expect(parsed.status).toBe("active");
    expect(parsed.requiresApproval).toBe(false);
    expect(parsed.positionIds).toEqual([]);
  });

  it("rejects a blank title", () => {
    expect(createJobSchema.safeParse({ title: "" }).success).toBe(false);
  });
});

describe("createJobTriggerSchema", () => {
  it("requires a cron expression for a schedule trigger but not for a webhook trigger", () => {
    expect(createJobTriggerSchema.safeParse({ kind: "schedule" }).success).toBe(false);
    expect(createJobTriggerSchema.safeParse({ kind: "schedule", cronExpression: "0 9 * * *" }).success).toBe(true);
    expect(createJobTriggerSchema.safeParse({ kind: "webhook" }).success).toBe(true);
  });

  it("requires an email match address for an email trigger", () => {
    expect(createJobTriggerSchema.safeParse({ kind: "email" }).success).toBe(false);
    expect(
      createJobTriggerSchema.safeParse({ kind: "email", emailMatchAddress: "legal@acme.test" }).success,
    ).toBe(true);
  });
});

describe("runJobSchema", () => {
  it("defaults source to manual and requires a runAgentId", () => {
    expect(runJobSchema.safeParse({}).success).toBe(false);
    const parsed = runJobSchema.parse({ runAgentId: "00000000-0000-0000-0000-000000000000" });
    expect(parsed.source).toBe("manual");
  });

  it("accepts the telegram source (quick-agent-on-behalf-of-colleague path)", () => {
    const parsed = runJobSchema.parse({
      runAgentId: "00000000-0000-0000-0000-000000000000",
      source: "telegram",
    });
    expect(parsed.source).toBe("telegram");
  });
});
