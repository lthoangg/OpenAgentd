/**
 * The session states the backend sends as ``agent_status`` are listed in
 * ``appv3/crates/agent/data/session_states.json``; the Rust side checks its
 * ``SessionStatus`` against the same list (``session/control.rs``). Here the
 * web's status type and its ``agent_status`` handler are held to it, so a
 * state added on one side cannot be silently ignored by the other.
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { SESSION_STATUSES } from '@/stores/useAgentStore/types'

const contract = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../../appv3/crates/agent/data/session_states.json', import.meta.url)), 'utf8'),
) as { agent_status: string[] }

const handler = readFileSync(fileURLToPath(new URL('../../stores/useAgentStore/sse-agent-status.ts', import.meta.url)), 'utf8')

describe('session states contract (appv3/crates/agent/data/session_states.json)', () => {
  it('types exactly the states the backend sends', () => {
    expect([...SESSION_STATUSES]).toEqual(contract.agent_status)
  })

  it('handles every state in agent_status', () => {
    expect(contract.agent_status.filter((status) => !handler.includes(`status === '${status}'`))).toEqual([])
  })
})
