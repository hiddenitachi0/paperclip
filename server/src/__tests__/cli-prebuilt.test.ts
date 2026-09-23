/**
 * DUR-3998: the Docker image runs the Paperclip CLI prebuilt.
 *
 * Every agent command runs `node cli/node_modules/tsx/dist/cli.mjs
 * cli/src/index.ts <command...>` (baked into agent instructions, skills, docs,
 * the deploy runner and the Telegram bridge). Under tsx that compiled the
 * CLI's TypeScript on every call, starting an `esbuild` helper each time. The
 * image now bundles the CLI once (scripts/build-cli-prebuilt.mjs, build stage)
 * and installs scripts/cli-prebuilt-shim.mjs in place of tsx's CLI entry, so
 * the same command line runs the bundle in-process.
 *
 * These tests pin the Dockerfile wiring and the shim's argument handling (in
 * a throw-away layout, no Docker). The acceptance harness
 * (scripts/agent-isolation-acceptance.sh) proves the built image: no esbuild
 * process for the CLI, and `--version` answering with esbuild made unusable.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const SHIM_SOURCE = path.join(REPO_ROOT, "scripts/cli-prebuilt-shim.mjs");
const BUILD_SCRIPT = path.join(REPO_ROOT, "scripts/build-cli-prebuilt.mjs");

describe("the Docker image builds the CLI once and runs it prebuilt", () => {
  const dockerfile = fs.readFileSync(path.join(REPO_ROOT, "Dockerfile"), "utf8");
  const buildStart = dockerfile.indexOf("FROM base AS build");
  const productionStart = dockerfile.indexOf("FROM base AS production");
  const buildStage = dockerfile.slice(buildStart, productionStart);
  const production = dockerfile.slice(productionStart);

  it("bundles the CLI and installs the shim in the build stage, before the writability sweep", () => {
    const buildLine = buildStage.indexOf("RUN node scripts/build-cli-prebuilt.mjs --install-shim");
    const sweep = buildStage.indexOf("RUN find /app \\( -perm -g+w -o -perm -o+w \\)");
    expect(buildLine, "the build stage runs scripts/build-cli-prebuilt.mjs --install-shim").toBeGreaterThan(-1);
    expect(sweep, "the build stage has the go-w sweep").toBeGreaterThan(-1);
    expect(sweep, "the sweep runs after the CLI build, so the new files are covered").toBeGreaterThan(buildLine);
    expect(buildStage).toMatch(/&& test -f cli\/dist\/index\.js/);
    expect(buildStage).toMatch(/&& test -f cli\/node_modules\/tsx\/dist\/tsx-cli\.mjs/);
    expect(buildStage).toMatch(/&& grep -q 'DUR-3998' cli\/node_modules\/tsx\/dist\/cli\.mjs/);
  });

  it("copies /app, shim and bundle included, into the production image owned by root (no --chown)", () => {
    expect(production).toMatch(/^COPY --from=build \/app \/app$/m);
  });

  it("leaves the server's own start alone: tsx loader, module guard, compile cache off", () => {
    const cmd = production.split("\n").find((line) => line.startsWith("CMD "));
    const argv = JSON.parse(cmd!.slice(4)) as string[];
    expect(argv).toContain("./server/node_modules/tsx/dist/loader.mjs");
    expect(argv).toContain("/usr/local/lib/paperclip/node-module-guard.cjs");
    expect(argv[argv.length - 1]).toBe("server/dist/index.js");
    expect(production).toMatch(/^\s+TSX_DISABLE_CACHE=1$/m);
  });

  it("the build script reuses the npm build's esbuild configuration and only installs the shim on request", () => {
    const script = fs.readFileSync(BUILD_SCRIPT, "utf8");
    expect(script).toMatch(/from "\.\.\/cli\/esbuild\.config\.mjs"/);
    expect(script).toMatch(/process\.argv\.includes\("--install-shim"\)/);
    expect(script).toMatch(/sourcemap: false/);
    // The shim carries the marker the Dockerfile greps for.
    expect(fs.readFileSync(SHIM_SOURCE, "utf8")).toContain("DUR-3998");
  });

  it("the isolation probe checks the bundle and the shim are read-only for agents", () => {
    const probe = fs.readFileSync(path.join(REPO_ROOT, "scripts/isolation-probe.sh"), "utf8");
    const targets = probe.split("\n").find((line) => line.startsWith("for target in /app/server/dist/index.js"));
    expect(targets).toContain("/app/cli/dist/index.js");
    expect(targets).toContain("/app/cli/node_modules/tsx/dist/cli.mjs");
  });
});

describe("the shim installed as cli/node_modules/tsx/dist/cli.mjs", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  // <root>/cli/src/index.ts       the TypeScript entry (must never run)
  // <root>/cli/dist/index.js      a stand-in bundle: prints what it was started with
  // <root>/cli/node_modules/tsx/dist/cli.mjs      the shim
  // <root>/cli/node_modules/tsx/dist/tsx-cli.mjs  a stand-in for the real tsx
  function layout(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "dur3998-shim-"));
    roots.push(root);
    for (const dir of ["cli/src", "cli/dist", "cli/node_modules/tsx/dist", "scripts"]) {
      fs.mkdirSync(path.join(root, dir), { recursive: true });
    }
    fs.writeFileSync(path.join(root, "cli/src/index.ts"), 'throw new Error("the TypeScript entry ran");\n');
    fs.writeFileSync(path.join(root, "scripts/other.ts"), "");
    fs.writeFileSync(
      path.join(root, "cli/dist/index.js"),
      'console.log(JSON.stringify({ ran: "prebuilt", argv: process.argv, url: import.meta.url }));\n' +
        "if (process.env.EXIT_WITH) process.exit(Number(process.env.EXIT_WITH));\n",
    );
    fs.copyFileSync(SHIM_SOURCE, path.join(root, "cli/node_modules/tsx/dist/cli.mjs"));
    fs.writeFileSync(
      path.join(root, "cli/node_modules/tsx/dist/tsx-cli.mjs"),
      'console.log(JSON.stringify({ ran: "tsx", argv: process.argv }));\n',
    );
    return root;
  }

  type Outcome = { status: number | null; ran: string | null; argv: string[]; url?: string; stderr: string };

  function run(cwd: string, shimPath: string, args: string[], env: Record<string, string> = {}): Outcome {
    const result = spawnSync(process.execPath, [shimPath, ...args], {
      cwd,
      encoding: "utf8",
      env: { ...process.env, ...env },
      timeout: 20_000,
    });
    const line = result.stdout.trim();
    const parsed = line ? (JSON.parse(line) as { ran: string; argv: string[]; url?: string }) : null;
    return {
      status: result.status,
      ran: parsed?.ran ?? null,
      argv: parsed?.argv ?? [],
      url: parsed?.url,
      stderr: result.stderr,
    };
  }

  it("runs the bundle in-process for cli/src/index.ts, with argv as Node gives a program started directly", () => {
    const root = layout();
    const out = run(root, "cli/node_modules/tsx/dist/cli.mjs", ["cli/src/index.ts", "issue", "list", "--json"]);
    expect(out.stderr).toBe("");
    expect(out.status).toBe(0);
    expect(out.ran).toBe("prebuilt");
    expect(out.argv[0]).toBe(process.execPath);
    expect(out.argv[1]).toBe(fs.realpathSync(path.join(root, "cli/dist/index.js")));
    expect(out.argv.slice(2)).toEqual(["issue", "list", "--json"]);
    expect(out.url).toBe(`file://${fs.realpathSync(path.join(root, "cli/dist/index.js"))}`);
  });

  it("recognises the entry by path: absolute, ./-prefixed, or relative to another working directory", () => {
    const root = layout();
    const absolute = run(root, "cli/node_modules/tsx/dist/cli.mjs", [path.join(root, "cli/src/index.ts"), "--version"]);
    expect(absolute.ran).toBe("prebuilt");
    expect(absolute.argv.slice(2)).toEqual(["--version"]);

    const dotted = run(root, "cli/node_modules/tsx/dist/cli.mjs", ["./cli/src/index.ts", "doctor"]);
    expect(dotted.ran).toBe("prebuilt");
    expect(dotted.argv.slice(2)).toEqual(["doctor"]);

    const fromCli = run(path.join(root, "cli"), "node_modules/tsx/dist/cli.mjs", ["src/index.ts", "approval", "list"]);
    expect(fromCli.ran).toBe("prebuilt");
    expect(fromCli.argv.slice(2)).toEqual(["approval", "list"]);
  });

  it("keeps the program's exit code", () => {
    const root = layout();
    const out = run(root, "cli/node_modules/tsx/dist/cli.mjs", ["cli/src/index.ts", "issue"], { EXIT_WITH: "3" });
    expect(out.ran).toBe("prebuilt");
    expect(out.status).toBe(3);
  });

  it("hands any other script to the real tsx with the arguments untouched", () => {
    const root = layout();
    const out = run(root, "cli/node_modules/tsx/dist/cli.mjs", ["scripts/other.ts", "--flag", "value"]);
    expect(out.status).toBe(0);
    expect(out.ran).toBe("tsx");
    expect(out.argv.slice(2)).toEqual(["scripts/other.ts", "--flag", "value"]);
  });

  it("hands a tsx flag, or no arguments at all, to the real tsx", () => {
    const root = layout();
    const flag = run(root, "cli/node_modules/tsx/dist/cli.mjs", ["--version"]);
    expect(flag.ran).toBe("tsx");
    expect(flag.argv.slice(2)).toEqual(["--version"]);

    const bare = run(root, "cli/node_modules/tsx/dist/cli.mjs", []);
    expect(bare.ran).toBe("tsx");
    expect(bare.argv.slice(2)).toEqual([]);
  });

  it("falls back to the real tsx when the bundle is missing (a checkout, or a broken build)", () => {
    const root = layout();
    fs.rmSync(path.join(root, "cli/dist/index.js"));
    const out = run(root, "cli/node_modules/tsx/dist/cli.mjs", ["cli/src/index.ts", "--version"]);
    expect(out.ran).toBe("tsx");
    expect(out.argv.slice(2)).toEqual(["cli/src/index.ts", "--version"]);
  });
});
