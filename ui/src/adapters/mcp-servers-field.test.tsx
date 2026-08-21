// @vitest-environment jsdom

import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { McpServersJsonField } from "./mcp-servers-field";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void> = undefined;
  flushSync(() => {
    result = callback();
  });
  await result;
}

function setTextareaValue(el: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  setter?.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("McpServersJsonField", () => {
  let roots: Root[] = [];

  afterEach(async () => {
    for (const root of roots) {
      await act(async () => root.unmount());
    }
    roots = [];
    document.body.innerHTML = "";
  });

  async function render(props: Parameters<typeof McpServersJsonField>[0]) {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => {
      root.render(
        <TooltipProvider>
          <McpServersJsonField {...props} />
        </TooltipProvider>,
      );
    });
    return container;
  }

  it("edit mode: pre-fills the textarea with the agent's existing mcpServers, formatted", async () => {
    const container = await render({
      isCreate: false,
      values: null,
      set: null,
      config: { mcpServers: [{ name: "fs", command: "npx" }] },
      mark: vi.fn(),
    });

    const textarea = container.querySelector("textarea");
    expect(textarea?.value).toBe(JSON.stringify([{ name: "fs", command: "npx" }], null, 2));
  });

  it("edit mode: empty when the agent has no mcpServers configured", async () => {
    const container = await render({
      isCreate: false,
      values: null,
      set: null,
      config: {},
      mark: vi.fn(),
    });

    expect(container.querySelector("textarea")?.value).toBe("");
  });

  it("edit mode: marks adapterConfig.mcpServers dirty with the parsed array on valid JSON", async () => {
    const mark = vi.fn();
    const container = await render({ isCreate: false, values: null, set: null, config: {}, mark });

    const textarea = container.querySelector("textarea")!;
    await act(async () => {
      setTextareaValue(textarea, JSON.stringify([{ name: "fs", command: "npx" }]));
    });

    expect(mark).toHaveBeenCalledWith("adapterConfig", "mcpServers", [{ name: "fs", command: "npx" }]);
  });

  it("edit mode: does not mark dirty while the JSON is invalid (keeps the draft)", async () => {
    const mark = vi.fn();
    const container = await render({ isCreate: false, values: null, set: null, config: {}, mark });

    const textarea = container.querySelector("textarea")!;
    await act(async () => {
      setTextareaValue(textarea, "[{ not valid json");
    });

    expect(mark).not.toHaveBeenCalled();
    expect(textarea.value).toBe("[{ not valid json");
  });

  it("edit mode: marks the field undefined (cleared) when the textarea is emptied", async () => {
    const mark = vi.fn();
    const container = await render({
      isCreate: false,
      values: null,
      set: null,
      config: { mcpServers: [{ name: "fs", command: "npx" }] },
      mark,
    });

    const textarea = container.querySelector("textarea")!;
    await act(async () => {
      setTextareaValue(textarea, "");
    });

    expect(mark).toHaveBeenCalledWith("adapterConfig", "mcpServers", undefined);
  });

  it("edit mode: rejects a JSON object (must be an array)", async () => {
    const mark = vi.fn();
    const container = await render({ isCreate: false, values: null, set: null, config: {}, mark });

    const textarea = container.querySelector("textarea")!;
    await act(async () => {
      setTextareaValue(textarea, JSON.stringify({ name: "fs", command: "npx" }));
    });

    expect(mark).not.toHaveBeenCalled();
  });

  it("create mode: reads from values.mcpServersJson and writes back via set()", async () => {
    const set = vi.fn();
    const container = await render({
      isCreate: true,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      values: { mcpServersJson: "[]" } as any,
      set,
      config: {},
      mark: vi.fn(),
    });

    const textarea = container.querySelector("textarea")!;
    expect(textarea.value).toBe("[]");

    await act(async () => {
      setTextareaValue(textarea, JSON.stringify([{ name: "fs", command: "npx" }]));
    });

    expect(set).toHaveBeenCalledWith({ mcpServersJson: JSON.stringify([{ name: "fs", command: "npx" }]) });
  });
});
