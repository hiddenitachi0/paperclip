import type { ReactNode } from "react";
import { MessagesSquare } from "lucide-react";
import { useBoardChatAvailability } from "@/hooks/useBoardChatAvailability";

/** Shown at /board-chat where Board chat cannot run (a shared, signed-in Paperclip). */
export const BOARD_CHAT_NOT_HERE_TEXT =
  "Board chat only works when Paperclip runs on your own computer in single-user mode.";

/**
 * Board chat runs the operator's own Claude on the machine, so its server
 * route refuses everything except single-operator local mode. On any other
 * server a direct visit to /board-chat shows a plain explanation instead of a
 * chat whose every message would fail. (While the Board chat setting is off,
 * ConferenceRoomChatGate already sends the person to the company home.)
 */
export function BoardChatAvailabilityGate({ children }: { children: ReactNode }) {
  const { loaded, reason } = useBoardChatAvailability();
  if (!loaded) return null;
  if (reason === "not_on_this_server") {
    return (
      <div className="flex h-full items-center justify-center p-6" data-testid="board-chat-not-here">
        <div className="max-w-md space-y-2 text-center">
          <MessagesSquare className="mx-auto h-6 w-6 text-muted-foreground" aria-hidden="true" />
          <h2 className="text-lg font-semibold">Board chat is not available here</h2>
          <p className="text-sm text-muted-foreground">{BOARD_CHAT_NOT_HERE_TEXT}</p>
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
