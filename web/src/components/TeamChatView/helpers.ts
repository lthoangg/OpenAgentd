/**
 * Small pure helpers shared across the TeamChatView hooks.
 *
 * Kept free of React/store imports so they stay trivially testable and so
 * every hook that needs them can import without pulling in extra deps.
 */
import { resolveApiUrl } from '@/api/client'
import type { MessageAttachment } from '@/api/types'
import type { SlashCommand } from '../InputBar'

/** Built-in slash commands always available, ahead of any user-defined ones. */
export const BASE_SLASH_COMMANDS: SlashCommand[] = [
  { id: 'stop', label: 'Stop', description: 'Stop all working agents' },
  { id: 'continue', label: 'Continue', description: 'Continue the last assistant response' },
  { id: 'compact', label: 'Compact', description: 'Summarize and compact this session' },
  { id: 'undo', label: 'Undo', description: 'Undo the previous message' },
  { id: 'redo', label: 'Redo', description: 'Restore all undone messages back to the live tip' },
  { id: 'new', label: 'New Chat', description: 'Start a fresh team conversation' },
  { id: 'init', label: 'Init', description: 'Create or update AGENTS.md for this project' },
]

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
