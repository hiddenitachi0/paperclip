import type { PersonaAccountPlatform } from "@paperclipai/shared";
import type { PlatformAdapter } from "./types.js";
import { fanvuePlatformAdapter } from "./fanvue.js";

export type { PlatformAdapter, PlatformPublishRequest, PlatformPublishResult } from "./types.js";
export { PlatformPublishError } from "./types.js";

const adapters: Record<PersonaAccountPlatform, () => PlatformAdapter> = {
  fanvue: fanvuePlatformAdapter,
};

export function getPlatformAdapter(platform: PersonaAccountPlatform): PlatformAdapter {
  return adapters[platform]();
}
