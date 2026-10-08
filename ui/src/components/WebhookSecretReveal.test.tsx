// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { WebhookSecretReveal } from "./WebhookSecretReveal";

describe("WebhookSecretReveal", () => {
  it("shows the show-once warning and copies the password", () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const onCopy = vi.fn();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    act(() => {
      root.render(
        <WebhookSecretReveal
          title="Webhook created"
          entries={[{ webhookUrl: "https://x/hook", webhookSecret: "s3cret" }]}
          onCopy={onCopy}
        />,
      );
    });
    expect(container.textContent).toContain("You won't see it again — paste it into the other system now.");
    const buttons = Array.from(container.querySelectorAll("button"));
    expect(buttons).toHaveLength(2);
    act(() => buttons[1].click());
    expect(onCopy).toHaveBeenCalledWith("Password", "s3cret");
    act(() => root.unmount());
  });
});
