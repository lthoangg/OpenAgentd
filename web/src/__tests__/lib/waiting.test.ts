/**
 * What a session still waits for, in words: sessions (subagents and other
 * workspaces), background commands it waits for, and commands that only
 * keep running.
 */
import { describe, expect, it } from 'bun:test'

import type { WaitingItem } from '@/api/types'
import { countWaiting, waitingText } from '@/lib/waiting'

const session = (state: WaitingItem['state'] = 'working'): WaitingItem => ({ kind: 'subagent', session_id: `s-${state}`, title: null, label: 'worker#1', workspace: '', state })
const command = (number: number, waited: boolean): WaitingItem => ({ kind: 'command', session_id: 'lead', number, title: null, label: 'make verify', workspace: '', state: 'working', waited, started_at: 0 })

describe('countWaiting', () => {
  it('counts sessions, waited commands and servers apart, and leaves idle sessions out', () => {
    expect(countWaiting([session(), session('needs_input'), session('idle'), command(1, false), command(2, true)])).toEqual({ sessions: 2, commands: 1, servers: 1, needYou: 1 })
    expect(countWaiting(undefined)).toEqual({ sessions: 0, commands: 0, servers: 0, needYou: 0 })
  })
})

describe('waitingText', () => {
  const text = (items: WaitingItem[]) => waitingText(countWaiting(items))

  it('names what the session waits for', () => {
    expect(text([session()])).toBe('Waiting for 1 session')
    expect(text([command(1, true)])).toBe('Waiting for 1 command')
    expect(text([session(), session('needs_input'), command(1, true), command(2, true)])).toBe('Waiting for 2 sessions and 2 commands')
  })

  it('does not call a server something it waits for', () => {
    expect(text([command(1, false)])).toBe('1 command running')
    expect(text([command(1, false), command(2, false)])).toBe('2 commands running')
    // Beside something awaited, the server is only in the list.
    expect(text([command(1, false), command(2, true)])).toBe('Waiting for 1 command')
  })

  it('says nothing when nothing runs', () => {
    expect(text([session('idle')])).toBeNull()
  })
})
