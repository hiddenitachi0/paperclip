import type {
  InstanceServerAnthropicKeyStatus,
  InstanceServerAnthropicKeyTestResult,
} from "@paperclipai/shared";
import { api } from "./client";

/**
 * Paperclip's own Claude key (the key the server itself calls Claude with).
 * No call here ever returns the key -- at most its last four characters.
 */
export const instanceServerAnthropicKeyApi = {
  get: () => api.get<InstanceServerAnthropicKeyStatus>("/instance/server-anthropic-key"),
  save: (key: string) =>
    api.put<InstanceServerAnthropicKeyTestResult>("/instance/server-anthropic-key", { key }),
  test: () =>
    api.post<InstanceServerAnthropicKeyTestResult>("/instance/server-anthropic-key/test", undefined),
  remove: () => api.delete<InstanceServerAnthropicKeyStatus>("/instance/server-anthropic-key"),
};
