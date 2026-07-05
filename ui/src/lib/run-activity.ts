import type { TranscriptEntry } from "../adapters";

// Turn a live run transcript into a one-line "what is the agent doing right now"
// glimpse. The ephemeral run status is often just "Receiving agent output"; the
// transcript's last meaningful entry (the tool it's using or the last thing it
// said) is far more informative, so the Now view can show real activity.

function basename(p: unknown): string {
  if (typeof p !== "string") return "";
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

function firstLine(s: unknown, max = 72): string {
  if (typeof s !== "string") return "";
  const line = s.replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function describeToolCall(name: string, input: unknown): string {
  const args = (input ?? {}) as Record<string, unknown>;
  switch (name) {
    case "Bash":
      return `Running \`${firstLine(args.command)}\``;
    case "Read":
      return `Reading ${basename(args.file_path) || "a file"}`;
    case "Edit":
    case "MultiEdit":
      return `Editing ${basename(args.file_path) || "a file"}`;
    case "Write":
      return `Writing ${basename(args.file_path) || "a file"}`;
    case "Grep":
      return `Searching for "${firstLine(args.pattern, 40)}"`;
    case "Glob":
      return `Finding ${firstLine(args.pattern, 40)}`;
    case "Task":
    case "Agent":
      return "Delegating to a subagent";
    case "WebFetch":
      return `Fetching ${firstLine(args.url, 48)}`;
    case "WebSearch":
      return `Searching the web: "${firstLine(args.query, 40)}"`;
    case "Skill":
      return `Running skill ${firstLine(args.skill ?? args.name, 32)}`;
    case "TaskCreate":
      return "Creating a task";
    case "TaskUpdate":
      return "Updating a task";
    default:
      return name ? `Using ${name}` : "Working";
  }
}

/**
 * A short present-tense description of the run's most recent action, or null if
 * the transcript has nothing meaningful yet.
 */
export function describeRunActivity(entries: readonly TranscriptEntry[] | undefined): string | null {
  if (!entries || entries.length === 0) return null;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    switch (e.kind) {
      case "tool_call":
        return describeToolCall(e.name, e.input);
      case "assistant": {
        const text = firstLine(e.text, 90);
        if (text) return text;
        break;
      }
      case "thinking":
        return "Thinking…";
      case "result":
        // A result entry means the turn ended; keep scanning for the last
        // action rather than reporting the raw result text.
        break;
      default:
        break;
    }
  }
  return null;
}
