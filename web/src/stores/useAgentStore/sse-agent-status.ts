/**
 * What the stream says about each agent's state: working, waiting, idle,
 * offline, or failed, and how a failure (the provider's above all) reaches the
 * transcript and the error banner.
 */
import { generateBlockId } from '@/utils/blocks'
import { anyAgentLive, appendLocalBlocks, ensureAgent } from './helpers'
import { commitLiveBlocks } from './sse-turn'
import type { AgentError, StoreSet } from './types'
import type { ContentBlock } from '@/api/types'

/** True when a failure is the model provider's, so the transcript shows it. */
function isProviderFailure(title: string | undefined, message: string, code?: string, category?: AgentError['category']): boolean {
  const text = `${title ?? ''} ${message}`.toLowerCase()
  return category === 'provider' ||
    Boolean(code?.startsWith('provider_')) ||
    text.includes('provider') ||
    text.includes('rate limit') ||
    text.includes('quota') ||
    text.includes('invalid api key')
}

export function onAgentStatus(set: StoreSet, d: Record<string, unknown>) {
  const agent = d.agent as string
  const status = d.status as string
  set((draft) => {
    ensureAgent(draft, agent)
    if (status === 'working') {
      draft.agentStreams[agent].status = 'working'
      draft.isAgentWorking = true
      if (draft.liveAgentNames && !draft.liveAgentNames.includes(agent)) draft.liveAgentNames.push(agent)
      // Only the sidebar's ``running`` badge depends on this. Patch that
      // one field rather than invalidating the whole list — an agent turn
      // emits one agent_status per member, so invalidating here used to
      // cost (members × loaded pages) sequential refetches per turn. Patch
      // once per turn: later members find the row already marked running.
      if (draft.sessionId && draft._runningPatchedFor !== draft.sessionId) {
        draft._runningPatchedFor = draft.sessionId
        draft.cacheInvalidations.push({
          kind: 'session_running',
          sessionId: draft.sessionId,
          running: true,
        })
      }
    } else if (status === 'waiting_input') {
      // Suspended on ask_user: still live, but no tokens are coming.
      draft.agentStreams[agent].status = 'waiting_input'
      draft.isAgentWorking = true
      if (draft.liveAgentNames && !draft.liveAgentNames.includes(agent)) draft.liveAgentNames.push(agent)
    } else if (status === 'waiting_lead') {
      // A member whose turn ended on a question to its lead: live, not busy.
      // Viewed as its own session (it is this view's lead), nothing runs.
      draft.agentStreams[agent].status = 'waiting_lead'
      if (agent === draft.leadName) draft.isAgentWorking = false
      if (draft.liveAgentNames && !draft.liveAgentNames.includes(agent)) draft.liveAgentNames.push(agent)
    } else if (status === 'idle') {
      draft.agentStreams[agent].status = 'idle'
      if (draft.liveAgentNames && !draft.liveAgentNames.includes(agent)) draft.liveAgentNames.push(agent)
    } else if (status === 'offline') {
      draft.agentStreams[agent].status = 'offline'
      if (draft.liveAgentNames) draft.liveAgentNames = draft.liveAgentNames.filter((name) => name !== agent)
    } else if (status === 'error') {
      const meta = d.metadata as Record<string, unknown> | undefined
      const lastErr = (meta?.message as string) ?? (d.message as string) ?? null
      const errTitle = (meta?.title as string) ?? (d.title as string) ?? undefined
      const errCode = (meta?.code as string) ?? (d.code as string) ?? undefined
      const errCategory = (meta?.category as AgentError['category']) ?? (d.category as AgentError['category']) ?? undefined
      const errDetails = (meta?.details as string) ?? (d.details as string) ?? undefined

      draft.agentStreams[agent].status = 'error'
      draft.agentStreams[agent].lastError = lastErr
      if (draft.leadName && draft.agentStreams[draft.leadName]) {
        draft.agentStreams[draft.leadName].status = 'error'
        draft.agentStreams[draft.leadName].lastError = lastErr
      }
      if (draft.liveAgentNames && !draft.liveAgentNames.includes(agent)) draft.liveAgentNames.push(agent)

      if (lastErr && !draft.error) {
        draft.error = {
          title: errTitle || `Agent '${agent}' error`,
          message: lastErr,
          code: errCode,
          category: errCategory || 'system',
          agent,
        }
      }

      if (lastErr && isProviderFailure(errTitle, lastErr, errCode, errCategory)) {
        const targets = new Set<string>()
        if (agent) targets.add(agent)
        if (draft.leadName) targets.add(draft.leadName)

        for (const targetAgent of targets) {
          ensureAgent(draft, targetAgent)
          const stream = draft.agentStreams[targetAgent]
          const alreadyHas = stream.currentBlocks.some(
            (b) => b.type === 'provider_status' && b.extra?.status === 'error' && (b.extra?.message === lastErr || b.content === lastErr)
          ) || stream.blocks.some(
            (b) => b.type === 'provider_status' && b.extra?.status === 'error' && (b.extra?.message === lastErr || b.content === lastErr)
          )
          if (!alreadyHas) {
            // The agent that failed is done; a lead told of a
            // member's failure may still be mid-turn.
            if (targetAgent === agent) commitLiveBlocks(draft, stream, Date.now())
            const errorBlock: ContentBlock = {
              id: generateBlockId(),
              type: 'provider_status',
              content: lastErr,
              extra: {
                type: 'provider_status',
                status: 'error',
                title: errTitle || 'Model error',
                message: lastErr,
                code: errCode,
                details: errDetails,
                category: 'provider',
              },
              timestamp: new Date(),
            }
            appendLocalBlocks(stream, [errorBlock])
          }
        }
      }
    }
    if (status !== 'working' && status !== 'waiting_input') {
      draft.isAgentWorking = anyAgentLive(draft.agentStreams)
    }
  })
}

export function onProviderStatus(set: StoreSet, d: Record<string, unknown>) {
  const agent = d.agent as string
  const status = d.status as string
  if (!agent || !status) return
  set((draft) => {
    ensureAgent(draft, agent)
    const blocks = draft.agentStreams[agent].currentBlocks
    const last = blocks[blocks.length - 1]
    // A call waiting out a network drop retries every few seconds
    // for as long as it takes: update one notice instead of stacking.
    if (status === 'retrying' && last?.type === 'provider_status' && last.extra?.status === 'retrying') {
      last.extra = d
      last.timestamp = new Date()
      return
    }
    blocks.push({
      id: generateBlockId(),
      type: 'provider_status',
      content: '',
      extra: d,
      timestamp: new Date(),
    })
  })
}

export function onError(set: StoreSet, d: Record<string, unknown>) {
  const message = (d.message as string) || 'An error occurred'
  const title = d.title as string | undefined
  const code = d.code as string | undefined
  const category = d.category as AgentError['category'] | undefined
  const agent = d.agent as string | undefined
  const details = d.details as string | undefined

  set((draft) => {
    draft.error = title || code || category || agent
      ? { title, message, code, category, agent }
      : message
    draft.isAgentWorking = false
    draft._runningPatchedFor = null

    const effectiveAgent = agent || draft.leadName || Object.keys(draft.agentStreams)[0] || 'lead'
    if (isProviderFailure(title, message, code, category)) {
      const targets = new Set<string>()
      if (agent) targets.add(agent)
      if (draft.leadName) targets.add(draft.leadName)
      if (targets.size === 0) targets.add(effectiveAgent)

      for (const targetAgent of targets) {
        ensureAgent(draft, targetAgent)
        const stream = draft.agentStreams[targetAgent]
        const alreadyHas = stream.currentBlocks.some(
          (b) => b.type === 'provider_status' && b.extra?.status === 'error' && (b.extra?.message === message || b.content === message)
        ) || stream.blocks.some(
          (b) => b.type === 'provider_status' && b.extra?.status === 'error' && (b.extra?.message === message || b.content === message)
        )
        if (!alreadyHas) {
          // The turn is over: nothing more streams in ahead of the error.
          commitLiveBlocks(draft, stream, Date.now())
          const errorBlock: ContentBlock = {
            id: generateBlockId(),
            type: 'provider_status',
            content: message,
            extra: {
              type: 'provider_status',
              status: 'error',
              title: title || 'Model error',
              message,
              code,
              details,
              category: 'provider',
            },
            timestamp: new Date(),
          }
          appendLocalBlocks(stream, [errorBlock])
        }
      }
    }
  })
}

export function onAgentNotConfigured(set: StoreSet, d: Record<string, unknown>) {
  const agent = d.agent as string
  set((draft) => {
    ensureAgent(draft, agent)
    draft.agentStreams[agent].status = 'error'
    draft.agentStreams[agent].lastError = d.message as string
    draft.setupRequired = {
      agent,
      message: d.message as string,
      action: (d.action as { type?: string; tab?: string } | undefined) ?? {},
    }
    draft.isAgentWorking = false
  })
}
