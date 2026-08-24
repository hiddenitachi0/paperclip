import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { agentAvatarUrl } from "../lib/agent-icons";

interface PersonaAvatarSource {
  avatarAssetId?: string | null;
  displayName?: string | null;
}

interface PersonaAvatarProps {
  persona: PersonaAvatarSource | null | undefined;
  size?: "default" | "xs" | "sm" | "lg";
  className?: string;
}

function initials(name: string | null | undefined): string {
  if (!name) return "?";
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return `${parts[0]![0]}${parts[parts.length - 1]![0]}`.toUpperCase();
}

// Same content path an agent's uploaded avatar uses (/api/assets/{id}/content)
// -- personas carry their own avatarAssetId (packages/db/src/schema/personas.ts)
// so a persona's face never has to be the same as her underlying agent's.
export function PersonaAvatar({ persona, size = "default", className }: PersonaAvatarProps) {
  const src = agentAvatarUrl(persona);
  return (
    <Avatar size={size} className={className}>
      {src ? <AvatarImage src={src} alt="" /> : null}
      <AvatarFallback>{initials(persona?.displayName)}</AvatarFallback>
    </Avatar>
  );
}
