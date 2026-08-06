import type { ContentBlock } from '@/api/types'
import type { AgentStream } from './types'

/**
 * Statuses that mean "this agent's turn has not ended yet".
 *
 * Mirrors ``BUSY_STATES`` in ``app/agent/mode/team/member.py``: a lead suspended
 * on ``ask_user_question`` emits no tokens but must still read as live, or the
 * UI would look finished with a question card still on screen.
 */
const LIVE_STATUSES: ReadonlySet<AgentStream['status']> = new Set(['working', 'waiting_input'])

export function isLiveStatus(status: AgentStream['status']): boolean {
  return LIVE_STATUSES.has(status)
}

/** True when any agent in the map is still mid-turn. */
export function anyAgentLive(streams: Record<string, AgentStream>): boolean {
  return Object.values(streams).some((s) => isLiveStatus(s.status))
}

/**
 * Append locally-produced blocks to ``stream.blocks`` and tag them unsynced so
 * ``reconcileTurnTail`` swaps exactly these for the server's canonical rows
 * instead of appending them a second time.
 */
export function appendLocalBlocks(stream: AgentStream, blocks: ContentBlock[]) {
  if (blocks.length === 0) return
  stream.blocks = [...stream.blocks, ...blocks]
  stream._unsyncedBlockIds = [...(stream._unsyncedBlockIds ?? []), ...blocks.map((b) => b.id)]
}

/**
 * Apply an append-only transform to ``stream.blocks``, tagging whatever it
 * added as unsynced.
 *
 * The new blocks are identified by length delta, which holds only because
 * every caller (``startCompaction`` / ``endCompaction``) either appends or
 * edits in place — never removes or reorders. Keep that contract if you touch
 * those helpers.
 */
export function applyLocalBlockTransform(
  stream: AgentStream,
  transform: (blocks: ContentBlock[]) => ContentBlock[],
) {
  const before = stream.blocks.length
  const next = transform(stream.blocks)
  stream.blocks = next
  if (next.length > before) {
    stream._unsyncedBlockIds = [
      ...(stream._unsyncedBlockIds ?? []),
      ...next.slice(before).map((b) => b.id),
    ]
  }
}

export const FS_MUTATING_TOOLS = new Set([
  'write',
  'edit',
  'rm',
  'patch',
  'shell',
  'bg',
  'generate_image',
  'generate_video',
])

export const SCHEDULER_MUTATING_TOOLS = new Set(['schedule_task'])

export const TODO_MUTATING_TOOLS = new Set(['todo_manage'])

const PATH_BEARING_TOOLS = new Set(['write', 'edit', 'rm', 'patch'])

const PATCH_PATH_RE = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm

export function extractToolPaths(
  toolName: string,
  toolArgs: string | undefined,
): string[] | null {
  if (!toolArgs || !PATH_BEARING_TOOLS.has(toolName)) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(toolArgs)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null

  if (toolName === 'patch') {
    const text = (parsed as { patch_text?: unknown }).patch_text
    if (typeof text !== 'string') return null
    const paths: string[] = []
    for (const match of text.matchAll(PATCH_PATH_RE)) {
      const p = match[1]?.trim()
      if (p) paths.push(p)
    }
    return paths.length > 0 ? paths : null
  }

  const p = (parsed as { path?: unknown }).path
  if (typeof p !== 'string') return null
  const trimmed = p.trim()
  return trimmed ? [trimmed] : null
}

export function revokeBlobUrlsFromBlocks(blocks: ContentBlock[]) {
  for (const block of blocks) {
    if (block.attachments) {
      for (const att of block.attachments) {
        if (att.url?.startsWith('blob:')) {
          URL.revokeObjectURL(att.url)
        }
      }
    }
  }
}

export function applyRevertBoundary(
  stream: AgentStream,
  boundaryTime: number | null,
  options: {
    includeCurrent?: boolean
    boundaryId?: string | null
    boundaryContent?: string | null
  } = {},
): void {
  const current = options.includeCurrent ? stream.currentBlocks : []
  const all = [...stream.blocks, ...current, ...(stream._revertedSuffix ?? [])]
  if (options.includeCurrent) {
    // Late SSE deltas (text/thinking) arriving after the revert would
    // otherwise re-seed currentBlocks via appendText/appendThinking and
    // surface as a ghost message. Drop the in-flight scratch state so
    // any straggler tokens land on a clean slate.
    stream.currentBlocks = []
    stream.currentText = ''
    stream.currentThinking = ''
    stream.status = 'idle'
  }

  if (boundaryTime === null) {
    stream.blocks = all
    stream._revertedSuffix = []
    stream.revertedCount = 0
    stream.revertedMessages = []
    return
  }

  // First block at or after the boundary. Only the *crossing point* is derived
  // from timestamps; everything after it is reverted positionally. That is what
  // makes the scan safe for in-flight blocks, which carry no timestamp until
  // `done` stamps them: an unstamped block reads as t=0, but it trails a stamped
  // one in append order, so the split lands before it either way.
  let splitIdx = all.length
  for (let i = 0; i < all.length; i++) {
    const t = all[i].timestamp?.getTime() ?? 0
    if (t >= boundaryTime) {
      splitIdx = i
      break
    }
  }

  // The two boundary hints are deliberately NOT symmetric — do not "unify" them.
  //
  // `boundaryId` is the server's own row id: authoritative, so it overwrites the
  // timestamp guess outright and may widen the visible range. Optimistic client
  // timestamps on queued messages routinely sit *after* a server boundary, and
  // clamping with Math.min would then revert messages the server kept.
  //
  // `boundaryContent` is only a content-equality heuristic, so it may tighten
  // the split but never widen it: an identical earlier message would otherwise
  // swallow rows that belong to the live tip.
  if (options.boundaryId) {
    const idx = all.findIndex((block) => block.id === options.boundaryId)
    if (idx >= 0) {
      splitIdx = idx
    } else if (options.boundaryContent) {
      for (let i = all.length - 1; i >= 0; i--) {
        const block = all[i]
        if (block.type === 'user' && block.content === options.boundaryContent) {
          splitIdx = Math.min(splitIdx, i)
          break
        }
      }
    }
  } else if (options.boundaryContent) {
    for (let i = all.length - 1; i >= 0; i--) {
      const block = all[i]
      if (block.type === 'user' && block.content === options.boundaryContent) {
        splitIdx = Math.min(splitIdx, i)
        break
      }
    }
  }

  const visible = all.slice(0, splitIdx)
  const reverted = all.slice(splitIdx)
  stream.blocks = visible
  stream._revertedSuffix = reverted

  const userBlocks = reverted.filter(
    (b) => b.type === 'user' || b.type === 'compaction',
  )
  stream.revertedCount = userBlocks.length
  stream.revertedMessages = userBlocks
    .map((b) => ({
      role: 'user',
      content: b.type === 'compaction' ? 'Session compacted' : (b.content ?? ''),
      attachments: b.type === 'user' ? b.attachments : undefined,
    }))
    .filter((m) => m.content.trim().length > 0 || (m.attachments && m.attachments.length > 0))
}
