/**
 * Small pure helpers shared across the AgentChatView hooks.
 *
 * Kept free of React/store imports so they stay trivially testable and so
 * every hook that needs them can import without pulling in extra deps.
 */
import { resolveApiUrl } from '@/api/client'
import type { ContentBlock, MessageAttachment } from '@/api/types'
import { isDirectUserBlock } from '@/stores/useAgentStore/helpers'
import { workspaceRelativePath } from '@/utils/file-refs'
import type { SlashCommand } from '../InputComposer'
import { patchFileStats } from '../ToolCall/diffUtils'

/** Built-in slash commands always available, ahead of any user-defined ones. */
export const BASE_SLASH_COMMANDS: SlashCommand[] = [
  { id: 'stop', label: 'Stop', description: 'Stop all working agents' },
  {
    id: 'btw',
    label: 'BTW',
    description: 'Ask a side question without adding it to the chat',
    keepInputOpen: true,
    insertText: 'btw',
  },
  { id: 'compact', label: 'Compact', description: 'Summarize and compact this session' },
  { id: 'undo', label: 'Undo', description: 'Undo the previous message' },
  { id: 'redo', label: 'Redo', description: 'Redo the next undone message' },
  { id: 'redo-all', label: 'Redo All', description: 'Restore all undone messages back to the live tip' },
  { id: 'new', label: 'New Chat', description: 'Start a fresh agent conversation' },
  { id: 'init', label: 'Init', description: 'Create or update AGENTS.md for this project' },
]

export const BUILT_IN_SLASH_COMMAND_IDS = new Set<string>(
  BASE_SLASH_COMMANDS.map((cmd) => cmd.id).concat(['redo_all']),
)

/** Extract and normalize a built-in slash command from user input, or return null. */
export function parseBuiltInSlashCommand(content: string): string | null {
  const trimmed = content.trim()
  if (!trimmed.startsWith('/')) return null
  const command = trimmed.slice(1).trim().toLowerCase()
  if (command === 'redo_all') return 'redo-all'
  return BUILT_IN_SLASH_COMMAND_IDS.has(command) ? command : null
}

/**
 * The question of a ``/btw`` side question: ``''`` for a bare ``/btw``
 * (reopen the panel), ``null`` when ``content`` is not one.
 */
export function parseBtwCommand(content: string): string | null {
  const match = /^\s*\/btw(?:\s+([\s\S]*))?$/i.exec(content)
  return match ? (match[1] ?? '').trim() : null
}

export type BtwSubmit =
  | { kind: 'not-btw' }
  /** Refused: the draft goes back to the composer. */
  | { kind: 'no-session' }
  | { kind: 'attachments' }
  | { kind: 'reopen' }
  | { kind: 'ask'; question: string }

/** What submitting ``content`` from the composer means for ``/btw``. */
export function btwSubmit(content: string, files: readonly File[] | undefined, sessionId: string | null): BtwSubmit {
  const question = parseBtwCommand(content)
  if (question === null) return { kind: 'not-btw' }
  if (!sessionId) return { kind: 'no-session' }
  if (files && files.length > 0) return { kind: 'attachments' }
  return question ? { kind: 'ask', question } : { kind: 'reopen' }
}

/**
 * What composer ↑/↓ steps through, newest first: prompts the user wrote.
 * Sub-agent reports arrive as ``user`` blocks too, but recalling one would
 * put another agent's words in the user's mouth.
 */
export function composerHistoryPrompts(blocks: readonly ContentBlock[]): string[] {
  const prompts: string[] = []
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (isDirectUserBlock(blocks[i]) && blocks[i].content.trim()) prompts.push(blocks[i].content)
  }
  return prompts
}

/**
 * The newest user block with ``prompt``'s text, compared trimmed as composer
 * history dedupes it, so a recalled prompt maps to the one it came from.
 */
export function newestUserBlockId(blocks: readonly ContentBlock[], prompt: string): string | undefined {
  const text = prompt.trim()
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (isDirectUserBlock(blocks[i]) && blocks[i].content.trim() === text) return blocks[i].id
  }
  return undefined
}

/** ``read`` takes its path under any of these names. */
const READ_PATH_KEYS = ['path', 'file_path', 'filename', 'filepath'] as const

function toolPaths(block: ContentBlock): string[] {
  if (block.type !== 'tool') return []
  if (block.toolName === 'patch') return patchFileStats(block.toolArgs).map((file) => file.path)
  if (block.toolName !== 'read' || !block.toolArgs) return []
  try {
    const args = JSON.parse(block.toolArgs) as Record<string, unknown> | null
    const path = READ_PATH_KEYS.map((key) => args?.[key]).find((value) => typeof value === 'string')
    return typeof path === 'string' ? [path] : []
  } catch {
    return []
  }
}

/**
 * Workspace files the session's agents read or patched, newest first, each
 * once. The lead's come before its members', since the reply being read is
 * usually the lead's.
 */
export function sessionTouchedPaths(
  streams: Readonly<Record<string, { blocks: readonly ContentBlock[]; currentBlocks: readonly ContentBlock[] }>>,
  leadName: string | null,
  workspace: string,
): string[] {
  const names = Object.keys(streams).sort((a, b) => Number(b === leadName) - Number(a === leadName))
  const touched = new Set<string>()
  for (const name of names) {
    const blocks = [...streams[name].blocks, ...streams[name].currentBlocks]
    for (let i = blocks.length - 1; i >= 0; i--) {
      for (const path of toolPaths(blocks[i])) {
        const relative = workspaceRelativePath(path, workspace)
        if (relative) touched.add(relative)
      }
    }
  }
  return [...touched]
}

export interface FilterSlashCommandsContext {
  isAgentWorking?: boolean
  revertedCount?: number
  hasVisibleMessages?: boolean
  /** The lead has blocks of a turn still running (a new session's first turn has only these). */
  hasLiveMessages?: boolean
  hasWorkspace?: boolean
}

/** Filter built-in slash commands to only those contextually relevant right now. */
export function filterBaseSlashCommands(ctx: FilterSlashCommandsContext): SlashCommand[] {
  const isWorking = ctx.isAgentWorking ?? false
  const revertedCount = ctx.revertedCount ?? 0
  const hasVisible = ctx.hasVisibleMessages ?? false
  const hasLive = ctx.hasLiveMessages ?? false
  const inWorkspace = ctx.hasWorkspace ?? false

  return BASE_SLASH_COMMANDS.filter((cmd) => {
    switch (cmd.id) {
      case 'stop':
        return isWorking
      case 'btw':
        // Answers from the session's context, so it needs some; works mid-turn,
        // including a new session's first turn, whose blocks are all live.
        return hasVisible || hasLive
      case 'undo':
      case 'compact':
        return hasVisible && !isWorking
      case 'redo':
      case 'redo-all':
        return revertedCount > 0 && !isWorking
      case 'init':
        return inWorkspace
      case 'new':
        return true
      default:
        return true
    }
  })
}

/** Re-fetch a message attachment as a ``File`` so it can be restored into the composer. */
export async function attachmentToFile(att: MessageAttachment): Promise<File | null> {
  const url = resolveApiUrl(att.url)
  if (!url) return null
  const res = await fetch(url)
  if (!res.ok) return null
  const blob = await res.blob()
  return new File(
    [blob],
    att.original_name ?? att.filename ?? 'attachment',
    { type: att.media_type ?? blob.type },
  )
}
