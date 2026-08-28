/**
 * `GET /session/agents` cache sharing.
 *
 * The chat view (lead capabilities) and the spawned-agent header chips both
 * read this endpoint for the same open session. They only share one cache
 * entry — and therefore one request — while both pass the same session ID.
 */
import { describe, expect, it } from 'bun:test'
import { teamAgentsQueryOptions } from '@/queries/team-agents'

describe('teamAgentsQueryOptions', () => {
  it('shares one cache entry for the same workspace and session', () => {
    const fromChatView = teamAgentsQueryOptions('/tmp/workspace', 'session-1')
    const fromSpawnedAgents = teamAgentsQueryOptions('/tmp/workspace', 'session-1')

    expect(fromChatView.queryKey).toEqual(fromSpawnedAgents.queryKey)
  })

  it('keeps a separate entry per session so child chips never leak across sessions', () => {
    const first = teamAgentsQueryOptions('/tmp/workspace', 'session-1')
    const second = teamAgentsQueryOptions('/tmp/workspace', 'session-2')

    expect(first.queryKey).not.toEqual(second.queryKey)
  })
})
