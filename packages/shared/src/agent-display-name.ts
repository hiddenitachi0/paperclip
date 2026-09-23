/**
 * DUR-4000: how an agent with a persona is named everywhere agents are listed
 * (agent list, org chart, approvals, quick-agent card, secretary roster,
 * Lane A colleague list): "Sales agent 1 (Maja)".
 *
 * The equality guard is for agents that were renamed to their persona before
 * DUR-4000 (creating a persona used to overwrite agents.name): "Maja (Maja)"
 * would be noise, so such an agent shows only its name until the operator
 * renames the job back, at which point it becomes "Sales agent 1 (Maja)".
 */
export function formatAgentDisplayName(
  agent: { name: string },
  persona: { displayName: string | null } | null | undefined,
): string {
  const personaName = persona?.displayName?.trim();
  if (!personaName) return agent.name;
  if (personaName.toLowerCase() === agent.name.trim().toLowerCase()) return agent.name;
  return `${agent.name} (${personaName})`;
}
