/**
 * Conversation search for quick agents (DUR-4197): a quick agent searching
 * its own past conversations with the same person (lane_a_messages), so it
 * is not cold on every new chat.
 *
 * "Can search past conversations" is per quick agent, at
 * adapterConfig.laneA.conversationSearch (off when absent), next to the
 * quick agent's other Lane A switches (see web-search.ts's webSearch for
 * the sibling flag). Off by default: this is new behaviour, so it must be
 * turned on deliberately rather than changing what an existing quick agent
 * already does.
 */

/** adapterConfig.laneA.conversationSearch, read defensively: anything but `true` is off. */
export function readLaneAConversationSearchSwitch(adapterConfig: unknown): boolean {
  if (typeof adapterConfig !== "object" || adapterConfig === null) return false;
  const laneA = (adapterConfig as { laneA?: unknown }).laneA;
  if (typeof laneA !== "object" || laneA === null) return false;
  return (laneA as { conversationSearch?: unknown }).conversationSearch === true;
}
