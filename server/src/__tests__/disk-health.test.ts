import { describe, expect, it } from "vitest";
import { createDiskHealthService, diskLevel } from "../services/disk-health.js";

const GB = 1024 ** 3;
function svc(usedGb: number, totalGb = 100) {
  return createDiskHealthService(
    {
      backupDir: "/tmp/does-not-matter/backups",
      statfs: async () => ({ bsize: GB, blocks: totalGb, bfree: totalGb - usedGb, bavail: totalGb - usedGb }),
      measure: async (dir) => (dir.endsWith("backups") ? 5 * GB : dir.endsWith("run-logs") ? 9 * GB : null),
    },
    0,
  );
}

describe("disk health", () => {
  it("maps thresholds", () => {
    expect(diskLevel(79.9)).toBe("ok");
    expect(diskLevel(80)).toBe("warn");
    expect(diskLevel(89.9)).toBe("warn");
    expect(diskLevel(90)).toBe("critical");
  });

  it("reports used/free, sorted folders and a warning", async () => {
    const r = await svc(85).getReport();
    expect(r.usedPercent).toBe(85);
    expect(r.level).toBe("warn");
    expect(r.freeBytes).toBe(15 * GB);
    expect(r.message).toMatch(/85% full/);
    expect(r.folders[0]).toMatchObject({ key: "runLogs", bytes: 9 * GB });
    expect(r.folders.map((f) => f.key).sort()).toEqual(["agentWorkspaces", "backups", "runLogs", "worktrees"]);
  });

  it("critical at 92% and no message when ok", async () => {
    expect((await svc(92).getReport()).level).toBe("critical");
    const ok = await svc(10).getReport();
    expect(ok.level).toBe("ok");
    expect(ok.message).toBeNull();
  });
});
