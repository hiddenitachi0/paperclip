import fs from "node:fs/promises";
import path from "node:path";
import { resolveCompanyInstructionsPath } from "@paperclipai/adapter-utils/server-utils";

export type CompanyInstructionsFile = {
  path: string;
  content: string;
  exists: boolean;
  size: number;
};

const ENTRY_FILE_PATH = "COMPANY.md";

export function companyInstructionsService() {
  async function getFile(companyId: string): Promise<CompanyInstructionsFile> {
    const filePath = resolveCompanyInstructionsPath({ companyId });
    const content = await fs.readFile(filePath, "utf8").catch(() => null);
    if (content === null) {
      return { path: ENTRY_FILE_PATH, content: "", exists: false, size: 0 };
    }
    return { path: ENTRY_FILE_PATH, content, exists: true, size: Buffer.byteLength(content, "utf8") };
  }

  async function writeFile(companyId: string, content: string): Promise<CompanyInstructionsFile> {
    const filePath = resolveCompanyInstructionsPath({ companyId });
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content, "utf8");
    return { path: ENTRY_FILE_PATH, content, exists: true, size: Buffer.byteLength(content, "utf8") };
  }

  async function deleteFile(companyId: string): Promise<void> {
    const filePath = resolveCompanyInstructionsPath({ companyId });
    await fs.rm(filePath, { force: true });
  }

  return { getFile, writeFile, deleteFile };
}
