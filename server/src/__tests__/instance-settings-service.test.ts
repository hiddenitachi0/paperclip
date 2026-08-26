import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, instanceSettings } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { instanceSettingsService, normalizeExperimentalSettings } from "../services/instance-settings.js";

describe("instance settings service", () => {
  it("ignores retired experimental flags without resetting current settings", () => {
    expect(normalizeExperimentalSettings({
      enableEnvironments: true,
      enableIsolatedWorkspaces: true,
      enableIssuePlanDecompositions: true,
      enableExperimentalFileViewer: true,
      enableTaskWatchdogs: true,
      enableCloudSync: true,
      enableServerInfoDebugView: true,
      autoRestartDevServerWhenIdle: true,
      enableIssueGraphLivenessAutoRecovery: true,
      issueGraphLivenessAutoRecoveryLookbackHours: 48,
      enableNewestFirstIssueThread: true,
    })).toEqual({
      enableEnvironments: true,
      enableIsolatedWorkspaces: true,
      enableStreamlinedLeftNavigation: true,
      enableConferenceRoomChat: false,
      enableExternalObjects: false,
      enablePipelines: false,
      enableIssuePlanDecompositions: true,
      enableExperimentalFileViewer: true,
      enableTaskWatchdogs: true,
      enableCloudSync: true,
      enableServerInfoDebugView: true,
      autoRestartDevServerWhenIdle: true,
      enableIssueGraphLivenessAutoRecovery: true,
      issueGraphLivenessAutoRecoveryLookbackHours: 48,
    });
  });

  it("defaults enableConferenceRoomChat to false for empty and legacy stored settings", () => {
    expect(normalizeExperimentalSettings(undefined).enableConferenceRoomChat).toBe(false);
    expect(normalizeExperimentalSettings({}).enableConferenceRoomChat).toBe(false);
    // Rows persisted before the flag existed (PAP-137) must normalize to off.
    expect(
      normalizeExperimentalSettings({ enableStreamlinedLeftNavigation: true }).enableConferenceRoomChat,
    ).toBe(false);
  });

  it("defaults enableTaskWatchdogs to false for empty and legacy stored settings", () => {
    expect(normalizeExperimentalSettings(undefined).enableTaskWatchdogs).toBe(false);
    expect(normalizeExperimentalSettings({}).enableTaskWatchdogs).toBe(false);
    expect(
      normalizeExperimentalSettings({ enableExperimentalFileViewer: true }).enableTaskWatchdogs,
    ).toBe(false);
  });

  it("defaults enableServerInfoDebugView to false for empty and legacy stored settings", () => {
    expect(normalizeExperimentalSettings(undefined).enableServerInfoDebugView).toBe(false);
    expect(normalizeExperimentalSettings({}).enableServerInfoDebugView).toBe(false);
    expect(
      normalizeExperimentalSettings({ autoRestartDevServerWhenIdle: true }).enableServerInfoDebugView,
    ).toBe(false);
  });

  it("round-trips an enableConferenceRoomChat patch through the update merge", () => {
    // updateExperimental merges `{ ...normalize(current), ...patch }` and
    // re-normalizes; emulate that to prove the flag survives the roundtrip
    // without disturbing other settings.
    const current = normalizeExperimentalSettings({});
    const enabled = normalizeExperimentalSettings({ ...current, enableConferenceRoomChat: true });
    expect(enabled.enableConferenceRoomChat).toBe(true);
    expect(enabled.enableStreamlinedLeftNavigation).toBe(true);

    const disabled = normalizeExperimentalSettings({ ...enabled, enableConferenceRoomChat: false });
    expect(disabled).toEqual(current);
  });

  it("rejects non-boolean enableConferenceRoomChat values back to the default", () => {
    expect(
      normalizeExperimentalSettings({ enableConferenceRoomChat: "yes" }).enableConferenceRoomChat,
    ).toBe(false);
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres quiet-mode service tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("DUR-224 quiet mode", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-quiet-mode-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(instanceSettings);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompanyWithAgent(overrides: { heartbeat: Record<string, unknown> }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `Company ${companyId.slice(0, 6)}`,
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: `Agent ${agentId.slice(0, 6)}`,
      role: "engineer",
      status: "idle",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: { heartbeat: overrides.heartbeat },
      permissions: {},
    });
    return { companyId, agentId };
  }

  it("snapshots exact per-agent flags on activate and restores them exactly on deactivate", async () => {
    const svc = instanceSettingsService(db);
    // one company with an already-awake agent (default wakeOnDemand=true
    // since it's unset), one company with an agent that was deliberately
    // left fully asleep before quiet mode ever ran.
    const awake = await seedCompanyWithAgent({ heartbeat: { enabled: true, intervalSec: 300 } });
    const asleep = await seedCompanyWithAgent({ heartbeat: { enabled: false, wakeOnDemand: false } });

    const actor = { actorType: "board", actorId: "local-board", agentId: null };
    const activated = await svc.activateQuietMode(actor);
    expect(activated.active).toBe(true);
    expect(activated.snapshot).toHaveLength(2);
    const snapshotByAgent = new Map(activated.snapshot!.map((entry) => [entry.agentId, entry]));
    expect(snapshotByAgent.get(awake.agentId)).toMatchObject({ enabled: true, wakeOnDemand: true });
    expect(snapshotByAgent.get(asleep.agentId)).toMatchObject({ enabled: false, wakeOnDemand: false });

    const [awakeRowAfterActivate] = await db.select().from(agents).where(eq(agents.id, awake.agentId));
    const awakeHeartbeatAfterActivate = (awakeRowAfterActivate!.runtimeConfig as any).heartbeat;
    expect(awakeHeartbeatAfterActivate.enabled).toBe(false);
    expect(awakeHeartbeatAfterActivate.wakeOnDemand).toBe(false);
    // unrelated fields on the agent's heartbeat config must survive the flip
    expect(awakeHeartbeatAfterActivate.intervalSec).toBe(300);

    const statusWhileActive = await svc.getQuietMode();
    expect(statusWhileActive.active).toBe(true);

    // calling activate again while already active must be a no-op, not
    // re-snapshot the now-quiesced (false/false) state.
    const reactivated = await svc.activateQuietMode(actor);
    expect(reactivated).toEqual(activated);

    const deactivated = await svc.deactivateQuietMode(actor);
    expect(deactivated.active).toBe(false);
    expect(deactivated.snapshot).toBeNull();

    const [awakeRowAfterRestore] = await db.select().from(agents).where(eq(agents.id, awake.agentId));
    const awakeHeartbeatAfterRestore = (awakeRowAfterRestore!.runtimeConfig as any).heartbeat;
    expect(awakeHeartbeatAfterRestore.enabled).toBe(true);
    expect(awakeHeartbeatAfterRestore.wakeOnDemand).toBe(true);

    const [asleepRowAfterRestore] = await db.select().from(agents).where(eq(agents.id, asleep.agentId));
    const asleepHeartbeatAfterRestore = (asleepRowAfterRestore!.runtimeConfig as any).heartbeat;
    // the deliberately-asleep agent must NOT be woken up by the restore --
    // exactly the trap the ticket calls out for blanket-enable approaches.
    expect(asleepHeartbeatAfterRestore.enabled).toBe(false);
    expect(asleepHeartbeatAfterRestore.wakeOnDemand).toBe(false);

    const statusAfterDeactivate = await svc.getQuietMode();
    expect(statusAfterDeactivate.active).toBe(false);
  });

  it("is a no-op to deactivate when quiet mode was never activated", async () => {
    const svc = instanceSettingsService(db);
    const result = await svc.deactivateQuietMode({ actorType: "board", actorId: "local-board", agentId: null });
    expect(result.active).toBe(false);
    expect(result.snapshot).toBeNull();
  });
});
