/**
 * The plan as the lead's running ``plan`` call will leave it, so the Plan tab
 * can show it being written in place rather than only after the call ends.
 *
 * The call's arguments stream in as partial JSON. A ``write`` shows its
 * ``content`` so far; an ``edit`` applies its replacements to the plan as it
 * stood when the call started, the way the server will (in order, each old
 * text matching exactly once), the one still streaming with its partial new
 * text.
 */
import { useMemo, useState } from 'react'
import type { ContentBlock, SessionPlan } from '@/api/types'
import { useAgentStore } from '@/stores/useAgentStore'
import { isFailedResult } from '../ToolCall/toolResultStatus'

/** Matches ``appv3_agent::tools::plan::PLAN_TOOL``. */
export const PLAN_TOOL = 'plan'

type Closer = '}' | ']'
interface Frame {
  close: Closer
  /** An object waiting for a key (after ``{`` or ``,``). */
  expectsKey: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function closers(stack: Frame[]): string {
  let out = ''
  for (let i = stack.length - 1; i >= 0; i--) out += stack[i].close
  return out
}

/**
 * ``text`` cut and closed into valid JSON: a value string still streaming is
 * kept (minus an escape cut in half); anything else unfinished — a key, a key
 * waiting for its value, a bare number — is dropped back to the last complete
 * value.
 */
function completePartialJson(text: string): string | null {
  const stack: Frame[] = []
  // The longest prefix that closes into valid JSON, and its closers.
  let clean: { at: number; close: string } | null = null
  let inString = false
  let stringIsKey = false
  let stringStart = 0
  // Index of the backslash opening an escape still being read, else -1.
  let escapeAt = -1

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escapeAt >= 0) {
        // ``\uXXXX`` ends after four hex digits; every other escape after one char.
        if (text[escapeAt + 1] !== 'u' || i - escapeAt >= 5) escapeAt = -1
      } else if (ch === '\\') {
        escapeAt = i
      } else if (ch === '"') {
        inString = false
        if (!stringIsKey) clean = { at: i + 1, close: closers(stack) }
      }
      continue
    }
    const top = stack[stack.length - 1]
    if (ch === '"') {
      inString = true
      stringStart = i
      stringIsKey = top?.close === '}' && top.expectsKey
    } else if (ch === '{' || ch === '[') {
      stack.push({ close: ch === '{' ? '}' : ']', expectsKey: ch === '{' })
      clean = { at: i + 1, close: closers(stack) }
    } else if (ch === '}' || ch === ']') {
      stack.pop()
      clean = { at: i + 1, close: closers(stack) }
    } else if (ch === ',') {
      clean = { at: i, close: closers(stack) }
      if (top?.close === '}') top.expectsKey = true
    } else if (ch === ':') {
      if (top) top.expectsKey = false
    }
  }

  if (inString && !stringIsKey && stringStart > 0) {
    const body = escapeAt >= 0 ? text.slice(0, escapeAt) : text
    return `${body}"${closers(stack)}`
  }
  return clean ? text.slice(0, clean.at) + clean.close : null
}

/** A JSON object that may still be streaming, or ``null`` if it is not one. */
export function parsePartialObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim()
  if (!trimmed.startsWith('{')) return null
  for (const candidate of [trimmed, completePartialJson(trimmed)]) {
    if (candidate === null) continue
    try {
      const parsed: unknown = JSON.parse(candidate)
      if (isRecord(parsed)) return parsed
    } catch {
      // Unfinished: try the completed form.
    }
  }
  return null
}

function countOf(text: string, needle: string): number {
  return text.split(needle).length - 1
}

export interface LivePlanContent {
  action: 'write' | 'edit' | null
  /** The plan so far; ``null`` while there is nothing to show over it yet. */
  content: string | null
}

/** The plan the ``plan`` call's ``args`` (possibly partial) leave over ``base``. */
export function livePlanContent(args: string | undefined, base: string): LivePlanContent {
  const parsed = parsePartialObject(args ?? '')
  if (!parsed) return { action: null, content: null }
  const action = parsed.action === 'edit' || parsed.action === 'write'
    ? parsed.action
    : Array.isArray(parsed.edits) ? 'edit' : typeof parsed.content === 'string' ? 'write' : null

  if (action === 'write') {
    return { action, content: typeof parsed.content === 'string' && parsed.content ? parsed.content : null }
  }
  if (action !== 'edit') return { action: null, content: null }

  let text = base
  for (const item of Array.isArray(parsed.edits) ? parsed.edits : []) {
    if (!isRecord(item)) break
    const { old, new: replacement } = item
    // No ``new`` yet means ``old`` may still be streaming.
    if (typeof old !== 'string' || !old || typeof replacement !== 'string') break
    if (countOf(text, old) !== 1) break
    const at = text.indexOf(old)
    text = text.slice(0, at) + replacement + text.slice(at + old.length)
  }
  return { action, content: text }
}

interface LivePlanState {
  sessionId: string | null
  leadName: string | null
  agentStreams: Record<string, { currentBlocks: ContentBlock[] } | undefined>
}

/** The lead's newest ``plan`` call in the current turn of ``sessionId``. */
export function selectLivePlanBlock(state: LivePlanState, sessionId: string | null): ContentBlock | null {
  if (!sessionId || state.sessionId !== sessionId || !state.leadName) return null
  const blocks = state.agentStreams[state.leadName]?.currentBlocks ?? []
  for (let i = blocks.length - 1; i >= 0; i--) {
    const block = blocks[i]
    if (block.type === 'tool' && block.toolName === PLAN_TOOL) return block
  }
  return null
}

/** The id of the lead's ``plan`` call still running, if any. */
export function selectRunningPlanCallId(state: LivePlanState): string | null {
  const block = selectLivePlanBlock(state, state.sessionId)
  return block && !block.toolDone ? (block.toolCallId ?? block.id) : null
}

export interface LivePlan extends LivePlanContent {
  /** The call is still streaming or running. */
  writing: boolean
}

function samePlan(a: SessionPlan | null, b: SessionPlan | null): boolean {
  if (!a || !b) return a === b
  return a.revision === b.revision && a.updated_at === b.updated_at
}

/**
 * The plan to show over ``plan`` while the lead writes it, or ``null``.
 *
 * A call first seen running is followed to the end; once it succeeds its
 * result stays on screen until the refetched plan replaces the one it started
 * from, so the tab does not flash back to the old plan (a write that changed
 * nothing keeps the revision, so matching content ends it too). A failed
 * call, or one first seen already finished, shows nothing over the saved plan.
 */
export function useLivePlan(plan: SessionPlan | null, sessionId: string | null): LivePlan | null {
  const block = useAgentStore((state) => selectLivePlanBlock(state, sessionId))
  const callId = block ? (block.toolCallId ?? block.id) : null
  const [tracked, setTracked] = useState<{ callId: string; base: SessionPlan | null; followed: boolean } | null>(null)
  if (callId !== (tracked?.callId ?? null)) {
    setTracked(callId ? { callId, base: plan, followed: !block?.toolDone } : null)
  }
  const followed = Boolean(block && tracked?.followed && tracked.callId === callId)
  const toolArgs = block?.toolArgs
  const baseContent = tracked?.base?.content ?? ''
  // Only a new chunk of the call changes this; other renders of the tab reuse it.
  const live = useMemo(
    () => (followed ? livePlanContent(toolArgs, baseContent) : null),
    [followed, toolArgs, baseContent],
  )
  if (!block || !tracked || !live) return null

  const writing = !block.toolDone
  const succeeded = Boolean(block.toolResult) && !isFailedResult(block.toolResult)
  if (!writing && !(succeeded && samePlan(plan, tracked.base))) return null
  if (!writing && live.content?.trim() === plan?.content.trim()) return null
  return { ...live, writing }
}
