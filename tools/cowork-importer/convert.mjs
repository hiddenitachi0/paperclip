#!/usr/bin/env node
// cowork-importer — convert a Claude Code / Cowork project into an
// `agentcompanies/v1` package and (optionally) import it into a running
// Paperclip instance via the official /companies/import API.
//
// This is an EXTERNAL converter: it touches no Paperclip core code. It only
// reads a project folder and writes markdown / calls the public import API.
//
// Usage:
//   node convert.mjs <project-dir> [options]
//
// Options:
//   --out <dir>            Write the agentcompanies/v1 package to <dir> (inspect / commit to GitHub)
//   --print               Print the import bundle JSON to stdout
//   --import              POST the package to a running Paperclip import API (creates a new company)
//   --dry-run             With --import, call /companies/import/preview instead of applying
//   --api <url>           Paperclip base URL (default http://localhost:3100)
//   --company-name <name> Override the company name (default: project frontmatter name or folder name)
//   -h, --help
//
// Mapping (per the paperclip-fork brief + docs/companies/companies-spec.md):
//   - Single-task project (no .claude/agents/*) → ONE agent; instructions = AGENTS.md body.
//   - Broader project (has .claude/agents/*)     → a lead agent (from CLAUDE.md) + one agent per
//                                                  subagent file, each reporting to the lead.
//   - SKILL.md files are copied through as-is (Agent Skills compatibility).
//   - A .paperclip.yaml sidecar carries adapter (claude_local) + role + sidebar order.

import fs from "node:fs";
import path from "node:path";

// ---------- tiny arg parser ----------

function parseArgs(argv) {
  const opts = { api: "http://localhost:3100" };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") opts.help = true;
    else if (a === "--out") opts.out = argv[++i];
    else if (a === "--print") opts.print = true;
    else if (a === "--import") opts.import = true;
    else if (a === "--dry-run") opts.dryRun = true;
    else if (a === "--api") opts.api = argv[++i];
    else if (a === "--company-name") opts.companyName = argv[++i];
    else if (a.startsWith("--")) fail(`Unknown option: ${a}`);
    else positional.push(a);
  }
  opts.projectDir = positional[0];
  return opts;
}

function fail(msg) {
  console.error(`cowork-importer: ${msg}`);
  process.exit(1);
}

const HELP = `cowork-importer — Claude Code / Cowork project → agentcompanies/v1 → Paperclip import

Usage:
  node convert.mjs <project-dir> [--out <dir> | --print | --import] [options]

Options:
  --out <dir>            Write the package to <dir>
  --print               Print the import bundle JSON
  --import              Import into a running Paperclip (new company)
  --dry-run             With --import, preview instead of apply
  --api <url>           Paperclip base URL (default http://localhost:3100)
  --company-name <name> Override the company name
  -h, --help
`;

// ---------- markdown / yaml helpers ----------

function slugify(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64) || "item";
}

// Minimal frontmatter reader. Handles a leading `--- ... ---` block with simple
// `key: value` scalars (quoted or bare). We only need `name`/`description`.
function readFrontmatter(md) {
  if (!md.startsWith("---")) return { frontmatter: {}, body: md };
  const end = md.indexOf("\n---", 3);
  if (end === -1) return { frontmatter: {}, body: md };
  const raw = md.slice(md.indexOf("\n") + 1, end);
  const body = md.slice(md.indexOf("\n", end + 1) + 1);
  const frontmatter = {};
  for (const line of raw.split("\n")) {
    const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    frontmatter[m[1]] = v;
  }
  return { frontmatter, body: body.replace(/^\n+/, "") };
}

function yamlString(s) {
  return `"${String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

// Emit a `--- ... ---\n\n<body>` markdown doc. `fields` is an ordered array of
// [key, value]; string values are quoted, arrays become YAML lists.
function emitMarkdown(fields, body) {
  const lines = ["---"];
  for (const [k, v] of fields) {
    if (v == null) continue;
    if (Array.isArray(v)) {
      if (v.length === 0) continue;
      lines.push(`${k}:`);
      for (const item of v) lines.push(`  - ${yamlString(item)}`);
    } else {
      lines.push(`${k}: ${yamlString(v)}`);
    }
  }
  lines.push("---", "");
  return `${lines.join("\n")}\n${body ?? ""}`.replace(/\n+$/, "\n");
}

// ---------- filesystem discovery ----------

function readIfExists(p) {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

function listFiles(dir, filterFn) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => filterFn(e))
      .map((e) => path.join(dir, e.name));
  } catch {
    return [];
  }
}

// Root instructions: first of CLAUDE.md / AGENTS.md / .claude/CLAUDE.md.
function readRootInstructions(root) {
  for (const rel of ["CLAUDE.md", "AGENTS.md", ".claude/CLAUDE.md"]) {
    const c = readIfExists(path.join(root, rel));
    if (c != null) return c;
  }
  return null;
}

// Subagents live in .claude/agents/*.md (Claude Code) or agents/*.md.
function readSubagents(root) {
  const dirs = [path.join(root, ".claude", "agents"), path.join(root, "agents")];
  const out = [];
  for (const dir of dirs) {
    for (const file of listFiles(dir, (e) => e.isFile() && e.name.endsWith(".md"))) {
      const md = readIfExists(file);
      if (md == null) continue;
      const { frontmatter, body } = readFrontmatter(md);
      const base = path.basename(file, ".md");
      out.push({
        name: frontmatter.name || base,
        description: frontmatter.description || null,
        slug: slugify(frontmatter.name || base),
        body: body.trim() ? body : md, // fall back to whole file if no body
      });
    }
  }
  return out;
}

// Skills: .claude/skills/<slug>/SKILL.md, skills/<slug>/SKILL.md, .agents/skills/<slug>/SKILL.md.
function readSkills(root) {
  const roots = [
    path.join(root, ".claude", "skills"),
    path.join(root, "skills"),
    path.join(root, ".agents", "skills"),
  ];
  const out = [];
  const seen = new Set();
  for (const skillsRoot of roots) {
    for (const dir of listFiles(skillsRoot, (e) => e.isDirectory())) {
      const md = readIfExists(path.join(dir, "SKILL.md"));
      if (md == null) continue;
      const { frontmatter } = readFrontmatter(md);
      const slug = slugify(frontmatter.name || path.basename(dir));
      if (seen.has(slug)) continue;
      seen.add(slug);
      out.push({ slug, name: frontmatter.name || slug, content: md });
    }
  }
  return out;
}

// ---------- build the package ----------

function buildPackage(root, companyNameOverride) {
  const rootInstructions = readRootInstructions(root);
  const rootFm = rootInstructions ? readFrontmatter(rootInstructions) : { frontmatter: {}, body: "" };
  const companyName =
    companyNameOverride || rootFm.frontmatter.name || path.basename(path.resolve(root));
  const companySlug = slugify(companyName);

  const subagents = readSubagents(root);
  const skills = readSkills(root);

  const agents = [];
  if (subagents.length > 0) {
    // Broader project: a lead agent (from the root instructions) + each subagent.
    const leadSlug = companySlug;
    const usedSlugs = new Set();
    const lead = {
      slug: leadSlug,
      name: companyName,
      reportsTo: null,
      body: rootFm.body || rootInstructions || "",
    };
    agents.push(lead);
    usedSlugs.add(leadSlug);
    for (const sub of subagents) {
      let slug = sub.slug;
      while (usedSlugs.has(slug)) slug = `${slug}-1`;
      usedSlugs.add(slug);
      agents.push({ slug, name: sub.name, reportsTo: leadSlug, body: sub.body });
    }
  } else {
    // Single-task project: one specialized agent, instructions = the body.
    agents.push({
      slug: companySlug,
      name: companyName,
      reportsTo: null,
      body: rootFm.body || rootInstructions || "",
    });
  }

  const files = {};

  files["COMPANY.md"] = emitMarkdown(
    [
      ["name", companyName],
      ["schema", "agentcompanies/v1"],
      ["slug", companySlug],
      ["description", rootFm.frontmatter.description || null],
    ],
    "",
  );

  for (const agent of agents) {
    files[`agents/${agent.slug}/AGENTS.md`] = emitMarkdown(
      [
        ["name", agent.name],
        ["reportsTo", agent.reportsTo],
      ],
      agent.body || "",
    );
  }

  for (const skill of skills) {
    files[`skills/${skill.slug}/SKILL.md`] = skill.content;
  }

  // Paperclip fidelity sidecar (adapter + role + sidebar order).
  files[".paperclip.yaml"] = buildPaperclipYaml(agents);

  return { companyName, companySlug, files, counts: { agents: agents.length, skills: skills.length } };
}

function buildPaperclipYaml(agents) {
  const lines = ['schema: "paperclip/v1"', "agents:"];
  for (const a of agents) {
    lines.push(`  ${a.slug}:`);
    lines.push(`    role: "general"`);
    lines.push(`    adapter:`);
    lines.push(`      type: "claude_local"`);
  }
  lines.push("sidebar:");
  lines.push("  agents:");
  for (const a of agents) lines.push(`    - ${yamlString(a.slug)}`);
  return `${lines.join("\n")}\n`;
}

// ---------- outputs ----------

function writeOut(outDir, files) {
  for (const [rel, content] of Object.entries(files)) {
    const dest = path.join(outDir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, content);
  }
}

async function importToPaperclip({ api, files, companyName, dryRun }) {
  const url = `${api.replace(/\/$/, "")}/api/companies/import${dryRun ? "/preview" : ""}`;
  const body = {
    source: { type: "inline", files },
    target: { mode: "new_company", newCompanyName: companyName },
  };
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) fail(`import failed (${res.status}): ${text}`);
  return JSON.parse(text);
}

// ---------- main ----------

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help || !opts.projectDir) {
    process.stdout.write(HELP);
    process.exit(opts.help ? 0 : 1);
  }
  if (!fs.existsSync(opts.projectDir)) fail(`project dir not found: ${opts.projectDir}`);

  const pkg = buildPackage(opts.projectDir, opts.companyName);
  console.error(
    `Built package "${pkg.companyName}" (${pkg.companySlug}): ` +
      `${pkg.counts.agents} agent(s), ${pkg.counts.skills} skill(s), ${Object.keys(pkg.files).length} file(s).`,
  );

  let didSomething = false;
  if (opts.out) {
    writeOut(opts.out, pkg.files);
    console.error(`Wrote package to ${opts.out}`);
    didSomething = true;
  }
  if (opts.print) {
    process.stdout.write(
      `${JSON.stringify({ source: { type: "inline", files: pkg.files }, target: { mode: "new_company", newCompanyName: pkg.companyName } }, null, 2)}\n`,
    );
    didSomething = true;
  }
  if (opts.import) {
    const result = await importToPaperclip({
      api: opts.api,
      files: pkg.files,
      companyName: pkg.companyName,
      dryRun: opts.dryRun,
    });
    if (opts.dryRun) {
      console.error("Preview OK.");
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      const id = result?.company?.id ?? "(unknown)";
      const prefix = result?.company?.issuePrefix ?? "";
      console.error(`Imported. Company id=${id} prefix=${prefix}`);
    }
    didSomething = true;
  }
  if (!didSomething) {
    console.error("Nothing to do — pass --out, --print, or --import. See --help.");
    process.exit(1);
  }
}

main().catch((e) => fail(e?.stack || String(e)));
