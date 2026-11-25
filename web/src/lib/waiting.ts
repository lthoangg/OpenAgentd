/**
 * What a session still waits for, counted and put in words. Sessions
 * (subagents, other workspaces) and background commands the session waits
 * for start its next turn when they report back. A command it does not
 * wait for (a server) only keeps running: it is listed, never "waited for".
 */
import type { WaitingItem } from '@/api/types'

export interface WaitingCounts {
  /** Subagents and other workspaces' sessions, running or stopped on the person. */
  sessions: number
  /** Background commands whose result the session waits for. */
  commands: number
  /** Background commands that keep running with nothing waiting for them. */
  servers: number
  /** Sessions stopped on a question or a plan review. */
  needYou: number
}

export function countWaiting(items: readonly WaitingItem[] | undefined): WaitingCounts {
  const counts: WaitingCounts = { sessions: 0, commands: 0, servers: 0, needYou: 0 }
  for (const item of items ?? []) {
    if (item.kind === 'command') {
      if (item.waited) counts.commands += 1
      else counts.servers += 1
    } else if (item.state !== 'idle') {
      counts.sessions += 1
      if (item.state === 'needs_input') counts.needYou += 1
    }
  }
  return counts
}

function plural(n: number, one: string): string {
  return `${n} ${n === 1 ? one : `${one}s`}`
}

/** What the session waits for (`2 sessions and 1 command`); `null` when it waits for nothing. */
export function awaitedText(counts: WaitingCounts): string | null {
  const parts = [counts.sessions > 0 && plural(counts.sessions, 'session'), counts.commands > 0 && plural(counts.commands, 'command')].filter(Boolean)
  return parts.length > 0 ? parts.join(' and ') : null
}

/** `Waiting for 2 sessions and 1 command`, `1 command running` for servers alone, `null` for nothing. */
export function waitingText(counts: WaitingCounts): string | null {
  const awaited = awaitedText(counts)
  if (awaited) return `Waiting for ${awaited}`
  return counts.servers > 0 ? `${plural(counts.servers, 'command')} running` : null
}
