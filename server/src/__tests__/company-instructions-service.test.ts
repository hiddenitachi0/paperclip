import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { companyInstructionsService } from "../services/company-instructions.js";

describe("companyInstructionsService (DUR-33)", () => {
  let previousHome: string | undefined;
  let previousInstanceId: string | undefined;
  let homeDir: string;

  beforeEach(async () => {
    homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-company-instructions-service-"));
    previousHome = process.env.PAPERCLIP_HOME;
    previousInstanceId = process.env.PAPERCLIP_INSTANCE_ID;
    process.env.PAPERCLIP_HOME = homeDir;
    process.env.PAPERCLIP_INSTANCE_ID = "default";
  });

  afterEach(async () => {
    process.env.PAPERCLIP_HOME = previousHome;
    process.env.PAPERCLIP_INSTANCE_ID = previousInstanceId;
    await fs.rm(homeDir, { recursive: true, force: true });
  });

  it("returns exists:false with empty content for a company with no COMPANY.md", async () => {
    const svc = companyInstructionsService();
    const file = await svc.getFile("company-without-file");
    expect(file).toEqual({ path: "COMPANY.md", content: "", exists: false, size: 0 });
  });

  it("writes then reads back COMPANY.md, creating the instructions directory", async () => {
    const svc = companyInstructionsService();
    const written = await svc.writeFile("company-1", "1. Rule one.\n2. Rule two.");
    expect(written.exists).toBe(true);
    expect(written.content).toBe("1. Rule one.\n2. Rule two.");

    const read = await svc.getFile("company-1");
    expect(read).toEqual(written);

    const onDisk = await fs.readFile(
      path.join(homeDir, "instances", "default", "companies", "company-1", "instructions", "COMPANY.md"),
      "utf8",
    );
    expect(onDisk).toBe("1. Rule one.\n2. Rule two.");
  });

  it("overwrites existing content on a second write", async () => {
    const svc = companyInstructionsService();
    await svc.writeFile("company-1", "version one");
    const overwritten = await svc.writeFile("company-1", "version two");
    expect(overwritten.content).toBe("version two");
    const read = await svc.getFile("company-1");
    expect(read.content).toBe("version two");
  });

  it("deletes COMPANY.md, after which getFile reports exists:false again", async () => {
    const svc = companyInstructionsService();
    await svc.writeFile("company-1", "1. Rule one.");
    await svc.deleteFile("company-1");
    const read = await svc.getFile("company-1");
    expect(read.exists).toBe(false);
  });

  it("deleteFile on an already-missing file does not throw", async () => {
    const svc = companyInstructionsService();
    await expect(svc.deleteFile("company-never-had-a-file")).resolves.toBeUndefined();
  });

  it("keeps two companies' COMPANY.md files independent", async () => {
    const svc = companyInstructionsService();
    await svc.writeFile("company-a", "Company A rules");
    await svc.writeFile("company-b", "Company B rules");

    expect((await svc.getFile("company-a")).content).toBe("Company A rules");
    expect((await svc.getFile("company-b")).content).toBe("Company B rules");
  });
});
