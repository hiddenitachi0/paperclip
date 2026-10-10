import { describe, expect, it } from "vitest";
import {
  buildTowerFloor,
  towerNameplate,
  workingAgentIdsFromRuns,
  type TowerAgentInput,
  type TowerRect,
} from "./tower-layout";

const a = (id: string, reportsTo: string | null, extra: Partial<TowerAgentInput> = {}): TowerAgentInput => ({
  id,
  name: id,
  role: "engineer",
  status: "idle",
  reportsTo,
  ...extra,
});

const inside = (p: { x: number; y: number }, r: TowerRect) => p.x > r.x0 && p.x < r.x1 && p.y > r.y0 && p.y < r.y1;
const contains = (outer: TowerRect, inner: TowerRect) =>
  inner.x0 >= outer.x0 && inner.x1 <= outer.x1 && inner.y0 >= outer.y0 && inner.y1 <= outer.y1;

// CEO → CTO → (Backend, Frontend); CEO → Writer
const ORG = [
  a("ceo", null, { role: "ceo" }),
  a("cto", "ceo", { role: "cto" }),
  a("backend", "cto"),
  a("frontend", "cto"),
  a("writer", "ceo", { role: "general" }),
];

describe("buildTowerFloor", () => {
  it("gives every manager a room, nested by the reporting tree", () => {
    const layout = buildTowerFloor(ORG, new Set(["ceo", "cto", "backend", "frontend", "writer"]));
    const rooms = new Map(layout.rooms.map((r) => [r.managerId, r]));
    expect([...rooms.keys()].sort()).toEqual(["ceo", "cto"]);
    expect(rooms.get("ceo")!.depth).toBe(0);
    expect(rooms.get("cto")!.depth).toBe(1);
    // The CTO's room sits inside the CEO's room, and inside the building.
    expect(contains(rooms.get("ceo")!, rooms.get("cto")!)).toBe(true);
    expect(contains(layout.building, rooms.get("ceo")!)).toBe(true);
  });

  it("puts each report's desk in their manager's room and managers in a private office", () => {
    const layout = buildTowerFloor(ORG, new Set());
    const rooms = new Map(layout.rooms.map((r) => [r.managerId, r]));
    const desks = new Map(layout.desks.map((d) => [d.agentId, d]));
    expect(inside(desks.get("backend")!, rooms.get("cto")!)).toBe(true);
    expect(inside(desks.get("frontend")!, rooms.get("cto")!)).toBe(true);
    expect(inside(desks.get("writer")!, rooms.get("ceo")!)).toBe(true);
    expect(inside(desks.get("writer")!, rooms.get("cto")!)).toBe(false);

    const offices = new Map(layout.offices.map((o) => [o.managerId, o]));
    expect([...offices.keys()].sort()).toEqual(["ceo", "cto"]);
    expect(inside(desks.get("ceo")!, offices.get("ceo")!)).toBe(true);
    expect(inside(desks.get("cto")!, offices.get("cto")!)).toBe(true);
    expect(desks.get("cto")!.isManager).toBe(true);
    expect(desks.get("backend")!.isManager).toBe(false);
  });

  it("seats only working agents at their desks; everyone else is in the break room", () => {
    const layout = buildTowerFloor(ORG, new Set(["backend"]));
    const people = new Map(layout.people.map((p) => [p.agentId, p]));
    const desks = new Map(layout.desks.map((d) => [d.agentId, d]));

    expect(people.get("backend")!.place).toBe("desk");
    expect(people.get("backend")!.x).toBe(desks.get("backend")!.x);
    expect(desks.get("backend")!.occupied).toBe(true);

    for (const id of ["ceo", "cto", "frontend", "writer"]) {
      expect(people.get(id)!.place).toBe("break");
      expect(inside(people.get(id)!, layout.breakRoom)).toBe(true);
      expect(desks.get(id)!.occupied).toBe(false);
    }
    // Break room is beside the building, not inside it.
    expect(layout.breakRoom.x0).toBeGreaterThan(layout.building.x1);
  });

  it("hides terminated agents and re-parents their reports to the top", () => {
    const layout = buildTowerFloor(
      [a("ceo", null, { role: "ceo" }), a("gone", "ceo", { status: "terminated" }), a("orphan", "gone")],
      new Set(["gone"]),
    );
    const ids = layout.people.map((p) => p.agentId).sort();
    expect(ids).toEqual(["ceo", "orphan"]);
    expect(layout.desks.some((d) => d.agentId === "gone")).toBe(false);
    expect(layout.rooms.some((r) => r.managerId === "gone")).toBe(false);
    expect(layout.people.find((p) => p.agentId === "orphan")!.bossId).toBeNull();
  });

  it("nests three levels deep and keeps every room inside its parent", () => {
    const layout = buildTowerFloor(
      [a("ceo", null), a("vp", "ceo"), a("lead", "vp"), a("dev1", "lead"), a("dev2", "lead")],
      new Set(),
    );
    const rooms = new Map(layout.rooms.map((r) => [r.managerId, r]));
    expect(rooms.get("lead")!.depth).toBe(2);
    expect(contains(rooms.get("vp")!, rooms.get("lead")!)).toBe(true);
    expect(contains(rooms.get("ceo")!, rooms.get("vp")!)).toBe(true);
  });

  it("survives a reporting cycle and lays out ~30 agents without overlap", () => {
    const cyc = buildTowerFloor([a("x", "y"), a("y", "x")], new Set());
    expect(cyc.people).toHaveLength(2);

    const big: TowerAgentInput[] = [a("ceo", null)];
    for (let m = 0; m < 4; m++) {
      big.push(a(`m${m}`, "ceo"));
      for (let w = 0; w < 6; w++) big.push(a(`m${m}w${w}`, `m${m}`));
    }
    const working = new Set(big.map((x) => x.id));
    const layout = buildTowerFloor(big, working);
    expect(layout.people).toHaveLength(29);
    const seen = new Set(layout.desks.map((d) => `${d.x.toFixed(2)}:${d.y.toFixed(2)}`));
    expect(seen.size).toBe(29);
  });
});

describe("helpers", () => {
  it("only counts running runs as working", () => {
    const ids = workingAgentIdsFromRuns([
      { agentId: "a", status: "running" },
      { agentId: "b", status: "queued" },
    ]);
    expect([...ids]).toEqual(["a"]);
  });

  it("keeps nameplates short", () => {
    expect(towerNameplate("CEO")).toBe("CEO");
    expect(towerNameplate("Quarterly Reporting Agent")).toBe("Quarterly");
    expect(towerNameplate("Supercalifragilistic")).toBe("Supercali…");
  });
});
