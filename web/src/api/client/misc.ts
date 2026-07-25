/**
 * OpenAgentd API client — misc endpoints: health, team status, quote, URL helpers.
 */

import { apiBaseUrl } from '../base-url'
import { parseDetailOrThrow } from './_shared'
import { listTeamAgents } from './team'
import type {
  TeamAgentsResponse,
  TeamStatusResponse,
} from '../types'

export async function health(): Promise<{ status: string; version: string }> {
  const res = await fetch(`${apiBaseUrl()}/health/ready`)
  if (!res.ok) await parseDetailOrThrow(res, 'health')
  return res.json()
}

// ── Compat: team status derived from /team/agents ────────────────────────────
//
// There is no separate status endpoint: this is a projection of
// `GET /team/agents`. It goes through `listTeamAgents` rather than fetching
// directly so the team store's call shares one round trip with the header's
// TanStack query (see the coalescing note in `client/team.ts`).
//
// `/team/agents` carries no per-agent run state, so `state` is always 'idle'
// here; live working/idle transitions come from the SSE `agent_status` events.

export function shapeTeamStatus(data: TeamAgentsResponse): TeamStatusResponse | null {
  const agents = data.agents ?? []
  const lead = agents.find((a) => a.is_lead) ?? agents[0]
  if (!lead) return null
  return {
    team: 'team',
    lead: { name: lead.name, model: lead.model ?? '', state: 'idle' },
    members: agents
      .filter((a) => !a.is_lead)
      .map((a) => ({ name: a.name, model: a.model ?? '', state: 'idle' })),
  }
}

export async function teamStatus(workspace?: string | null): Promise<TeamStatusResponse | null> {
  try {
    return shapeTeamStatus(await listTeamAgents(workspace))
  } catch {
    // Soft failure: callers treat null as "team mode unavailable".
    return null
  }
}

// ── /quote ───────────────────────────────────────────────────────────────────

export async function getQuoteOfTheDay(): Promise<{ quote: string; author: string }> {
  const res = await fetch(`${apiBaseUrl()}/quote`)
  if (!res.ok) await parseDetailOrThrow(res, 'getQuoteOfTheDay')
  return res.json()
}
