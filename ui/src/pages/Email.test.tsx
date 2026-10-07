// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MailAccountSummary, MailMessageSummary } from "../types/mail";
import { Email } from "./Email";

/**
 * The Email page (DUR-4195):
 *   - off by default: a plain explanation, with a turn-on button for an
 *     owner/admin and an ask-an-owner message for anyone else;
 *   - once on with no mailbox connected yet, a connect-your-mailbox form;
 *   - once a mailbox exists, an inbox list + reader, with Reply and Compose
 *     flows that only ever create/update a draft the human then sends --
 *     Send is a separate explicit action, never implicit.
 */

const COMPANY = "11111111-1111-4111-8111-111111111111";
const ACCOUNT = "22222222-2222-4222-8222-222222222222";
const MESSAGE = "33333333-3333-4333-8333-333333333333";
const USER = "44444444-4444-4444-8444-444444444444";

const mockEmailSettingsApi = vi.hoisted(() => ({ getSettings: vi.fn(), setEnabled: vi.fn() }));
const mockMailApi = vi.hoisted(() => ({
  listAccounts: vi.fn(),
  createAccount: vi.fn(),
  listMessages: vi.fn(),
  searchMessages: vi.fn(),
  archiveMessage: vi.fn(),
  moveMessage: vi.fn(),
  createDraft: vi.fn(),
  setUrgencyFeedback: vi.fn(),
  updateDraft: vi.fn(),
  sendDraft: vi.fn(),
}));
const mockSecretsApi = vi.hoisted(() => ({ list: vi.fn() }));
const mockAuthApi = vi.hoisted(() => ({ getSession: vi.fn() }));
const mockUseCompanyRole = vi.hoisted(() => vi.fn());
const mockPushToast = vi.hoisted(() => vi.fn());

vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompanyId: COMPANY, selectedCompany: { id: COMPANY, name: "Nordstrand", issuePrefix: "DUR" } }),
}));
vi.mock("../context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: vi.fn() }) }));
vi.mock("../context/ToastContext", () => ({
  useToast: () => ({ pushToast: mockPushToast }),
  useToastActions: () => ({ pushToast: mockPushToast }),
}));
vi.mock("../hooks/useCompanyRole", () => ({ useCompanyRole: mockUseCompanyRole }));
vi.mock("../api/emailSettings", () => ({ emailSettingsApi: mockEmailSettingsApi }));
vi.mock("../api/mail", () => ({ mailApi: mockMailApi }));
vi.mock("../api/secrets", () => ({ secretsApi: mockSecretsApi }));
vi.mock("../api/auth", () => ({ authApi: mockAuthApi }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function role(canManage: boolean) {
  return { role: canManage ? "owner" : "operator", isInstanceAdmin: false, localBoard: false, canManageConnections: canManage, isLoading: false };
}

const account: MailAccountSummary = {
  id: ACCOUNT,
  ownerUserId: USER,
  paAgentId: null,
  displayName: "My inbox",
  emailAddress: "filip@example.com",
  imapHost: "imap.example.com",
  imapPort: 993,
  imapSecure: true,
  imapUsername: "filip@example.com",
  imapMailbox: "INBOX",
  hasImapCredential: true,
  smtpHost: "smtp.example.com",
  smtpPort: 587,
  smtpSecure: true,
  smtpUsername: "filip@example.com",
  hasSmtpCredential: true,
  enabled: true,
  checkEveryMinutes: 5,
  lastCheckAt: null,
  lastCheckOk: null,
  lastCheckMessage: null,
  consecutiveFailures: 0,
  createdAt: new Date().toISOString(),
};

const message: MailMessageSummary = {
  id: MESSAGE,
  accountId: ACCOUNT,
  folder: "inbox",
  direction: "inbound",
  messageId: "<abc@example.com>",
  inReplyToMessageId: null,
  fromAddress: "vendor@example.com",
  toAddresses: ["filip@example.com"],
  ccAddresses: [],
  subject: "Invoice question",
  bodyText: "Hi Filip, can you confirm the invoice amount?",
  bodyHtml: null,
  isRead: true,
  isDraft: false,
  aiDrafted: false,
  receivedAt: new Date().toISOString(),
  sentAt: null,
  createdAt: new Date().toISOString(),
};

async function flush() {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await Promise.resolve();
      await new Promise((resolve) => window.setTimeout(resolve, 0));
    });
  }
}

describe("Email page", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockEmailSettingsApi.getSettings.mockResolvedValue({ enabled: true });
    mockEmailSettingsApi.setEnabled.mockResolvedValue({ enabled: true });
    mockMailApi.listAccounts.mockResolvedValue([account]);
    mockMailApi.listMessages.mockResolvedValue([message]);
    mockMailApi.searchMessages.mockResolvedValue([]);
    mockMailApi.createDraft.mockResolvedValue({ ...message, id: "draft-1", isDraft: true });
    mockMailApi.sendDraft.mockResolvedValue({ ...message, id: "draft-1", isDraft: false, direction: "outbound" });
    mockSecretsApi.list.mockResolvedValue([]);
    mockAuthApi.getSession.mockResolvedValue({ user: { id: USER } });
    mockUseCompanyRole.mockReturnValue(role(true));
  });

  afterEach(async () => {
    if (root) {
      const current = root;
      await act(async () => current.unmount());
      root = null;
    }
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  async function render() {
    root = createRoot(container);
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const current = root;
    await act(async () => {
      current.render(
        <MemoryRouter>
          <QueryClientProvider client={queryClient}>
            <Email />
          </QueryClientProvider>
        </MemoryRouter>,
      );
    });
    await flush();
  }

  function buttonByText(label: string, scope: ParentNode = document): HTMLButtonElement | undefined {
    return Array.from(scope.querySelectorAll("button")).find((element) => element.textContent?.trim() === label) as
      | HTMLButtonElement
      | undefined;
  }

  it("when turned off, an owner sees a button to turn it on and no account lookup", async () => {
    mockEmailSettingsApi.getSettings.mockResolvedValue({ enabled: false });
    await render();
    expect(container.textContent).toContain("isn't turned on yet");
    expect(mockMailApi.listAccounts).not.toHaveBeenCalled();
    await act(async () => buttonByText("Turn on email")!.click());
    await flush();
    expect(mockEmailSettingsApi.setEnabled).toHaveBeenCalledWith(COMPANY, true);
  });

  it("when turned off, someone who is not owner or admin is told to ask one, with no button", async () => {
    mockEmailSettingsApi.getSettings.mockResolvedValue({ enabled: false });
    mockUseCompanyRole.mockReturnValue(role(false));
    await render();
    expect(container.textContent).toContain("Ask a company owner or admin to turn it on");
    expect(buttonByText("Turn on email")).toBeUndefined();
  });

  it("with no mailbox connected yet, shows the connect-your-mailbox form", async () => {
    mockMailApi.listAccounts.mockResolvedValue([]);
    await render();
    expect(container.textContent).toContain("Connect your mailbox");
    expect(container.querySelector("#mailbox-email")).not.toBeNull();
  });

  it("lists an inbox message with its subject and sender", async () => {
    await render();
    const row = container.querySelector('[data-testid="mail-message-row"]')!;
    expect(row.textContent).toContain("vendor@example.com");
    expect(row.textContent).toContain("Invoice question");
  });

  it("reading a message shows its full body and a Reply action", async () => {
    await render();
    const row = container.querySelector<HTMLButtonElement>('[data-testid="mail-message-row"]')!;
    await act(async () => row.click());
    await flush();
    expect(container.textContent).toContain("can you confirm the invoice amount?");
    expect(buttonByText("Reply")).toBeDefined();
  });

  it("replying and pressing Send creates a draft and then sends it, never sending directly", async () => {
    await render();
    const row = container.querySelector<HTMLButtonElement>('[data-testid="mail-message-row"]')!;
    await act(async () => row.click());
    await flush();
    await act(async () => buttonByText("Reply")!.click());
    await flush();

    const body = container.querySelector<HTMLTextAreaElement>("#compose-body")!;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    await act(async () => {
      setter?.call(body, "Yes, the invoice total is correct.");
      body.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => buttonByText("Send")!.click());
    await flush();

    expect(mockMailApi.createDraft).toHaveBeenCalledWith(
      COMPANY,
      ACCOUNT,
      expect.objectContaining({
        toAddresses: ["vendor@example.com"],
        bodyText: "Yes, the invoice total is correct.",
        inReplyToMessageId: MESSAGE,
      }),
    );
    expect(mockMailApi.sendDraft).toHaveBeenCalledWith(COMPANY, ACCOUNT, "draft-1");
    expect(mockPushToast).toHaveBeenCalledWith(expect.objectContaining({ title: "Message sent" }));
  });

  it("an AI-drafted message is labelled so a human knows to review it before sending", async () => {
    mockMailApi.listMessages.mockResolvedValue([{ ...message, isDraft: true, aiDrafted: true, folder: "drafts" }]);
    await render();
    const row = container.querySelector('[data-testid="mail-message-row"]')!;
    expect(row.textContent).toContain("AI draft");
  });

  const urgency = {
    urgent: true,
    category: "bank-payment",
    reason: "Payment is overdue.",
    summary: "Invoice 12 is past due.",
    classifiedAt: "2026-10-07T00:00:00Z",
    operatorFeedback: null,
  };

  it("shows an Urgent badge on urgent mail and nothing on unchecked mail", async () => {
    mockMailApi.listMessages.mockResolvedValue([{ ...message, urgency }, { ...message, id: "m2" }]);
    await render();
    const rows = container.querySelectorAll('[data-testid="mail-message-row"]');
    expect(rows[0]!.textContent).toContain("Urgent");
    expect(rows[1]!.textContent).not.toContain("Urgent");
  });

  it("reading urgent mail shows why, and Right/Wrong saves the answer", async () => {
    mockMailApi.listMessages.mockResolvedValue([{ ...message, urgency }]);
    mockMailApi.setUrgencyFeedback.mockResolvedValue({ ...urgency, operatorFeedback: "incorrect" });
    await render();
    await act(async () => {
      (container.querySelector('[data-testid="mail-message-row"]') as HTMLElement).click();
    });
    const panel = container.querySelector('[data-testid="mail-urgency-panel"]')!;
    expect(panel.textContent).toContain("Payment is overdue.");
    expect(panel.textContent).toContain("Invoice 12 is past due.");
    await act(async () => {
      buttonByText("Wrong", panel)!.click();
    });
    expect(mockMailApi.setUrgencyFeedback).toHaveBeenCalledWith(expect.anything(), expect.anything(), message.id, "incorrect");
  });

  it("mail that was never checked has no urgency panel", async () => {
    await render();
    await act(async () => {
      (container.querySelector('[data-testid="mail-message-row"]') as HTMLElement).click();
    });
    expect(container.querySelector('[data-testid="mail-urgency-panel"]')).toBeNull();
  });
});
