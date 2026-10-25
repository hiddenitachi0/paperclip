import type { AdapterModelProfileDefinition } from "@paperclipai/adapter-utils";

export const type = "claude_local";
export const label = "Claude Code";

export const SANDBOX_INSTALL_COMMAND = "npm install -g @anthropic-ai/claude-code";

// Current generation first (Oct 2026): Opus 5.5 / Sonnet 5.5 / Haiku 5.5 /
// Fable 5.1. Older ids stay listed so agents already saved on them keep a
// readable label in the picker.
export const models = [
  { id: "claude-opus-5-5", label: "Claude Opus 5.5" },
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5" },
  { id: "claude-haiku-5-5", label: "Claude Haiku 5.5" },
  { id: "claude-fable-5-1", label: "Claude Fable 5.1" },
  { id: "claude-opus-5", label: "Claude Opus 5" },
  { id: "claude-sonnet-5", label: "Claude Sonnet 5" },
  { id: "claude-fable-5", label: "Claude Fable 5" },
  { id: "claude-mythos-5", label: "Claude Mythos 5" },
  { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5" },
  { id: "claude-opus-4-8", label: "Claude Opus 4.8" },
  { id: "claude-opus-4-7", label: "Claude Opus 4.7" },
  { id: "claude-opus-4-6", label: "Claude Opus 4.6" },
  { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
  { id: "claude-haiku-4-6", label: "Claude Haiku 4.6" },
  { id: "claude-sonnet-4-5", label: "Claude Sonnet 4.5" },
];

export const modelProfiles: AdapterModelProfileDefinition[] = [
  {
    key: "cheap",
    label: "Cheap",
    description: "Use Claude Sonnet as the lower-cost Claude Code lane while preserving the agent's primary model.",
    adapterConfig: {
      model: "claude-sonnet-5-5",
      effort: "low",
    },
    source: "adapter_default",
  },
  {
    key: "planner",
    label: "Planner",
    description:
      "Use Claude Opus for the plan-writing run of a \"plan first on Opus, then build on Sonnet\" job, while preserving the agent's primary model for the build runs that follow.",
    adapterConfig: {
      model: "claude-opus-5-5",
      effort: "high",
    },
    source: "adapter_default",
  },
];

export const agentConfigurationDoc = `# claude_local agent configuration

Adapter: claude_local

Core fields:
- cwd (string, optional): default absolute working directory fallback for the agent process (created if missing when possible)
- instructionsFilePath (string, optional): absolute path to a markdown instructions file injected at runtime
- model (string, optional): Claude model id (current: claude-opus-5-5, claude-sonnet-5-5, claude-haiku-5-5, claude-fable-5-1). Leave empty only on purpose: empty means the Claude CLI picks its own default, which depends on the sign-in (on Max plans that is Opus, the costliest tier) and can change with CLI updates
- effort (string, optional): reasoning effort passed via --effort (low|medium|high|xhigh|max)
- chrome (boolean, optional): pass --chrome when running Claude
- promptTemplate (string, optional): run prompt template
- maxTurnsPerRun (number, optional): max turns for one run
- maxTokensPerRun (number, optional, default 0 = uncapped): kills the run (SIGTERM then SIGKILL) once cumulative input+output+cache tokens across all model calls in the run reach this total; the adapter reports partial usage/summary and errorCode "token_cap_exceeded" instead of a bare timeout (DUR-213)
- dangerouslySkipPermissions (boolean, optional, default true): allow non-interactive Claude runs to proceed without approval prompts. Local targets receive --dangerously-skip-permissions; remote targets receive a curated --allowedTools list so they do not inherit local bypass permissions.
- command (string, optional): defaults to "claude"
- extraArgs (string[], optional): additional CLI args
- env (object, optional): KEY=VALUE environment variables
- workspaceStrategy (object, optional): execution workspace strategy; currently supports { type: "git_worktree", baseRef?, branchTemplate?, worktreeParentDir? }
- workspaceRuntime (object, optional): reserved for workspace runtime metadata; workspace runtime services are manually controlled from the workspace UI and are not auto-started by heartbeats

Operational fields:
- timeoutSec (number, optional): run timeout in seconds
- graceSec (number, optional): SIGTERM grace period in seconds

Notes:
- When Paperclip realizes a workspace/runtime for a run, it injects PAPERCLIP_WORKSPACE_* and PAPERCLIP_RUNTIME_* env vars for agent-side tooling.
`;
