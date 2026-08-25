import { z } from "zod";

// DUR-217: POST /api/lane-a/:agentId/messages body. Lane A is a direct
// model-call text primitive — companyId scopes the request the same way
// every other route does, conversationId resumes an existing thread (turn
// cap + idle timeout enforced server-side), context is optional caller-
// supplied grounding text (e.g. the product row a dashboard button is
// attached to), never executable.
export const sendLaneAMessageSchema = z.object({
  companyId: z.string().uuid(),
  message: z.string().trim().min(1).max(8000),
  conversationId: z.string().uuid().optional(),
  context: z.string().max(16000).optional(),
});

export type SendLaneAMessage = z.infer<typeof sendLaneAMessageSchema>;
