import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execute } from "@paperclipai/adapter-pi-local/server";

async function writeFakePiCommand(commandPath: string): Promise<void> {
  const script = `#!/usr/bin/env node
if (process.argv.includes("--list-models")) {
  console.log("provider  model");
  console.log("google    gemini-3-flash-preview");
  process.exit(0);
}
console.log(JSON.stringify({ type: "agent_start" }));
console.log(JSON.stringify({ type: "turn_start" }));
console.log(JSON.stringify({ type: "turn_end", message: { role: "assistant", content: "" }, toolResults: [] }));
console.log(JSON.stringify({ type: "agent_end", messages: [] }));
console.log(JSON.stringify({
  type: "auto_retry_end",
  success: false,
  attempt: 3,
  finalError: "Cloud Code Assist API error (429): RESOURCE_EXHAUSTED"
}));
process.exit(0);
`;
  await fs.writeFile(commandPath, script, "utf8");
  await fs.chmod(commandPath, 0o755);
}

async function writeSucceedingPiCommand(commandPath: string): Promise<void> {
  const script = `#!/usr/bin/env node
if (process.argv.includes("--list-models")) {
  console.log("provider  model");
  console.log("google    gemini-3-flash-preview");
  process.exit(0);
}
console.log(JSON.stringify({ type: "agent_start" }));
console.log(JSON.stringify({ type: "turn_start" }));
console.log(JSON.stringify({ type: "turn_end", message: { role: "assistant", content: "" }, toolResults: [] }));
console.log(JSON.stringify({ type: "agent_end", messages: [] }));
process.exit(0);
`;
  await fs.writeFile(commandPath, script, "utf8");
  await fs.chmod(commandPath, 0o755);
}

async function writeEnvDumpPiCommand(commandPath: string, envDumpPath: string): Promise<void> {
  const script = `#!/usr/bin/env node
const fs = require("node:fs");
if (process.argv.includes("--list-models")) {
  console.log("provider  model");
  console.log("google    gemini-3-flash-preview");
  process.exit(0);
}
fs.writeFileSync(${JSON.stringify(envDumpPath)}, process.env.PATH || "");
console.log(JSON.stringify({ type: "agent_start" }));
console.log(JSON.stringify({ type: "turn_start" }));
console.log(JSON.stringify({ type: "turn_end", message: { role: "assistant", content: "" }, toolResults: [] }));
console.log(JSON.stringify({ type: "agent_end", messages: [] }));
process.exit(0);
`;
  await fs.writeFile(commandPath, script, "utf8");
  await fs.chmod(commandPath, 0o755);
}

describe("pi_local execute", () => {
  it("fails the run when Pi exhausts automatic retries despite exiting 0", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-pi-execute-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "pi");
    await fs.mkdir(workspace, { recursive: true });
    await writeFakePiCommand(commandPath);

    const previousHome = process.env.HOME;
    process.env.HOME = root;

    try {
      const result = await execute({
        runId: "run-pi-quota-exhausted",
        agent: {
          id: "agent-1",
          companyId: "company-1",
          name: "Pi Agent",
          adapterType: "pi_local",
          adapterConfig: {},
        },
        runtime: {
          sessionId: null,
          sessionParams: null,
          sessionDisplayId: null,
          taskKey: null,
        },
        config: {
          command: commandPath,
          cwd: workspace,
          model: "google/gemini-3-flash-preview",
          promptTemplate: "Keep working.",
        },
        context: {},
        authToken: "run-jwt-token",
        onLog: async () => {},
      });

      expect(result.exitCode).toBe(1);
      expect(result.errorMessage).toContain("RESOURCE_EXHAUSTED");
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("prepends installed skill bin/ dirs to the spawned Pi child PATH", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-pi-path-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "pi");
    const skillDir = path.join(root, "skills", "demo-skill");
    const skillBinDir = path.join(skillDir, "bin");
    const envDumpPath = path.join(root, "captured-path.txt");
    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(skillBinDir, { recursive: true });
    await fs.writeFile(path.join(skillDir, "SKILL.md"), "# demo-skill\n", "utf8");
    await writeEnvDumpPiCommand(commandPath, envDumpPath);

    const previousHome = process.env.HOME;
    process.env.HOME = root;

    try {
      await execute({
        runId: "run-pi-skill-path",
        agent: {
          id: "agent-skill-path",
          companyId: "company-skill-path",
          name: "Pi Agent",
          adapterType: "pi_local",
          adapterConfig: {},
        },
        runtime: {
          sessionId: null,
          sessionParams: null,
          sessionDisplayId: null,
          taskKey: null,
        },
        config: {
          command: commandPath,
          cwd: workspace,
          model: "google/gemini-3-flash-preview",
          promptTemplate: "Keep working.",
          paperclipRuntimeSkills: [
            { key: "demo-skill", runtimeName: "demo-skill", source: skillDir },
          ],
          paperclipSkillSync: {
            desiredSkills: ["demo-skill"],
          },
        },
        context: {},
        authToken: "run-jwt-token",
        onLog: async () => {},
      });

      const capturedPath = await fs.readFile(envDumpPath, "utf8");
      const entries = capturedPath.split(path.delimiter);
      expect(entries[0]).toBe(skillBinDir);
      expect(entries.filter((entry) => entry === skillBinDir)).toHaveLength(1);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("DUR-33: prepends the company's COMPANY.md ahead of the agent's own instructions", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-pi-execute-company-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "pi");
    const instructionsPath = path.join(root, "AGENTS.md");
    await fs.mkdir(workspace, { recursive: true });
    await fs.writeFile(instructionsPath, "# Agent instructions", "utf8");
    await writeSucceedingPiCommand(commandPath);

    const previousHome = process.env.HOME;
    const previousPaperclipHome = process.env.PAPERCLIP_HOME;
    const previousPaperclipInstanceId = process.env.PAPERCLIP_INSTANCE_ID;
    process.env.HOME = root;
    const companyId = "co-with-standing-rules";
    const companyInstructionsDir = path.join(root, "paperclip-home", "instances", "default", "companies", companyId, "instructions");
    await fs.mkdir(companyInstructionsDir, { recursive: true });
    await fs.writeFile(path.join(companyInstructionsDir, "COMPANY.md"), "1. Never guess.", "utf8");
    process.env.PAPERCLIP_HOME = path.join(root, "paperclip-home");
    process.env.PAPERCLIP_INSTANCE_ID = "default";

    let capturedArgs: string[] = [];
    try {
      const result = await execute({
        runId: "run-company-instructions",
        agent: {
          id: "agent-1",
          companyId,
          name: "Pi Agent",
          adapterType: "pi_local",
          adapterConfig: {},
        },
        runtime: {
          sessionId: null,
          sessionParams: null,
          sessionDisplayId: null,
          taskKey: null,
        },
        config: {
          command: commandPath,
          cwd: workspace,
          model: "google/gemini-3-flash-preview",
          instructionsFilePath: instructionsPath,
          promptTemplate: "Keep working.",
        },
        context: {},
        authToken: "run-jwt-token",
        onLog: async () => {},
        onMeta: async (meta) => {
          capturedArgs = meta.commandArgs ?? [];
        },
      });

      expect(result.exitCode).toBe(0);
      const flagIndex = capturedArgs.indexOf("--append-system-prompt");
      expect(flagIndex).toBeGreaterThanOrEqual(0);
      const systemPrompt = capturedArgs[flagIndex + 1] ?? "";
      expect(systemPrompt).toBeTruthy();
      expect(systemPrompt.indexOf("1. Never guess.")).toBeLessThan(
        systemPrompt.indexOf("# Agent instructions"),
      );
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousPaperclipHome === undefined) delete process.env.PAPERCLIP_HOME;
      else process.env.PAPERCLIP_HOME = previousPaperclipHome;
      if (previousPaperclipInstanceId === undefined) delete process.env.PAPERCLIP_INSTANCE_ID;
      else process.env.PAPERCLIP_INSTANCE_ID = previousPaperclipInstanceId;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("DUR-33: a company without COMPANY.md behaves exactly as today (no header, no error)", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-pi-execute-no-company-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "pi");
    const instructionsPath = path.join(root, "AGENTS.md");
    await fs.mkdir(workspace, { recursive: true });
    await fs.writeFile(instructionsPath, "# Agent instructions", "utf8");
    await writeSucceedingPiCommand(commandPath);

    const previousHome = process.env.HOME;
    const previousPaperclipHome = process.env.PAPERCLIP_HOME;
    const previousPaperclipInstanceId = process.env.PAPERCLIP_INSTANCE_ID;
    process.env.HOME = root;
    process.env.PAPERCLIP_HOME = path.join(root, "paperclip-home-empty");
    process.env.PAPERCLIP_INSTANCE_ID = "default";

    let capturedArgs: string[] = [];
    try {
      const result = await execute({
        runId: "run-no-company-instructions",
        agent: {
          id: "agent-1",
          companyId: "co-without-file",
          name: "Pi Agent",
          adapterType: "pi_local",
          adapterConfig: {},
        },
        runtime: {
          sessionId: null,
          sessionParams: null,
          sessionDisplayId: null,
          taskKey: null,
        },
        config: {
          command: commandPath,
          cwd: workspace,
          model: "google/gemini-3-flash-preview",
          instructionsFilePath: instructionsPath,
          promptTemplate: "Keep working.",
        },
        context: {},
        authToken: "run-jwt-token",
        onLog: async () => {},
        onMeta: async (meta) => {
          capturedArgs = meta.commandArgs ?? [];
        },
      });

      expect(result.exitCode).toBe(0);
      const flagIndex = capturedArgs.indexOf("--append-system-prompt");
      expect(flagIndex).toBeGreaterThanOrEqual(0);
      const systemPrompt = capturedArgs[flagIndex + 1] ?? "";
      expect(systemPrompt.startsWith("# Agent instructions")).toBe(true);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      if (previousPaperclipHome === undefined) delete process.env.PAPERCLIP_HOME;
      else process.env.PAPERCLIP_HOME = previousPaperclipHome;
      if (previousPaperclipInstanceId === undefined) delete process.env.PAPERCLIP_INSTANCE_ID;
      else process.env.PAPERCLIP_INSTANCE_ID = previousPaperclipInstanceId;
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("does not expose bin/ dirs from skills that are not injected", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-pi-path-neg-"));
    const workspace = path.join(root, "workspace");
    const commandPath = path.join(root, "pi");
    const nonInjectedSkillDir = path.join(root, "skills", "not-injected");
    const nonInjectedBinDir = path.join(nonInjectedSkillDir, "bin");
    const envDumpPath = path.join(root, "captured-path.txt");
    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(nonInjectedBinDir, { recursive: true });
    await fs.writeFile(path.join(nonInjectedSkillDir, "SKILL.md"), "# not-injected\n", "utf8");
    await writeEnvDumpPiCommand(commandPath, envDumpPath);

    const previousHome = process.env.HOME;
    process.env.HOME = root;

    try {
      await execute({
        runId: "run-pi-skill-path-neg",
        agent: {
          id: "agent-skill-path-neg",
          companyId: "company-skill-path-neg",
          name: "Pi Agent",
          adapterType: "pi_local",
          adapterConfig: {},
        },
        runtime: {
          sessionId: null,
          sessionParams: null,
          sessionDisplayId: null,
          taskKey: null,
        },
        config: {
          command: commandPath,
          cwd: workspace,
          model: "google/gemini-3-flash-preview",
          promptTemplate: "Keep working.",
          // No explicit paperclipSkillSync preference →
          // resolvePaperclipDesiredSkillNames returns [] → skill is not injected.
          paperclipRuntimeSkills: [
            { key: "not-injected", runtimeName: "not-injected", source: nonInjectedSkillDir },
          ],
        },
        context: {},
        authToken: "run-jwt-token",
        onLog: async () => {},
      });

      const capturedPath = await fs.readFile(envDumpPath, "utf8");
      expect(capturedPath.split(path.delimiter)).not.toContain(nonInjectedBinDir);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
