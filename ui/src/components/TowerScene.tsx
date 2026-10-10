import { memo, type KeyboardEvent, type ReactNode } from "react";
import type { TowerFloorLayout, TowerPerson, TowerRect } from "../lib/tower-layout";
import { towerNameplate } from "../lib/tower-layout";

/**
 * Paperclip Tower — one company's floor drawn as an 8/16-bit isometric office in
 * plain SVG. Pure presentation: the layout (who sits where) comes from
 * buildTowerFloor; this file only draws it.
 *
 * Theme: every surface colour is a CSS variable set in TOWER_SCENE_CSS, with a
 * light ("daytime") and a dark ("night shift") set. Sprite colours are fixed.
 */

export interface TowerSceneAgent {
  id: string;
  name: string;
  role: string;
  status: string;
}

const TW = 34;
const TH = 17;
/** People and desks are drawn a bit larger than one grid tile so they read at a glance. */
const SPRITE_SCALE = 1.6;
const PLATE_SCALE = 1.35;
const DESK_SCALE = 1.4;

function iso(x: number, y: number): { x: number; y: number } {
  return { x: (x - y) * (TW / 2), y: (x + y) * (TH / 2) };
}

function pts(list: Array<{ x: number; y: number }>): string {
  return list.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
}

function floorPoly(r: TowerRect): string {
  return pts([iso(r.x0, r.y0), iso(r.x1, r.y0), iso(r.x1, r.y1), iso(r.x0, r.y1)]);
}

/** A vertical quad standing on the floor line A→B, between heights h0..h1. */
function wallQuad(ax: number, ay: number, bx: number, by: number, h0: number, h1: number, t0 = 0, t1 = 1): string {
  const A = iso(ax + (bx - ax) * t0, ay + (by - ay) * t0);
  const B = iso(ax + (bx - ax) * t1, ay + (by - ay) * t1);
  return pts([
    { x: A.x, y: A.y - h0 },
    { x: B.x, y: B.y - h0 },
    { x: B.x, y: B.y - h1 },
    { x: A.x, y: A.y - h1 },
  ]);
}

const v = (name: string) => `var(--tw-${name})`;

/** Back-left and back-right walls of a rectangle, with a cap strip. */
function BackWalls({ r, h, left, right, cap }: { r: TowerRect; h: number; left: string; right: string; cap: string }) {
  return (
    <g>
      <polygon points={wallQuad(r.x0, r.y1, r.x0, r.y0, 0, h)} style={{ fill: v(left) }} />
      <polygon points={wallQuad(r.x0, r.y0, r.x1, r.y0, 0, h)} style={{ fill: v(right) }} />
      <polygon points={wallQuad(r.x0, r.y1, r.x0, r.y0, h, h + 2.5)} style={{ fill: v(cap) }} />
      <polygon points={wallQuad(r.x0, r.y0, r.x1, r.y0, h, h + 2.5)} style={{ fill: v(cap) }} />
      <polygon points={wallQuad(r.x0, r.y1, r.x0, r.y0, 0, 2.5)} style={{ fill: v("skirting") }} />
      <polygon points={wallQuad(r.x0, r.y0, r.x1, r.y0, 0, 2.5)} style={{ fill: v("skirting") }} />
    </g>
  );
}

/** Wooden planks: the floor polygon plus thin seams running along x. */
function WoodFloor({ r, tone }: { r: TowerRect; tone: "a" | "b" | "c" }) {
  const seams: ReactNode[] = [];
  for (let y = Math.ceil(r.y0 + 0.01); y < r.y1; y += 1) {
    const a = iso(r.x0, y);
    const b = iso(r.x1, y);
    seams.push(<line key={y} x1={a.x} y1={a.y} x2={b.x} y2={b.y} style={{ stroke: v("plank-seam") }} strokeWidth={0.6} />);
  }
  return (
    <g>
      <polygon points={floorPoly(r)} style={{ fill: v(`wood-${tone}`) }} />
      {seams}
    </g>
  );
}

const ROLE_SHIRT: Record<string, string> = {
  ceo: "#e8b23a",
  cto: "#c67fd6",
  cmo: "#e0679a",
  cfo: "#49c2b0",
  security: "#df7a45",
  engineer: "#5ecb73",
  designer: "#f08a5d",
  pm: "#5aa0e0",
  qa: "#9fbf4a",
  devops: "#6fb3c9",
  researcher: "#b58ad6",
  general: "#8593d6",
};
const HAIR = ["#3a2a1a", "#6b4a2a", "#171717", "#7a5a3a", "#a68a5a", "#8a3a2a"];

export const TOWER_STATUS_COLOR: Record<string, string> = {
  working: "#4cc265",
  idle: "#e6b048",
  paused: "#8a8f9e",
  error: "#e2604a",
  pending_approval: "#5aa0e0",
};

/** Plain-English state used by the scene, the legend and the side panel. */
export function towerAgentState(status: string, working: boolean): keyof typeof TOWER_STATUS_COLOR {
  if (working) return "working";
  if (status === "paused") return "paused";
  if (status === "error") return "error";
  if (status === "pending_approval") return "pending_approval";
  return "idle";
}

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function Desk({ x, y, occupied, accent }: { x: number; y: number; occupied: boolean; accent: string }) {
  const at = iso(x, y);
  return (
    <g transform={`translate(${at.x.toFixed(1)} ${at.y.toFixed(1)}) scale(${DESK_SCALE})`}>
      <DeskShape occupied={occupied} accent={accent} />
    </g>
  );
}

function DeskShape({ occupied, accent }: { occupied: boolean; accent: string }) {
  const p = { x: 0, y: 0 };
  const w = TW * 0.42;
  const d = TH * 0.42;
  const top = pts([
    { x: p.x, y: p.y - d },
    { x: p.x + w, y: p.y },
    { x: p.x, y: p.y + d },
    { x: p.x - w, y: p.y },
  ]);
  const left = pts([
    { x: p.x - w, y: p.y },
    { x: p.x, y: p.y + d },
    { x: p.x, y: p.y + d + 5 },
    { x: p.x - w, y: p.y + 5 },
  ]);
  const right = pts([
    { x: p.x, y: p.y + d },
    { x: p.x + w, y: p.y },
    { x: p.x + w, y: p.y + 5 },
    { x: p.x, y: p.y + d + 5 },
  ]);
  return (
    <g>
      <polygon points={left} fill="#7a5127" />
      <polygon points={right} fill="#663f1c" />
      <polygon points={top} fill="#a4703a" />
      {/* monitor */}
      <rect x={p.x - 6} y={p.y - d - 9} width={12} height={9} fill="#20293c" />
      <rect x={p.x - 5} y={p.y - d - 8} width={10} height={7} fill={occupied ? accent : "#12203a"} opacity={occupied ? 0.85 : 1} />
      {occupied ? <rect x={p.x - 3.5} y={p.y - d - 6} width={6} height={1.2} fill="#ffffffaa" /> : null}
      <rect x={p.x - 1} y={p.y - d - 1} width={2} height={2} fill="#20293c" />
    </g>
  );
}

function Sprite({ agent, state, seated }: { agent: TowerSceneAgent; state: string; seated: boolean }) {
  const shirt = ROLE_SHIRT[agent.role] ?? ROLE_SHIRT.general!;
  const hair = HAIR[hash(agent.name) % HAIR.length]!;
  const dim = state === "paused";
  const lamp = TOWER_STATUS_COLOR[state] ?? TOWER_STATUS_COLOR.idle!;
  const isBoss = agent.role === "ceo" || agent.role === "cto" || agent.role === "cfo" || agent.role === "cmo";
  return (
    <g opacity={dim ? 0.6 : 1}>
      <ellipse cx={0} cy={2} rx={8} ry={3.2} fill="#000" opacity={0.2} />
      {seated ? <rect x={-5} y={-7} width={10} height={3} fill="#3a445e" /> : null}
      <rect x={-3} y={-5} width={2} height={5} fill="#25324a" />
      <rect x={1} y={-5} width={2} height={5} fill="#25324a" />
      <rect x={-4} y={-13} width={8} height={8} fill={shirt} />
      <rect x={-4} y={-13} width={3} height={8} fill="#ffffff" opacity={0.14} />
      <rect x={2} y={-13} width={2} height={8} fill="#000" opacity={0.14} />
      <rect x={-5.5} y={-12} width={1.5} height={6} fill="#e6c39a" />
      <rect x={4} y={-12} width={1.5} height={6} fill="#e6c39a" />
      {isBoss ? <rect x={-0.75} y={-13} width={1.5} height={6} fill={agent.role === "ceo" ? "#c92f2f" : "#2f3f66"} /> : null}
      <rect x={-3.5} y={-19} width={7} height={6} fill="#e6c39a" />
      <rect x={-2.5} y={-17} width={1} height={1} fill="#3a2a20" />
      <rect x={1.5} y={-17} width={1} height={1} fill="#3a2a20" />
      <rect x={-3.5} y={-20} width={7} height={2.5} fill={hair} />
      {agent.role === "engineer" ? <rect x={-2.5} y={-17.5} width={5} height={1} fill="#1a2740" opacity={0.8} /> : null}
      <rect x={-1} y={-24} width={2} height={2} fill={lamp} />
    </g>
  );
}

function Nameplate({ text, state, y }: { text: string; state: string; y: number }) {
  const fontSize = 6.5;
  const width = text.length * fontSize * 0.78 + 8;
  return (
    <g transform={`translate(0 ${y})`}>
      <rect x={-width / 2} y={0} width={width} height={9} rx={1} style={{ fill: v("plate-bg") }} />
      <rect x={-width / 2} y={0} width={2} height={9} fill={TOWER_STATUS_COLOR[state] ?? TOWER_STATUS_COLOR.idle} />
      <text
        x={1}
        y={6.6}
        textAnchor="middle"
        fontSize={fontSize}
        style={{ fill: v("plate-fg"), fontFamily: "Silkscreen, 'Courier New', monospace" }}
      >
        {text}
      </text>
    </g>
  );
}

function onActivate(handler: () => void) {
  return (e: KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      handler();
    }
  };
}

export interface TowerSceneProps {
  layout: TowerFloorLayout;
  agents: ReadonlyMap<string, TowerSceneAgent>;
  workingIds: ReadonlySet<string>;
  selectedAgentId: string | null;
  accent: string;
  onSelectAgent: (agentId: string) => void;
  onKiosk: () => void;
}

function TowerSceneImpl({ layout, agents, workingIds, selectedAgentId, accent, onSelectAgent, onKiosk }: TowerSceneProps) {
  const { building, rooms, offices, desks, people, breakRoom, bounds } = layout;

  const corners = [iso(bounds.x0, bounds.y0), iso(bounds.x1, bounds.y0), iso(bounds.x1, bounds.y1), iso(bounds.x0, bounds.y1)];
  const minX = Math.min(...corners.map((c) => c.x)) - 24;
  const maxX = Math.max(...corners.map((c) => c.x)) + 24;
  const minY = Math.min(...corners.map((c) => c.y)) - 56;
  const maxY = Math.max(...corners.map((c) => c.y)) + 28;

  const SHELL_H = 34;
  const roomsSorted = [...rooms].sort((a, b) => a.depth - b.depth || a.x0 + a.y0 - (b.x0 + b.y0));
  const desksSorted = [...desks].sort((a, b) => a.x + a.y - (b.x + b.y));
  const peopleSorted = [...people].sort((a, b) => a.x + a.y - (b.x + b.y) || a.x - b.x);

  // Windows along the building's two back walls.
  const windows: ReactNode[] = [];
  const backLen = building.x1 - building.x0;
  const sideLen = building.y1 - building.y0;
  const nBack = Math.max(2, Math.floor(backLen / 3.2));
  const nSide = Math.max(1, Math.floor(sideLen / 3.4));
  for (let i = 0; i < nBack; i++) {
    const t0 = (i + 0.3) / nBack;
    const t1 = (i + 0.7) / nBack;
    windows.push(
      <polygon
        key={`wb${i}`}
        points={wallQuad(building.x0, building.y0, building.x1, building.y0, 12, 27, t0, t1)}
        style={{ fill: v("window"), stroke: v("window-frame") }}
        strokeWidth={1}
      />,
    );
  }
  for (let i = 0; i < nSide; i++) {
    const t0 = (i + 0.3) / nSide;
    const t1 = (i + 0.7) / nSide;
    windows.push(
      <polygon
        key={`ws${i}`}
        points={wallQuad(building.x0, building.y1, building.x0, building.y0, 12, 27, t0, t1)}
        style={{ fill: v("window-side"), stroke: v("window-frame") }}
        strokeWidth={1}
      />,
    );
  }

  const kiosk = iso(breakRoom.kiosk.x, breakRoom.kiosk.y);
  const table = iso(breakRoom.table.x, breakRoom.table.y);
  const plant = iso(breakRoom.x1 - 0.6, breakRoom.y0 + 0.6);
  const coffee = iso(breakRoom.x0 + 0.5, breakRoom.y1 - 1.2);

  return (
    <svg
      viewBox={`${minX} ${minY} ${maxX - minX} ${maxY - minY}`}
      preserveAspectRatio="xMidYMid meet"
      className="tower-scene-svg h-full w-full"
      role="img"
      aria-label="Office floor"
      shapeRendering="crispEdges"
    >
      {/* Building shell */}
      <WoodFloor r={building} tone="a" />
      <BackWalls r={building} h={SHELL_H} left="shell-left" right="shell-right" cap="shell-cap" />
      {windows}

      {/* Department rooms — nested by the reporting tree */}
      {roomsSorted.map((r) => (
        <g key={`room-${r.managerId}`} data-room={r.managerId} data-depth={r.depth}>
          <WoodFloor r={r} tone={r.depth % 2 === 0 ? "b" : "c"} />
          <BackWalls r={r} h={r.depth === 0 ? 14 : 9} left="wall-left" right="wall-right" cap="wall-cap" />
        </g>
      ))}

      {/* Managers' private offices */}
      {offices.map((o) => (
        <g key={`office-${o.managerId}`} data-office={o.managerId}>
          <polygon points={floorPoly(o)} style={{ fill: v("office-floor") }} />
          <BackWalls r={o} h={11} left="office-left" right="office-right" cap="wall-cap" />
          <polygon points={wallQuad(o.x0, o.y0, o.x1, o.y0, 4, 9, 0.3, 0.7)} style={{ fill: v("window") }} opacity={0.75} />
        </g>
      ))}

      {/* Break room */}
      <g data-break-room="">
        <polygon points={floorPoly(breakRoom)} style={{ fill: v("break-floor") }} />
        <BackWalls r={breakRoom} h={16} left="break-left" right="break-right" cap="break-cap" />
        {/* table */}
        <ellipse cx={table.x} cy={table.y + 3} rx={13} ry={5} fill="#000" opacity={0.18} />
        <ellipse cx={table.x} cy={table.y} rx={12} ry={6} fill="#7a4f2e" />
        <ellipse cx={table.x} cy={table.y - 2} rx={12} ry={5.5} fill="#9a6740" />
        {/* plant */}
        <rect x={plant.x - 2.5} y={plant.y - 4} width={5} height={4} fill="#7a4f2e" />
        <rect x={plant.x - 4.5} y={plant.y - 11} width={9} height={7} fill="#3f9d55" />
        <rect x={plant.x - 2.5} y={plant.y - 15} width={5} height={5} fill="#57b566" />
        {/* coffee machine */}
        <rect x={coffee.x - 5} y={coffee.y - 16} width={10} height={16} fill="#4a5168" />
        <rect x={coffee.x - 3.5} y={coffee.y - 14} width={7} height={4} fill="#e6b048" opacity={0.85} />
        <rect x={coffee.x - 2} y={coffee.y - 6} width={4} height={3} fill="#f5f0e3" />
        {/* 🌙 wind-down kiosk */}
        <g
          role="button"
          tabIndex={0}
          aria-label="Wind-down kiosk"
          data-testid="tower-kiosk"
          className="tower-clickable"
          onClick={onKiosk}
          onKeyDown={onActivate(onKiosk)}
        >
          <rect x={kiosk.x - 7} y={kiosk.y - 20} width={14} height={20} fill="#26314a" />
          <rect x={kiosk.x - 5} y={kiosk.y - 18} width={10} height={8} fill="#e6b048" className="tower-glow" />
          <text
            x={kiosk.x}
            y={kiosk.y - 12.2}
            textAnchor="middle"
            fontSize={4.4}
            fill="#101625"
            style={{ fontFamily: "Silkscreen, 'Courier New', monospace" }}
          >
            WIND
          </text>
          <rect x={kiosk.x - 7} y={kiosk.y - 2} width={14} height={3} fill="#151d2e" />
          <text x={kiosk.x} y={kiosk.y - 23} textAnchor="middle" fontSize={8}>
            🌙
          </text>
        </g>
      </g>

      {/* Desks stay where the org puts them; empty when their owner is on a break */}
      {desksSorted.map((d) => (
        <Desk key={`desk-${d.agentId}`} x={d.x} y={d.y - 0.7} occupied={d.occupied} accent={accent} />
      ))}

      {/* People */}
      {peopleSorted.map((p: TowerPerson) => {
        const agent = agents.get(p.agentId);
        if (!agent) return null;
        const working = workingIds.has(p.agentId);
        const state = towerAgentState(agent.status, working);
        const at = iso(p.x, p.y);
        const selected = selectedAgentId === p.agentId;
        const select = () => onSelectAgent(p.agentId);
        return (
          <g
            key={`p-${p.agentId}`}
            transform={`translate(${at.x.toFixed(1)} ${at.y.toFixed(1)})`}
            role="button"
            tabIndex={0}
            aria-label={`${agent.name}: ${state === "working" ? "working at desk" : "in the break room"}`}
            data-testid={`tower-agent-${p.agentId}`}
            data-place={p.place}
            className="tower-clickable"
            onClick={select}
            onKeyDown={onActivate(select)}
          >
            <title>{agent.name}</title>
            {working ? <ellipse cx={0} cy={3} rx={22} ry={10} fill={accent} className="tower-pulse" /> : null}
            {selected ? (
              <rect x={-17} y={-41} width={34} height={60} fill="none" stroke={accent} strokeWidth={1.5} strokeDasharray="3 2" />
            ) : null}
            <g transform={`scale(${SPRITE_SCALE})`}>
              <g className={working ? "tower-bob" : undefined}>
                <Sprite agent={agent} state={state} seated={p.place === "desk"} />
              </g>
            </g>
            <g transform={`scale(${PLATE_SCALE})`}>
              <Nameplate text={towerNameplate(agent.name)} state={state} y={4} />
            </g>
          </g>
        );
      })}
    </svg>
  );
}

export const TowerScene = memo(TowerSceneImpl);

/** Scene palette. Light = daytime office; dark = night shift. */
export const TOWER_SCENE_CSS = `
.tower-scene {
  --tw-sky-top: #cfe4f5; --tw-sky-bottom: #f3ead9;
  --tw-wood-a: #b98c52; --tw-wood-b: #c69a5e; --tw-wood-c: #b48650; --tw-plank-seam: rgba(90,60,25,.28);
  --tw-shell-left: #d7cdb6; --tw-shell-right: #eae1cb; --tw-shell-cap: #c4b99d; --tw-skirting: #8a6a3c;
  --tw-wall-left: #cfc5ac; --tw-wall-right: #e1d8bf; --tw-wall-cap: #b6ab8e;
  --tw-office-floor: #a77a45; --tw-office-left: #c9bea3; --tw-office-right: #dcd2b8;
  --tw-break-floor: #9fb0c2; --tw-break-left: #c8b7c4; --tw-break-right: #d6c6d2; --tw-break-cap: #b3a2b0;
  --tw-window: #8fd0ef; --tw-window-side: #83c7e8; --tw-window-frame: #f4efe2;
  --tw-plate-bg: rgba(20,24,38,.86); --tw-plate-fg: #f2eee4;
}
.dark .tower-scene {
  --tw-sky-top: #121a2e; --tw-sky-bottom: #0b1020;
  --tw-wood-a: #9c7442; --tw-wood-b: #a97d48; --tw-wood-c: #96703f; --tw-plank-seam: rgba(40,25,10,.35);
  --tw-shell-left: #8f8775; --tw-shell-right: #a39a86; --tw-shell-cap: #7d7562; --tw-skirting: #5d4728;
  --tw-wall-left: #8c8471; --tw-wall-right: #9d9480; --tw-wall-cap: #756d5b;
  --tw-office-floor: #8a6439; --tw-office-left: #847c69; --tw-office-right: #958c78;
  --tw-break-floor: #5d6a7c; --tw-break-left: #7a6d79; --tw-break-right: #8a7d89; --tw-break-cap: #6a5e69;
  --tw-window: #f2c76b; --tw-window-side: #e3b75c; --tw-window-frame: #b9ae96;
  --tw-plate-bg: rgba(10,13,24,.9); --tw-plate-fg: #f2eee4;
}
.tower-scene { background: linear-gradient(180deg, var(--tw-sky-top), var(--tw-sky-bottom)); }
.tower-scene .tower-clickable { cursor: pointer; outline: none; }
.tower-scene .tower-clickable:focus-visible rect:first-of-type { stroke: currentColor; }
.tower-scene .tower-pulse { opacity: .35; animation: tower-pulse 1.6s ease-in-out infinite; }
.tower-scene .tower-bob { animation: tower-bob 1.2s steps(2, end) infinite; }
.tower-scene .tower-glow { animation: tower-pulse 2.4s ease-in-out infinite; }
@keyframes tower-pulse { 0%,100% { opacity: .25 } 50% { opacity: .6 } }
@keyframes tower-bob { 0%,100% { transform: translateY(0) } 50% { transform: translateY(-1px) } }
@media (prefers-reduced-motion: reduce) {
  .tower-scene .tower-pulse, .tower-scene .tower-bob, .tower-scene .tower-glow { animation: none; }
}
`;
