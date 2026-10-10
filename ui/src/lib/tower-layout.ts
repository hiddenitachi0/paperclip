/**
 * Paperclip Tower — floor layout.
 *
 * Pure function: given one company's agents and which of them are working right
 * now, decide where every room, desk and person goes on that company's floor.
 * Coordinates are in "grid units" on the floor plane; the scene projects them to
 * isometric screen space.
 *
 * Filip's rules (keep on every edit):
 *  - Rooms follow the REAL reporting tree (agent.reportsTo). A manager's room
 *    holds their reports; a report who manages people gets a nested room.
 *  - Every manager's desk sits in a small private office at the back of their
 *    room. Workers sit at open desks in their manager's room.
 *  - Only agents with a running run sit at their desk. Everyone else is drawn
 *    in the break room (their desk stays, empty).
 *  - Terminated agents are not drawn at all.
 */

export interface TowerAgentInput {
  id: string;
  name: string;
  role: string;
  status: string;
  reportsTo: string | null;
}

export interface TowerRect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface TowerRoom extends TowerRect {
  /** The manager whose team this room holds. */
  managerId: string;
  /** 0 = a top-level team, 1 = nested inside one, … */
  depth: number;
}

export interface TowerOffice extends TowerRect {
  managerId: string;
}

export interface TowerDesk {
  agentId: string;
  x: number;
  y: number;
  isManager: boolean;
  occupied: boolean;
}

export interface TowerPerson {
  agentId: string;
  x: number;
  y: number;
  /** "desk" = working right now; "break" = everyone else. */
  place: "desk" | "break";
  isManager: boolean;
  /** Depth in the reporting tree (0 = top of the company). */
  depth: number;
  bossId: string | null;
}

export interface TowerFloorLayout {
  building: TowerRect;
  rooms: TowerRoom[];
  offices: TowerOffice[];
  desks: TowerDesk[];
  people: TowerPerson[];
  breakRoom: TowerRect & { kiosk: { x: number; y: number }; table: { x: number; y: number } };
  /** Bounding box over everything on the floor, in grid units. */
  bounds: TowerRect;
}

// Sizes in grid units (ported from the prototype, tuned for ~30 agents/floor).
const LEAF = 2.5;
const OFFICE_W = 3.2;
const OFFICE_H = 2.9;
const PAD = 1.0;
const GAP = 0.9;
const BREAK_SLOT = 3.4;
const SHELL_MARGIN = 0.6;

const ROLE_ORDER: Record<string, number> = {
  ceo: 0,
  cto: 1,
  cmo: 2,
  cfo: 3,
  pm: 4,
  engineer: 5,
  designer: 6,
  qa: 7,
  devops: 8,
  researcher: 9,
  general: 10,
};

interface Node {
  agent: TowerAgentInput;
  kids: Node[];
  depth: number;
  w: number;
  h: number;
  innerW: number;
  rows: Node[][];
  bossId: string | null;
}

/** Agents that are drawn at all: everyone except terminated ones. */
export function visibleTowerAgents<T extends { status: string }>(agents: readonly T[]): T[] {
  return agents.filter((a) => a.status !== "terminated");
}

function sortKids(a: Node, b: Node): number {
  const ra = ROLE_ORDER[a.agent.role] ?? 50;
  const rb = ROLE_ORDER[b.agent.role] ?? 50;
  // Managers first so nested rooms line up at the front of a team.
  const ma = a.kids.length > 0 ? 0 : 1;
  const mb = b.kids.length > 0 ? 0 : 1;
  return ma - mb || ra - rb || a.agent.name.localeCompare(b.agent.name);
}

function columnsFor(n: number): number {
  if (n <= 3) return n;
  if (n <= 8) return Math.ceil(n / 2);
  return Math.ceil(n / 3);
}

function measure(n: Node, depth: number): void {
  n.depth = depth;
  if (n.kids.length === 0) {
    n.w = LEAF;
    n.h = LEAF;
    n.innerW = LEAF;
    n.rows = [];
    return;
  }
  n.kids.forEach((k) => measure(k, depth + 1));
  n.kids.sort(sortKids);
  const cols = columnsFor(n.kids.length);
  n.rows = [];
  for (let i = 0; i < n.kids.length; i += cols) n.rows.push(n.kids.slice(i, i + cols));
  let innerW = 0;
  let innerH = 0;
  for (const row of n.rows) {
    innerW = Math.max(innerW, row.reduce((s, k) => s + k.w, 0) + GAP * (row.length - 1));
    innerH += Math.max(...row.map((k) => k.h)) + GAP;
  }
  innerH -= GAP;
  n.innerW = Math.max(innerW, OFFICE_W);
  n.w = n.innerW + PAD * 2;
  n.h = OFFICE_H + GAP + innerH + PAD * 2;
}

export function buildTowerFloor(
  agents: readonly TowerAgentInput[],
  workingAgentIds: ReadonlySet<string>,
): TowerFloorLayout {
  const live = visibleTowerAgents(agents);
  const byId = new Map<string, Node>();
  for (const a of live) {
    byId.set(a.id, { agent: a, kids: [], depth: 0, w: 0, h: 0, innerW: 0, rows: [], bossId: null });
  }
  const roots: Node[] = [];
  for (const node of byId.values()) {
    const bossId = node.agent.reportsTo;
    const boss = bossId && bossId !== node.agent.id ? byId.get(bossId) : undefined;
    if (boss) {
      node.bossId = boss.agent.id;
      boss.kids.push(node);
    } else {
      roots.push(node);
    }
  }
  // Guard against reporting cycles: anything unreachable from a root becomes a root.
  const reached = new Set<string>();
  const walk = (n: Node) => {
    if (reached.has(n.agent.id)) return;
    reached.add(n.agent.id);
    n.kids.forEach(walk);
  };
  roots.forEach(walk);
  for (const node of byId.values()) {
    if (!reached.has(node.agent.id)) {
      const boss = node.bossId ? byId.get(node.bossId) : undefined;
      if (boss) boss.kids = boss.kids.filter((k) => k !== node);
      node.bossId = null;
      roots.push(node);
      walk(node);
    }
  }

  roots.forEach((r) => measure(r, 0));
  roots.sort(sortKids);

  const rooms: TowerRoom[] = [];
  const offices: TowerOffice[] = [];
  const desks: TowerDesk[] = [];
  const deskPos = new Map<string, { x: number; y: number; isManager: boolean; depth: number; bossId: string | null }>();

  const place = (n: Node, x: number, y: number, roomDepth: number) => {
    if (n.kids.length === 0) {
      deskPos.set(n.agent.id, { x: x + n.w / 2, y: y + n.h / 2, isManager: false, depth: n.depth, bossId: n.bossId });
      return;
    }
    rooms.push({ managerId: n.agent.id, depth: roomDepth, x0: x, y0: y, x1: x + n.w, y1: y + n.h });
    const ox = x + PAD + n.innerW / 2;
    offices.push({
      managerId: n.agent.id,
      x0: ox - OFFICE_W / 2,
      y0: y + PAD * 0.45,
      x1: ox + OFFICE_W / 2,
      y1: y + PAD + OFFICE_H - 0.2,
    });
    deskPos.set(n.agent.id, { x: ox, y: y + PAD + OFFICE_H / 2 - 0.15, isManager: true, depth: n.depth, bossId: n.bossId });
    let cy = y + PAD + OFFICE_H + GAP;
    for (const row of n.rows) {
      const rw = row.reduce((s, k) => s + k.w, 0) + GAP * (row.length - 1);
      const rh = Math.max(...row.map((k) => k.h));
      let cx = x + PAD + (n.innerW - rw) / 2;
      for (const k of row) {
        place(k, cx, cy + (rh - k.h) / 2, roomDepth + 1);
        cx += k.w + GAP;
      }
      cy += rh + GAP;
    }
  };

  const ORIGIN_X = 1;
  const ORIGIN_Y = 1;
  let cursorX = ORIGIN_X;
  let maxH = 0;
  for (const r of roots) {
    place(r, cursorX, ORIGIN_Y, 0);
    cursorX += r.w + GAP;
    maxH = Math.max(maxH, r.h);
  }
  const contentW = Math.max(cursorX - GAP - ORIGIN_X, LEAF);
  const contentH = Math.max(maxH, LEAF);
  const building: TowerRect = {
    x0: ORIGIN_X - SHELL_MARGIN,
    y0: ORIGIN_Y - SHELL_MARGIN,
    x1: ORIGIN_X + contentW + SHELL_MARGIN,
    y1: ORIGIN_Y + contentH + SHELL_MARGIN,
  };

  // Break room: its own room beside the building.
  const resting = live.filter((a) => !workingAgentIds.has(a.id));
  const cols = Math.max(3, Math.min(5, Math.ceil(Math.sqrt(Math.max(resting.length, 1)))));
  const rows = Math.max(1, Math.ceil(resting.length / cols));
  const bx0 = building.x1 + 1.4;
  const by0 = building.y0;
  const breakRoom = {
    x0: bx0,
    y0: by0,
    x1: bx0 + cols * BREAK_SLOT + 2.2,
    y1: Math.max(by0 + rows * BREAK_SLOT + 4.2, by0 + 7),
    kiosk: { x: bx0 + 0.9, y: by0 + 0.9 },
    table: { x: bx0 + 1.1 + (cols * BREAK_SLOT) / 2, y: by0 + 1.6 },
  };

  const people: TowerPerson[] = [];
  let restIndex = 0;
  // Stable order: walk the tree so the break room groups teams together.
  const ordered: TowerAgentInput[] = [];
  const collect = (n: Node) => {
    ordered.push(n.agent);
    n.kids.forEach(collect);
  };
  roots.forEach(collect);
  for (const a of ordered) {
    const d = deskPos.get(a.id)!;
    const working = workingAgentIds.has(a.id);
    desks.push({ agentId: a.id, x: d.x, y: d.y, isManager: d.isManager, occupied: working });
    if (working) {
      people.push({ agentId: a.id, x: d.x, y: d.y, place: "desk", isManager: d.isManager, depth: d.depth, bossId: d.bossId });
    } else {
      const i = restIndex++;
      people.push({
        agentId: a.id,
        x: bx0 + 1.6 + (i % cols) * BREAK_SLOT,
        y: by0 + 3.6 + Math.floor(i / cols) * BREAK_SLOT,
        place: "break",
        isManager: d.isManager,
        depth: d.depth,
        bossId: d.bossId,
      });
    }
  }

  const bounds: TowerRect = {
    x0: Math.min(building.x0, breakRoom.x0),
    y0: Math.min(building.y0, breakRoom.y0),
    x1: Math.max(building.x1, breakRoom.x1),
    y1: Math.max(building.y1, breakRoom.y1),
  };

  return { building, rooms, offices, desks, people, breakRoom, bounds };
}

/** The set of agent ids that have a run in the "running" state. */
export function workingAgentIdsFromRuns(runs: ReadonlyArray<{ agentId: string; status: string }> | undefined): Set<string> {
  const ids = new Set<string>();
  for (const run of runs ?? []) {
    if (run.status === "running") ids.add(run.agentId);
  }
  return ids;
}

/** Short pixel-font nameplate text (Silkscreen is wide; keep plates small). */
export function towerNameplate(name: string, max = 10): string {
  const trimmed = name.trim();
  if (trimmed.length <= max) return trimmed;
  const firstWord = trimmed.split(/\s+/)[0] ?? trimmed;
  if (firstWord.length >= 4 && firstWord.length <= max) return firstWord;
  return `${trimmed.slice(0, max - 1)}…`;
}
