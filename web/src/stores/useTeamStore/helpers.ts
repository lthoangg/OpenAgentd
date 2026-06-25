import type { ContentBlock } from '@/api/types'
import type { AgentStream } from './types'

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

  let splitIdx = all.length
  for (let i = 0; i < all.length; i++) {
    const t = all[i].timestamp?.getTime() ?? 0
    if (t >= boundaryTime) {
      splitIdx = i
      break
    }
  }

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
    }))
    .filter((m) => m.content.trim().length > 0)
}
