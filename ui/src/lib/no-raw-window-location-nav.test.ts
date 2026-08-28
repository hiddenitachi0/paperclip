import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// DUR-246: window.location.assign("/tools") skipped the company-prefix
// router (@/lib/router's useNavigate/Link), sending the operator to a
// bare /tools path with no company context — "Company not found" that
// then follows every subsequent click. This test fails the build if a
// new raw absolute-path window.location navigation shows up, so the next
// person hits a red test instead of shipping the same bug again.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = path.resolve(__dirname, "..");

// A literal (or template with no interpolation before the first "/") absolute
// app path, e.g. window.location.assign("/tools") or
// window.location.href = "/dashboard". Template strings that interpolate a
// company prefix in, e.g. `/${company.issuePrefix}/dashboard`, are allowed —
// they already carry a valid company context.
const RAW_ABSOLUTE_NAV = /window\.location\.(?:assign\s*\(\s*|href\s*=\s*)["'`]\/(?!\$)/;

function collectSourceFiles(dir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name.endsWith(".test.ts") || entry.name.endsWith(".test.tsx")) {
      continue;
    }
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectSourceFiles(fullPath));
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      files.push(fullPath);
    }
  }
  return files;
}

describe("no raw window.location navigation to an absolute app path", () => {
  it("only uses the company-aware router (useNavigate/Link) for in-app navigation", () => {
    const offenders: string[] = [];
    for (const file of collectSourceFiles(SRC_DIR)) {
      const content = fs.readFileSync(file, "utf-8");
      if (RAW_ABSOLUTE_NAV.test(content)) {
        offenders.push(path.relative(SRC_DIR, file));
      }
    }

    expect(
      offenders,
      "Found raw window.location navigation to an absolute app path. This bypasses the " +
        "company-prefix router and sends the operator to a route with no company context " +
        "(\"Company not found\", DUR-246). Use useNavigate()/Link from @/lib/router instead.",
    ).toEqual([]);
  });
});
