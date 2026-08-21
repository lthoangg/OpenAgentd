/**
 * Small pure helpers shared across the TeamChatView hooks.
 *
 * Kept free of React/store imports so they stay trivially testable and so
 * every hook that needs them can import without pulling in extra deps.
 */
import { resolveApiUrl } from '@/api/client'
import type { MessageAttachment } from '@/api/types'
import type { SlashCommand } from '../InputComposer'

/** Built-in slash commands always available, ahead of any user-defined ones. */
export const BASE_SLASH_COMMANDS: SlashCommand[] = [
  { id: 'stop', label: 'Stop', description: 'Stop all working agents' },
  { id: 'compact', label: 'Compact', description: 'Summarize and compact this session' },
  { id: 'undo', label: 'Undo', description: 'Undo the previous message' },
  { id: 'redo', label: 'Redo', description: 'Redo the next undone message' },
  { id: 'redo-all', label: 'Redo All', description: 'Restore all undone messages back to the live tip' },
  { id: 'new', label: 'New Chat', description: 'Start a fresh team conversation' },
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

export interface FilterSlashCommandsContext {
  isTeamWorking?: boolean
  revertedCount?: number
  hasVisibleMessages?: boolean
  mode?: 'normal' | 'coding'
  hasWorkspace?: boolean
}

/** Filter built-in slash commands to only those contextually relevant right now. */
export function filterBaseSlashCommands(ctx: FilterSlashCommandsContext): SlashCommand[] {
  const isWorking = ctx.isTeamWorking ?? false
  const revertedCount = ctx.revertedCount ?? 0
  const hasVisible = ctx.hasVisibleMessages ?? false
  const isCoding = ctx.mode === 'coding' && (ctx.hasWorkspace ?? false)

  return BASE_SLASH_COMMANDS.filter((cmd) => {
    switch (cmd.id) {
      case 'stop':
        return isWorking
      case 'undo':
      case 'compact':
        return hasVisible && !isWorking
      case 'redo':
      case 'redo-all':
        return revertedCount > 0 && !isWorking
      case 'init':
        return isCoding
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
