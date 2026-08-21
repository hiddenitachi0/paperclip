import { useEffect, useState } from "react";
import type { AdapterConfigFieldsProps } from "./types";
import { Field, help } from "../components/agent-config-primitives";

const inputClass =
  "w-full rounded-md border border-border px-2.5 py-1.5 bg-transparent outline-none text-sm font-mono placeholder:text-muted-foreground/40";

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function formatJsonArray(value: unknown): string {
  const array = asArray(value);
  return array.length > 0 ? JSON.stringify(array, null, 2) : "";
}

function updateMcpServersJson(
  isCreate: boolean,
  next: string,
  set: AdapterConfigFieldsProps["set"],
  mark: AdapterConfigFieldsProps["mark"],
) {
  if (isCreate) {
    set?.({ mcpServersJson: next });
    return;
  }

  const trimmed = next.trim();
  if (!trimmed) {
    mark("adapterConfig", "mcpServers", undefined);
    return;
  }

  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) {
      mark("adapterConfig", "mcpServers", parsed);
    }
  } catch {
    // Keep local draft until JSON is valid.
  }
}

type McpServersJsonFieldProps = Pick<AdapterConfigFieldsProps, "isCreate" | "values" | "set" | "config" | "mark">;

const MCP_SERVERS_PLACEHOLDER = `[\n  {\n    "name": "fs",\n    "command": "npx",\n    "args": ["-y", "@modelcontextprotocol/server-filesystem"]\n  },\n  {\n    "name": "higgsfield",\n    "url": "https://mcp.higgsfield.ai",\n    "headers": { "Authorization": "Bearer ..." }\n  }\n]`;

export function McpServersJsonField({ isCreate, values, set, config, mark }: McpServersJsonFieldProps) {
  const existing = formatJsonArray(config.mcpServers);
  const [draft, setDraft] = useState(existing);

  useEffect(() => {
    if (!isCreate) setDraft(existing);
  }, [existing, isCreate]);

  const value = isCreate ? values?.mcpServersJson ?? "" : draft;

  return (
    <Field label="MCP servers JSON" hint={help.mcpServers}>
      <textarea
        className={`${inputClass} min-h-[148px]`}
        value={value}
        onChange={(e) => {
          const next = e.target.value;
          if (!isCreate) setDraft(next);
          updateMcpServersJson(isCreate, next, set, mark);
        }}
        placeholder={MCP_SERVERS_PLACEHOLDER}
      />
    </Field>
  );
}
