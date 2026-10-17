import { useQuery } from "@tanstack/react-query";
import { healthApi } from "@/api/health";
import { queryKeys } from "@/lib/queryKeys";
import { useConferenceRoomChatEnabled } from "./useConferenceRoomChatEnabled";

export type BoardChatUnavailableReason = "turned_off" | "not_on_this_server";

export interface BoardChatAvailability {
  /** True only when this person can actually send a message in Board chat. */
  available: boolean;
  /** False while it is still being worked out (show nothing yet). */
  loaded: boolean;
  /** Why not, when it is not available. */
  reason: BoardChatUnavailableReason | null;
}

/**
 * Whether Board chat can be used here, gated exactly like its server route
 * (`POST /board/chat/stream`): the instance's Board chat setting must be on,
 * and Paperclip must run in single-operator local mode (Board chat runs the
 * operator's own Claude on the machine, so it is refused for remote users).
 */
export function useBoardChatAvailability(): BoardChatAvailability {
  const flag = useConferenceRoomChatEnabled();
  const health = useQuery({
    queryKey: queryKeys.health,
    queryFn: () => healthApi.get(),
    retry: false,
    enabled: flag.enabled,
  });
  if (!flag.loaded) return { available: false, loaded: false, reason: null };
  if (!flag.enabled) return { available: false, loaded: true, reason: "turned_off" };
  if (!health.data) {
    // The server's mode is unknown (still loading, or the check failed): say nothing until it is known.
    return { available: false, loaded: !health.isPending, reason: health.isPending ? null : "not_on_this_server" };
  }
  if (health.data.deploymentMode !== "local_trusted") {
    return { available: false, loaded: true, reason: "not_on_this_server" };
  }
  return { available: true, loaded: true, reason: null };
}

/** A plain sentence for a person who cannot use Board chat, or null. */
export function boardChatUnavailableText(reason: BoardChatUnavailableReason | null): string | null {
  if (reason === "turned_off") {
    return "Ask can only explain, and Board chat (which can make changes for you) is not turned on here. Follow the steps above to do it yourself, or ask the person who runs your Paperclip.";
  }
  if (reason === "not_on_this_server") {
    return "Ask can only explain, and Board chat (which can make changes for you) only works when Paperclip runs on your own computer. Follow the steps above to do it yourself.";
  }
  return null;
}
