import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

export const PLUGIN_ID = "paperclip.mission-control";
const PLUGIN_VERSION = "0.1.0";

export const ROUTE_PATH = "mission-control";
export const ACTION_LIST = "list-remotes";
export const ACTION_ADD = "add-remote";
export const ACTION_REMOVE = "remove-remote";
export const ACTION_PORTFOLIO = "get-portfolio";

/**
 * Mission Control — a portfolio view over multiple Paperclip instances. Register
 * remote instances (URL + board API key over Tailscale) and see each remote
 * company's live runs / needs-you / cost / health with deep links into the
 * remote UI. For ownership/billing/handoff of client companies on their own
 * servers (not for load).
 */
const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Mission Control",
  description:
    "Portfolio view across remote Paperclip instances: per-company live runs, needs-you, cost, and health with deep links.",
  author: "Durkan Agency (paperclip-fork)",
  categories: ["ui", "connector"],
  capabilities: [
    "http.outbound",
    "plugin.state.read",
    "plugin.state.write",
    "ui.sidebar.register",
    "ui.page.register",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui",
  },
  ui: {
    slots: [
      {
        type: "sidebar",
        id: "mission-control-sidebar",
        displayName: "Mission Control",
        exportName: "SidebarLink",
        order: 40,
      },
      {
        type: "page",
        id: "mission-control-page",
        displayName: "Mission Control",
        exportName: "MissionControlPage",
        routePath: ROUTE_PATH,
      },
    ],
  },
};

export default manifest;
