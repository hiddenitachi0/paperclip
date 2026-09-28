import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { companies, companySkills, createDb, issues } from "@paperclipai/db";
import { RESEARCH_RESULT_DOCUMENT_KEY, RESEARCH_SKILL_KEY } from "@paperclipai/shared";
import { resolvePaperclipDesiredSkillNames } from "@paperclipai/adapter-utils/server-utils";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { buildResearchTaskDescription } from "../services/research-tasks.ts";
import { findResearchSkillLink } from "../services/research-skill-link.ts";
import { applyRunScopedMentionedSkillKeys, extractMentionedSkillIdsFromSources } from "../services/heartbeat.ts";
import { documentService } from "../services/documents.ts";

// Research tasks against a real database: the research-and-plan skill a
// quick agent's hand-over mentions is the bundled one and is mounted for that
// task's run, and the result page the run writes is the document the chat
// links to.

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres research task tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("research tasks (database)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-research-tasks-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany() {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Research Co",
      issuePrefix: `R${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  it("mentions the bundled research-and-plan skill, and a run of that task mounts it", async () => {
    const companyId = await seedCompany();

    const link = await findResearchSkillLink(db, companyId);
    expect(link).toMatch(/^\[research-and-plan\]\(skill:\/\/[0-9a-f-]{36}\?s=research-and-plan\)$/);

    const description = buildResearchTaskDescription({ kind: "trip_plan", brief: "Rome", handedOverBy: "Maja", skillLink: link });
    const [skillId] = extractMentionedSkillIdsFromSources([description]);
    const [row] = await db.select().from(companySkills).where(eq(companySkills.id, skillId!));
    expect(row).toMatchObject({ companyId, key: RESEARCH_SKILL_KEY, slug: "research-and-plan" });
    expect(row?.markdown).toContain("Research and writing only");

    // What the heartbeat does with a mention: the skill joins this run's desired skills.
    const config = applyRunScopedMentionedSkillKeys({}, [row!.key]);
    expect(resolvePaperclipDesiredSkillNames(config, [{ key: row!.key }])).toContain(RESEARCH_SKILL_KEY);

    // A second look-up finds the same row (no re-import, no duplicate).
    expect(await findResearchSkillLink(db, companyId)).toBe(link);
  });

  it("the result page a run writes is the document the chat links to", async () => {
    const companyId = await seedCompany();
    const issueId = randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId,
      identifier: "RES-1",
      title: "Trip plan: Rome",
      status: "in_progress",
      priority: "medium",
    });
    const docs = documentService(db);
    await docs.upsertIssueDocument({
      issueId,
      key: RESEARCH_RESULT_DOCUMENT_KEY,
      title: "Rome, 4 days",
      format: "markdown",
      body: "# Rome, 4 days\n\nChecked 28 Sep 2026 10:00 CEST; prices can change.",
    });

    const found = await docs.getIssueDocumentByKey(issueId, RESEARCH_RESULT_DOCUMENT_KEY);
    expect(found).toMatchObject({ key: "result", title: "Rome, 4 days" });
    expect(found?.body).toContain("prices can change");
  });
});
