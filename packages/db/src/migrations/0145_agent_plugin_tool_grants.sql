-- DUR-189: per-agent allow-list for plugin-registered tools (e.g. Media
-- Studio's generate-image), enforced in routes/plugins.ts's
-- POST /plugins/tools/execute. Empty array means unrestricted -- this
-- matches every agent's behavior before this column existed (there was no
-- per-agent or per-company scoping at all), so the default is not a
-- backward-compat break. A non-empty array narrows the agent to exactly
-- those namespaced tool names (e.g. "paperclip.media-studio:generate-image").

ALTER TABLE "agents"
  ADD COLUMN "plugin_tool_grants" jsonb NOT NULL DEFAULT '[]';
