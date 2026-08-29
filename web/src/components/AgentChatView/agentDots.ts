import { isAgentRole, type AgentRole } from '@/lib/agent-roles'
import type { AgentStream } from '@/stores/useAgentStore'

export const DOT_BY_ROLE: Record<AgentRole, string> = {
  openagentd: 'bg-(--color-marker-mint)',
  executor: 'bg-(--color-marker-orange)',
  consultant: 'bg-(--color-marker-blue)',
  explorer: 'bg-(--color-text-muted)',
}

export function dotClassFor(agent: string, stream: AgentStream | undefined): string {
  if (stream?.status === 'error') return 'bg-(--color-error)'
  if (stream?.status === 'working') return 'animate-pulse bg-(--color-accent)'
  if (stream?.status === 'offline') return 'bg-(--color-text-subtle) opacity-50'
  if (isAgentRole(agent)) return DOT_BY_ROLE[agent]
  return 'bg-(--color-success)'
}
