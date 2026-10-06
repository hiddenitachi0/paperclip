// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/client";
import { HuggingFaceConnectDialog } from "./HuggingFaceConnectDialog";

/** DUR-4448: good token saves, refused token (422) and Hugging Face down (503) show plain errors. */

const COMPANY = "11111111-1111-4111-8111-111111111111";
const TOKEN = "hf_" + "abcdefghijklmnopqrstuvwxyz0123";
const mockSecretsApi = vi.hoisted(() => ({ create: vi.fn(), rotate: vi.fn() }));
const mockPushToast = vi.hoisted(() => vi.fn());

vi.mock("../api/secrets", () => ({ secretsApi: mockSecretsApi }));
vi.mock("../context/ToastContext", () => ({ useToastActions: () => ({ pushToast: mockPushToast }) }));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const onOpenChange = vi.fn();

async function flush() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

async function mount(existing: Parameters<typeof HuggingFaceConnectDialog>[0]["existing"] = null) {
  await act(async () => {
    root.render(
      <QueryClientProvider client={new QueryClient()}>
        <HuggingFaceConnectDialog open onOpenChange={onOpenChange} companyId={COMPANY} existing={existing} />
      </QueryClientProvider>,
    );
  });
}

async function typeToken(value: string) {
  const input = document.querySelector<HTMLInputElement>("#hf-token")!;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function save() {
  const button = [...document.querySelectorAll("button")].find((b) => b.textContent?.includes("Check and save"))!;
  await act(async () => button.click());
  await flush();
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  vi.clearAllMocks();
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
});

describe("HuggingFaceConnectDialog", () => {
  it("saves a good token as a Hugging Face secret and says it is connected", async () => {
    mockSecretsApi.create.mockResolvedValue({ id: "s1" });
    await mount();
    expect(document.querySelector('[data-testid="hf-guide"]')?.textContent).toContain("Inference Providers");
    expect(document.querySelector<HTMLInputElement>("#hf-token")!.type).toBe("password");
    await typeToken(TOKEN);
    await save();
    expect(mockSecretsApi.create).toHaveBeenCalledWith(
      COMPANY,
      expect.objectContaining({ kind: "huggingface_api_key", value: TOKEN }),
    );
    expect(mockPushToast).toHaveBeenCalledWith({ tone: "success", title: "Hugging Face is connected" });
    expect(JSON.stringify(mockPushToast.mock.calls)).not.toContain(TOKEN);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("replaces the existing token instead of adding a second one", async () => {
    mockSecretsApi.rotate.mockResolvedValue({ id: "s1" });
    await mount({ id: "s1" } as never);
    await typeToken(TOKEN);
    await save();
    expect(mockSecretsApi.rotate).toHaveBeenCalledWith("s1", { value: TOKEN });
    expect(mockSecretsApi.create).not.toHaveBeenCalled();
  });

  it("shows the refusal and stays open when the token is rejected (422)", async () => {
    mockSecretsApi.create.mockRejectedValue(new ApiError("Hugging Face did not accept that token.", 422, null));
    await mount();
    await typeToken("hf_wrong");
    await save();
    expect(document.querySelector('[data-testid="hf-error"]')?.textContent).toContain("did not accept");
    expect(mockPushToast).not.toHaveBeenCalled();
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("says to try again when Hugging Face cannot be reached (503)", async () => {
    mockSecretsApi.create.mockRejectedValue(new ApiError("down", 503, null));
    await mount();
    await typeToken(TOKEN);
    await save();
    const text = document.querySelector('[data-testid="hf-error"]')?.textContent ?? "";
    expect(text).toContain("Could not reach Hugging Face");
    expect(text).not.toContain("did not accept");
    expect(mockPushToast).not.toHaveBeenCalled();
  });
});
