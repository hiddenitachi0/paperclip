/**
 * "Use this model for picture requests" (11 Oct): a quick agent on a small
 * local model often cannot call the picture tool reliably and cannot see a
 * photo the person sends. This optional setting names one of the company's
 * saved models (Settings > Models, a model_directory_entries id) that answers
 * the turns that involve pictures instead: a message with a photo attached,
 * a follow-up about that photo, or a request for a picture. Every other turn
 * stays on the agent's own model.
 *
 * Lives at adapterConfig.laneA.pictureModelId, next to the quick agent's
 * other Lane A switches (webSearch, conversationSearch). Unset by default,
 * so nothing changes for an agent until an owner or admin picks one. The
 * model is called the same way as a backup model on that provider (the
 * agent's own key for that provider).
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** adapterConfig.laneA.pictureModelId, read defensively: a saved-model id, or null. */
export function readLaneAPictureModelId(adapterConfig: unknown): string | null {
  if (typeof adapterConfig !== "object" || adapterConfig === null) return null;
  const laneA = (adapterConfig as { laneA?: unknown }).laneA;
  if (typeof laneA !== "object" || laneA === null) return null;
  const value = (laneA as { pictureModelId?: unknown }).pictureModelId;
  return typeof value === "string" && UUID.test(value.trim()) ? value.trim().toLowerCase() : null;
}
