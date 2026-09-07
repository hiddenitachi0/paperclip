import { z } from "zod";
import { SIGN_OUT_EVERYWHERE_SCOPES } from "../types/instance-security.js";

export const signOutEverywhereSchema = z.object({
  scope: z.enum(SIGN_OUT_EVERYWHERE_SCOPES).optional().default("me"),
});
export type SignOutEverywhereInput = z.infer<typeof signOutEverywhereSchema>;
