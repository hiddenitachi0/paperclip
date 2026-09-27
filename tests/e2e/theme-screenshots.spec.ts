import { test, expect, request as pwRequest, type APIRequestContext, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Theme visual QA — dark and light.
 *
 * Boots the shared throwaway local_trusted instance (see playwright.config.ts
 * webServer), seeds one company with an agent and a task, then captures the
 * six surfaces an operator lives in — in BOTH themes:
 *   - Now (dashboard/now)
 *   - Agents list
 *   - An agent's settings (configuration) page
 *   - Company settings → Connections
 *   - Tools
 *   - A task page
 *
 * Screenshots land in ./test-results/theme-shots/<theme>/NN-name.png. CI
 * uploads that folder as the `theme-screenshots` artifact (see
 * .github/workflows/pr.yml and e2e.yml). It also checks that the stored
 * choice and the OS preference both drive the first paint (no flash).
 */

const PORT = process.env.PAPERCLIP_E2E_PORT ?? "3199";
const BASE_URL = `http://127.0.0.1:${PORT}`;
// Under the gitignored test-results dir so re-runs leave no untracked noise.
const SHOT_DIR = path.join(__dirname, "test-results", "theme-shots");
const THEME_KEY = "paperclip.theme";

type Theme = "dark" | "light";
const THEMES: Theme[] = ["dark", "light"];

interface Seed {
  prefix: string;
  agentId: string;
  taskRef: string;
}

async function seedCompany(board: APIRequestContext): Promise<Seed> {
  const health = await board.get(`${BASE_URL}/api/health`);
  expect(health.ok()).toBe(true);

  const companyRes = await board.post(`${BASE_URL}/api/companies`, { data: { name: "Theme QA" } });
  expect(companyRes.ok(), await companyRes.text()).toBe(true);
  const company = await companyRes.json();
  const prefix: string = company.issuePrefix ?? company.prefix ?? company.urlKey;
  expect(prefix, "company should expose a URL prefix").toBeTruthy();

  // A process-adapter agent that exits immediately: enough for the agent
  // list and settings page to render, without any LLM traffic.
  const hireRes = await board.post(`${BASE_URL}/api/companies/${company.id}/agent-hires`, {
    data: {
      name: "Theme Reviewer",
      role: "engineer",
      title: "Software Engineer",
      adapterType: "process",
      adapterConfig: { command: process.execPath, args: ["-e", "process.exit(0)"] },
    },
  });
  expect(hireRes.ok(), await hireRes.text()).toBe(true);
  const hire = await hireRes.json();
  if (hire.approval) {
    const approveRes = await board.post(`${BASE_URL}/api/approvals/${hire.approval.id}/approve`, {
      data: { decisionNote: "Approved for theme screenshots." },
    });
    expect(approveRes.ok(), await approveRes.text()).toBe(true);
  }
  const agentId: string = hire.agent.id;

  const issueRes = await board.post(`${BASE_URL}/api/companies/${company.id}/issues`, {
    data: {
      title: "Check the new dark and light themes",
      description:
        "Open every screen in both themes and note anything that is hard to read: section edges, input fields, muted text.",
      status: "todo",
      priority: "high",
      assigneeAgentId: agentId,
    },
  });
  expect(issueRes.ok(), await issueRes.text()).toBe(true);
  const issue = await issueRes.json();

  return { prefix, agentId, taskRef: issue.identifier ?? issue.id };
}

function screens(seed: Seed): Array<[string, string]> {
  return [
    ["01-now", `/${seed.prefix}/dashboard/now`],
    ["02-agents", `/${seed.prefix}/agents/all`],
    ["03-agent-settings", `/${seed.prefix}/agents/${seed.agentId}/configuration`],
    ["04-company-connections", `/${seed.prefix}/company/settings/connections`],
    ["05-tools", `/${seed.prefix}/tools`],
    ["06-task", `/${seed.prefix}/issues/${seed.taskRef}`],
  ];
}

async function setStoredTheme(page: Page, value: Theme | "system" | null) {
  await page.evaluate(
    ([key, next]) => {
      if (next === null) window.localStorage.removeItem(key);
      else window.localStorage.setItem(key, next);
    },
    [THEME_KEY, value] as const,
  );
}

function isDark(page: Page): Promise<boolean> {
  return page.evaluate(() => document.documentElement.classList.contains("dark"));
}

async function settle(page: Page) {
  // Some surfaces keep a live feed open, so never fail on "networkidle".
  await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => undefined);
  await page.waitForTimeout(500);
}

test.describe("Theme screenshots", () => {
  test.describe.configure({ mode: "serial" });
  test.use({ viewport: { width: 1440, height: 900 } });

  let seed: Seed;

  test.beforeAll(async () => {
    const board = await pwRequest.newContext({ baseURL: BASE_URL });
    try {
      seed = await seedCompany(board);
    } finally {
      await board.dispose();
    }
  });

  for (const theme of THEMES) {
    test(`captures the operator surfaces in ${theme} mode`, async ({ page }) => {
      const dir = path.join(SHOT_DIR, theme);
      fs.mkdirSync(dir, { recursive: true });

      const pageErrors: string[] = [];
      page.on("pageerror", (err) => pageErrors.push(err.message));

      // Visit the company dashboard first so CompanyContext selects the
      // company from the route before the screens below.
      await page.goto(`/${seed.prefix}/dashboard`);
      await setStoredTheme(page, theme);

      for (const [name, route] of screens(seed)) {
        await page.goto(route);
        await settle(page);
        // The pre-hydration script and ThemeProvider must both honour the
        // stored choice on every route.
        expect(await isDark(page), `${route} should render the ${theme} theme`).toBe(theme === "dark");
        const file = path.join(dir, `${name}.png`);
        await page.screenshot({ path: file, fullPage: true });
        expect(fs.statSync(file).size, `empty ${file}`).toBeGreaterThan(1_000);
      }

      const crashes = pageErrors.filter((e) => /Rendered more hooks|change in the order of Hooks/i.test(e));
      expect(crashes, crashes.join("\n")).toHaveLength(0);
    });
  }

  test("follows the OS preference when nothing is stored or the choice is 'system'", async ({ page }) => {
    await page.goto(`/${seed.prefix}/dashboard`);

    // New browser: nothing stored → OS decides the first paint.
    await setStoredTheme(page, null);
    await page.emulateMedia({ colorScheme: "light" });
    await page.reload();
    await settle(page);
    expect(await isDark(page)).toBe(false);

    await page.emulateMedia({ colorScheme: "dark" });
    await page.reload();
    await settle(page);
    expect(await isDark(page)).toBe(true);

    // Explicit "system" behaves the same, and flips live without a reload.
    await setStoredTheme(page, "system");
    await page.emulateMedia({ colorScheme: "light" });
    await page.reload();
    await settle(page);
    expect(await isDark(page)).toBe(false);

    await page.emulateMedia({ colorScheme: "dark" });
    await expect.poll(() => isDark(page), { timeout: 5_000 }).toBe(true);
    expect(await page.evaluate((key) => window.localStorage.getItem(key), THEME_KEY)).toBe("system");
  });
});
