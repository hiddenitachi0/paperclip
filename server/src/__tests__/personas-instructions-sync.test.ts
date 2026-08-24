// DUR-133: syncPersonaInstructions renders PERSONA.md and adds exactly one
// reference line to AGENTS.md. This must never duplicate the reference line
// on repeat saves, and must never touch the rest of a hand-edited AGENTS.md.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { syncPersonaInstructions } from "../services/personas.js";

async function makeTempDir(prefix: string) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

const REFERENCE_LINE = "_Persona identity: see [PERSONA.md](./PERSONA.md) for who this agent is._";

describe("syncPersonaInstructions", () => {
  const originalPaperclipHome = process.env.PAPERCLIP_HOME;
  const originalPaperclipInstanceId = process.env.PAPERCLIP_INSTANCE_ID;
  const cleanupDirs = new Set<string>();

  afterEach(async () => {
    if (originalPaperclipHome === undefined) delete process.env.PAPERCLIP_HOME;
    else process.env.PAPERCLIP_HOME = originalPaperclipHome;
    if (originalPaperclipInstanceId === undefined) delete process.env.PAPERCLIP_INSTANCE_ID;
    else process.env.PAPERCLIP_INSTANCE_ID = originalPaperclipInstanceId;

    await Promise.all([...cleanupDirs].map(async (dir) => {
      await fs.rm(dir, { recursive: true, force: true });
      cleanupDirs.delete(dir);
    }));
  });

  function makeEnv() {
    return makeTempDir("paperclip-persona-instructions-home-").then((paperclipHome) => {
      cleanupDirs.add(paperclipHome);
      process.env.PAPERCLIP_HOME = paperclipHome;
      process.env.PAPERCLIP_INSTANCE_ID = "test-instance";
      return paperclipHome;
    });
  }

  const agent = {
    id: "agent-1",
    companyId: "company-1",
    name: "Maja",
    personality: "Loves analog photography and long walks.",
    adapterConfig: {},
  } as any;

  const persona = {
    handle: "@maja.photog",
    status: "draft",
  } as any;

  it("writes PERSONA.md and appends one reference line to a fresh AGENTS.md", async () => {
    await makeEnv();
    await syncPersonaInstructions(agent, persona);

    const managedRoot = path.join(
      process.env.PAPERCLIP_HOME!,
      "instances",
      "test-instance",
      "companies",
      "company-1",
      "agents",
      "agent-1",
      "instructions",
    );

    const personaMd = await fs.readFile(path.join(managedRoot, "PERSONA.md"), "utf8");
    expect(personaMd).toContain("# Maja");
    expect(personaMd).toContain("Handle: @maja.photog");
    expect(personaMd).toContain("Loves analog photography and long walks.");

    const agentsMd = await fs.readFile(path.join(managedRoot, "AGENTS.md"), "utf8");
    expect(agentsMd).toBe(`${REFERENCE_LINE}\n`);
  });

  it("does not duplicate the reference line or touch existing AGENTS.md content on a second save", async () => {
    const paperclipHome = await makeEnv();
    const managedRoot = path.join(
      paperclipHome,
      "instances",
      "test-instance",
      "companies",
      "company-1",
      "agents",
      "agent-1",
      "instructions",
    );
    await fs.mkdir(managedRoot, { recursive: true });
    const handEdited = "# Maja\n\nHand-written operator notes that must survive untouched.\n";
    await fs.writeFile(path.join(managedRoot, "AGENTS.md"), handEdited, "utf8");

    await syncPersonaInstructions(agent, persona);
    const afterFirstSync = await fs.readFile(path.join(managedRoot, "AGENTS.md"), "utf8");
    expect(afterFirstSync).toBe(`${handEdited.replace(/\s+$/, "")}\n\n${REFERENCE_LINE}\n`);

    // Second sync (e.g. bio change) must not add the reference line again.
    await syncPersonaInstructions(agent, { ...persona, handle: "@maja.new" });
    const afterSecondSync = await fs.readFile(path.join(managedRoot, "AGENTS.md"), "utf8");
    expect(afterSecondSync).toBe(afterFirstSync);
    expect(afterSecondSync.match(new RegExp(REFERENCE_LINE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"))).toHaveLength(1);
  });
});
