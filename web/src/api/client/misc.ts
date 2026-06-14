/**
 * OpenAgentd API client — misc endpoints: health, team status, quote, URL helpers.
 */

import { apiBaseUrl } from '../base-url'
import { parseDetailOrThrow } from './_shared'
import type {
  TeamStatusResponse,
} from '../types'

export async function health(): Promise<{ status: string; version: string }> {
  const res = await fetch(`${apiBaseUrl()}/health/ready`)
  if (!res.ok) await parseDetailOrThrow(res, 'health')
  return res.json()
}

// ── Compat: team status via /team/agents ─────────────────────────────────────
// HomePage uses this to determine if team mode is available

export async function teamStatus(workspace?: string | null): Promise<TeamStatusResponse | null> {
  const params = new URLSearchParams()
  if (workspace) params.set('workspace', workspace)
  const query = params.toString()
  const res = await fetch(`${apiBaseUrl()}/team/agents${query ? `?${query}` : ''}`)
  if (res.status === 404) return null
  if (!res.ok) return null
  const data = await res.json()
  // Shape into TeamStatusResponse for compatibility with useTeamStatusQuery
  const agents = data.agents ?? []
  const lead = agents.find((a: { is_lead: boolean }) => a.is_lead) ?? agents[0]
  if (!lead) return null
  return {
    team: 'team',
    lead: { name: lead.name, model: lead.model ?? '', state: 'idle' },
    members: agents
      .filter((a: { is_lead: boolean }) => !a.is_lead)
      .map((a: { name: string; model: string | null }) => ({ name: a.name, model: a.model ?? '', state: 'idle' })),
  }
}

// ── /quote ───────────────────────────────────────────────────────────────────

export async function getQuoteOfTheDay(): Promise<{ quote: string; author: string }> {
  const res = await fetch(`${apiBaseUrl()}/quote`)
  if (!res.ok) await parseDetailOrThrow(res, 'getQuoteOfTheDay')
  return res.json()
}
