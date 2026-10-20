import type { ReactNode } from "react";
import { MessagesSquare } from "lucide-react";
import { Link } from "@/lib/router";
import { useOptionalCompany } from "@/context/CompanyContext";
import { useBoardChatAvailability, type BoardChatUnavailableReason } from "@/hooks/useBoardChatAvailability";

/** Shown at /board-chat on a Paperclip that cannot tell whether Board chat works here. */
export const BOARD_CHAT_NOT_HERE_TEXT = "Board chat is not available on this Paperclip.";
export const BOARD_CHAT_COMPANY_OFF_TEXT = "Board chat is turned off for this company.";
export const BOARD_CHAT_NOT_ALLOWED_TEXT = "Board chat is only for this company's owner and admins.";

function explanation(reason: BoardChatUnavailableReason, canChangeSettings: boolean) {
  if (reason === "company_off") {
    return {
      title: BOARD_CHAT_COMPANY_OFF_TEXT,
      body: canChangeSettings
        ? "You can turn it on in Company settings, under Board chat. Read the note there first: Board chat can prepare changes for you, and each one waits for your Approve."
        : "The company's owner can turn it on in Company settings.",
      showSettingsLink: canChangeSettings,
    };
  }
  if (reason === "not_allowed") {
    return {
      title: BOARD_CHAT_NOT_ALLOWED_TEXT,
      body: "Ask the company's owner if you need it.",
      showSettingsLink: false,
    };
  }
  return { title: BOARD_CHAT_NOT_HERE_TEXT, body: null, showSettingsLink: false };
}

/**
 * At /board-chat, show a plain explanation instead of a chat whose every
 * message would fail: on a signed-in Paperclip when the company has not
 * switched Board chat on, or the person is not its owner or an admin. (While
 * the instance-wide Board chat setting is off, ConferenceRoomChatGate already
 * sends the person to the company home.)
 */
export function BoardChatAvailabilityGate({ children }: { children: ReactNode }) {
  const company = useOptionalCompany();
  const { loaded, reason, canChangeSettings } = useBoardChatAvailability(company?.selectedCompanyId ?? null);
  if (!loaded) return null;
  if (reason === "not_on_this_server" || reason === "company_off" || reason === "not_allowed") {
    const text = explanation(reason, canChangeSettings);
    return (
      <div className="flex h-full items-center justify-center p-6" data-testid="board-chat-not-here">
        <div className="max-w-md space-y-2 text-center">
          <MessagesSquare className="mx-auto h-6 w-6 text-muted-foreground" aria-hidden="true" />
          <h2 className="text-lg font-semibold">{text.title}</h2>
          {text.body ? <p className="text-sm text-muted-foreground">{text.body}</p> : null}
          {text.showSettingsLink ? (
            <p className="text-sm">
              <Link to="/company/settings" className="underline" data-testid="board-chat-settings-link">
                Open Company settings
              </Link>
            </p>
          ) : null}
          <p className="text-sm text-muted-foreground">
            For an explanation of any page, use the Ask tab on the right edge. To change something, use the page's own
            buttons and settings.
          </p>
        </div>
      </div>
    );
  }
  return <>{children}</>;
}
