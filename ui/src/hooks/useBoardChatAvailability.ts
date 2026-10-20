import { useQuery } from "@tanstack/react-query";
import { healthApi } from "@/api/health";
import { boardChatApi } from "@/api/boardChat";
import { queryKeys } from "@/lib/queryKeys";
import { useConferenceRoomChatEnabled } from "./useConferenceRoomChatEnabled";

export type BoardChatUnavailableReason =
  /** The Board chat switch for the whole Paperclip is off. */
  | "turned_off"
  /** This server cannot tell (an older Paperclip, or the check failed). */
  | "not_on_this_server"
  /** Signed-in Paperclip: this company has not switched Board chat on. */
  | "company_off"
  /** Signed-in Paperclip: this person is not the company's owner or an admin. */
  | "not_allowed";

export interface BoardChatAvailability {
  /** True only when this person can actually send a message in Board chat. */
  available: boolean;
  /** False while it is still being worked out (show nothing yet). */
  loaded: boolean;
  /** Why not, when it is not available. */
  reason: BoardChatUnavailableReason | null;
  /** "local" on a single-user Paperclip, "signed_in" on a shared one, null while unknown. */
  mode: "local" | "signed_in" | null;
  /** True when this person may switch Board chat on for the company (its owner, or an instance admin). */
  canChangeSettings: boolean;
}

const NOT_LOADED: BoardChatAvailability = { available: false, loaded: false, reason: null, mode: null, canChangeSettings: false };

/**
 * Whether Board chat can be used here, gated exactly like its server route
 * (`POST /board/chat/stream`):
 *   * the instance's Board chat setting must be on;
 *   * on a single-user local Paperclip that is all (unchanged);
 *   * on a signed-in Paperclip the person must be the company's owner or an
 *     admin (or an instance admin), and the company must have switched Board
 *     chat on — the server answers that for the selected company.
 */
export function useBoardChatAvailability(companyId?: string | null): BoardChatAvailability {
  const flag = useConferenceRoomChatEnabled();
  const health = useQuery({
    queryKey: queryKeys.health,
    queryFn: () => healthApi.get(),
    retry: false,
    enabled: flag.enabled,
  });
  const signedIn = health.data?.deploymentMode === "authenticated";
  const availability = useQuery({
    queryKey: queryKeys.boardChat.availability(companyId ?? ""),
    queryFn: () => boardChatApi.getAvailability(companyId!),
    retry: false,
    enabled: flag.enabled && signedIn && Boolean(companyId),
  });
  if (!flag.loaded) return NOT_LOADED;
  if (!flag.enabled) return { ...NOT_LOADED, loaded: true, reason: "turned_off" };
  if (!health.data) {
    // The server's mode is unknown (still loading, or the check failed): say nothing until it is known.
    return { ...NOT_LOADED, loaded: !health.isPending, reason: health.isPending ? null : "not_on_this_server" };
  }
  if (health.data.deploymentMode === "local_trusted") {
    return { available: true, loaded: true, reason: null, mode: "local", canChangeSettings: true };
  }
  if (!signedIn) return { ...NOT_LOADED, loaded: true, reason: "not_on_this_server" };
  if (!companyId) return { ...NOT_LOADED, loaded: true, mode: "signed_in" };
  if (availability.isPending) return { ...NOT_LOADED, mode: "signed_in" };
  const data = availability.data;
  if (!data) return { ...NOT_LOADED, loaded: true, reason: "not_on_this_server", mode: "signed_in" };
  const base = { loaded: true, mode: "signed_in" as const, canChangeSettings: data.canChangeSettings === true };
  if (data.available) return { ...base, available: true, reason: null };
  const reason: BoardChatUnavailableReason =
    data.reason === "instance_off"
      ? "turned_off"
      : data.reason === "company_off"
        ? "company_off"
        : "not_allowed";
  return { ...base, available: false, reason };
}

/** A plain sentence for a person who cannot use Board chat, or null. */
export function boardChatUnavailableText(reason: BoardChatUnavailableReason | null): string | null {
  if (reason === "turned_off") {
    return "Ask can only explain, and Board chat (which can make changes for you) is not turned on here. Follow the steps above to do it yourself, or ask the person who runs your Paperclip.";
  }
  if (reason === "company_off") {
    return "Ask can only explain, and Board chat (which can make changes for you) is turned off for this company. Follow the steps above to do it yourself, or ask the company's owner to turn it on in Company settings.";
  }
  if (reason === "not_allowed") {
    return "Ask can only explain, and Board chat (which can make changes for you) is only for this company's owner and admins. Follow the steps above to do it yourself.";
  }
  if (reason === "not_on_this_server") {
    return "Ask can only explain, and Board chat (which can make changes for you) is not available on this Paperclip. Follow the steps above to do it yourself.";
  }
  return null;
}
