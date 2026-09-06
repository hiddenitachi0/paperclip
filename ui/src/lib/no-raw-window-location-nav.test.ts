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

// DUR-3933: /skills, /jobs and /tools are board routes — they must always be
// reached through @/lib/router's company-aware Link/Navigate/useNavigate, or
// react-router-dom's own Link/NavLink/Navigate, or a raw <a href>, will send
// the operator to a bare unprefixed path with no company context.
const BARE_BOARD_PATHS = ["skills", "jobs", "tools"];
const RAW_ANCHOR_TO_BOARD_PATH = new RegExp(
  `<a[^>]*\\shref=["']\\/(?:${BARE_BOARD_PATHS.join("|")})(?:["'/?#])`,
);
const RAW_ROUTER_DOM_IMPORT = /from\s+["']react-router-dom["']/;
const RAW_ROUTER_DOM_TO_BOARD_PATH = new RegExp(
  `\\bto=["']\\/(?:${BARE_BOARD_PATHS.join("|")})(?:["'/?#])`,
);

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

  it("only links to /skills, /jobs, /tools through the company-aware router", () => {
    const offenders: string[] = [];
    for (const file of collectSourceFiles(SRC_DIR)) {
      if (path.resolve(file) === path.resolve(__dirname, "router.tsx")) continue;
      const content = fs.readFileSync(file, "utf-8");

      if (RAW_ANCHOR_TO_BOARD_PATH.test(content)) {
        offenders.push(path.relative(SRC_DIR, file));
        continue;
      }

      // A bare `to="/skills"` etc. is only safe when it resolves through
      // @/lib/router's Link/NavLink/Navigate (which auto-prefix it with the
      // active company). If this file also imports navigation primitives
      // straight from react-router-dom, the same-looking `to="/skills"` may
      // instead be going through the un-prefixed react-router-dom component.
      if (RAW_ROUTER_DOM_IMPORT.test(content) && RAW_ROUTER_DOM_TO_BOARD_PATH.test(content)) {
        offenders.push(path.relative(SRC_DIR, file));
      }
    }

    expect(
      offenders,
      "Found a bare link to /skills, /jobs, or /tools that isn't guaranteed to go through " +
        "@/lib/router. This can send the operator to the wrong company's board when the URL " +
        "has no company prefix (DUR-3933). Use Link/NavLink/Navigate/useNavigate from " +
        "@/lib/router instead of react-router-dom or a raw <a href>.",
    ).toEqual([]);
  });
});
