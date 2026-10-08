/**
 * Some models write a tool call as text instead of making it: small local
 * models, fine-tunes whose chat template lost the tools section, or a host
 * that passes tools through as plain prompt text. Seen 7 Oct with Maja:
 *
 *   {"name":"generate-image","parameters":{"prompt":"…","look":"…"}}
 *
 * came back as the whole reply, so no picture was made and the person saw
 * raw JSON. `parseLaneATextToolCall` turns such a reply into a real tool call
 * when -- and only when -- the WHOLE reply (optionally inside one ```json
 * fence) is a single JSON object naming a tool offered this turn. The call
 * then goes through exactly the same checks, caps and permissions as a
 * native one; nothing here widens what the model may do.
 *
 * Accepted shapes:
 *   {"name": "<tool>", "parameters" | "arguments" | "args" | "input": {...}}
 *   {"name": "<tool>", "arguments": "<JSON string of an object>"}
 *   {"type": "function", "function": {"name": "<tool>", "arguments": ...}}
 *
 * The name may be the full offered name or the part after the add-on prefix
 * ("generate-image" for "paperclip_media-studio__generate-image"), as long as
 * exactly one offered tool matches.
 */
import type { LaneAToolCall } from "./lane-a-providers.js";

/** Longest reply considered: a real call is short; a long text is an answer. */
const MAX_TEXT_CALL_LENGTH = 8000;

function stripFence(text: string): string {
  const trimmed = text.trim();
  const fence = trimmed.match(/^```(?:json|tool_call|tool)?\s*\n?([\s\S]*?)\n?```$/i);
  if (fence) return fence[1]!.trim();
  // Some templates wrap the call in <tool_call>…</tool_call>.
  const tag = trimmed.match(/^<tool_call>\s*([\s\S]*?)\s*<\/tool_call>$/i);
  if (tag) return tag[1]!.trim();
  return trimmed;
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      return null;
    }
  }
  return null;
}

function resolveToolName(name: string, offered: readonly string[]): string | null {
  if (offered.includes(name)) return name;
  const matches = offered.filter((candidate) => candidate.endsWith(`__${name}`) || candidate.endsWith(`.${name}`));
  return matches.length === 1 ? matches[0]! : null;
}

export function parseLaneATextToolCall(text: string, offeredToolNames: readonly string[], id: string): LaneAToolCall | null {
  if (!text || text.length > MAX_TEXT_CALL_LENGTH || offeredToolNames.length === 0) return null;
  const body = stripFence(text);
  if (!body.startsWith("{") || !body.endsWith("}")) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  let call = asObject(parsed);
  if (!call) return null;
  if (call.type === "function" && asObject(call.function)) call = asObject(call.function)!;
  if (typeof call.name !== "string" || !call.name.trim()) return null;
  const name = resolveToolName(call.name.trim(), offeredToolNames);
  if (!name) return null;
  const rawInput = call.parameters ?? call.arguments ?? call.args ?? call.input ?? {};
  const input = asObject(rawInput);
  if (!input) return null;
  return { id, name, input };
}
