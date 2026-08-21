import { rankFileRefs, type FileRef } from './InputComposer.mentions'
import type { SlashCommand, SnippetCommand } from './InputComposer'

export function buildHistoryEntries(
  localHistory: string[],
  historyPrompts: string[],
): string[] {
  const seen = new Set<string>()
  const entries: string[] = []
  for (const prompt of [...localHistory, ...historyPrompts]) {
    const trimmed = prompt.trim()
    if (!trimmed || seen.has(trimmed)) continue
    seen.add(trimmed)
    entries.push(trimmed)
  }
  return entries
}

export function filterSlashCommands(
  slashCommands: SlashCommand[],
  slashFilter: string | null,
): SlashCommand[] {
  if (slashFilter === null || slashCommands.length === 0) return []
  if (slashFilter === '') return slashCommands

  const matchedIds = new Set(
    slashCommands
      .filter(
        (cmd) =>
          !cmd.isSeparator &&
          (cmd.id.toLowerCase().includes(slashFilter) ||
            cmd.label.toLowerCase().includes(slashFilter) ||
            (cmd.displayName ?? '').toLowerCase().includes(slashFilter)),
      )
      .map((cmd) => cmd.id),
  )
  if (matchedIds.size === 0) return []

  const result: SlashCommand[] = []
  let pendingSeparator: SlashCommand | null = null
  for (const cmd of slashCommands) {
    if (cmd.isSeparator) {
      pendingSeparator = cmd
      continue
    }
    if (matchedIds.has(cmd.id)) {
      if (pendingSeparator) {
        result.push(pendingSeparator)
        pendingSeparator = null
      }
      result.push(cmd)
    }
  }
  return result
}

export function filterSnippetCommands(
  snippetCommands: SnippetCommand[],
  snippetRange: { start: number; end: number; query: string } | null,
): SnippetCommand[] {
  if (!snippetRange || snippetCommands.length === 0) return []
  return snippetCommands.filter((cmd) => {
    if (snippetRange.query === '') return true
    return (
      cmd.id.toLowerCase().includes(snippetRange.query) ||
      cmd.label.toLowerCase().includes(snippetRange.query)
    )
  })
}

const MENTION_MAX_RESULTS = 20

export function filterMentions(
  fileRefs: FileRef[],
  mentionRange: { start: number; end: number; query: string } | null,
): FileRef[] {
  if (!mentionRange || fileRefs.length === 0) return []
  return rankFileRefs(fileRefs, mentionRange.query, MENTION_MAX_RESULTS)
}
