import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { agentAvatarUrl } from "../lib/agent-icons";
import { AgentIcon } from "./AgentIconPicker";

// Structural rather than `Agent`-typed: callers (sidebar rows, org chart
// cards, chat-thread avatars) often only have a partial/nullable agent-like
// object on hand, not a full `Agent`.
interface AgentAvatarSource {
  icon?: string | null;
  avatarAssetId?: string | null;
  name?: string | null;
}

interface AgentAvatarProps {
  agent: AgentAvatarSource | null | undefined;
  size?: "default" | "xs" | "sm" | "lg";
  className?: string;
  iconClassName?: string;
}

export function AgentAvatar({ agent, size = "default", className, iconClassName }: AgentAvatarProps) {
  const src = agentAvatarUrl(agent);
  return (
    <Avatar size={size} className={className}>
      {src ? <AvatarImage src={src} alt="" /> : null}
      <AvatarFallback>
        <AgentIcon icon={agent?.icon} className={iconClassName} />
      </AvatarFallback>
    </Avatar>
  );
}
