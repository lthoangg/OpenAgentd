import type { MutableRefObject } from 'react'
import type { SlashCommand, SnippetCommand } from './InputBar'
import type { FileRef } from './InputBar.mentions'

export function InputBarSuggestions({
  minimized,
  slashMenuOpen,
  filteredSlashCommands,
  slashMenuId,
  selectableSlashCommands,
  slashOptionRefs,
  clampedIndex,
  onSlashSelect,
  snippetMenuOpen,
  filteredSnippetCommands,
  snippetMenuId,
  snippetOptionRefs,
  clampedSnippetIndex,
  onSnippetSelect,
  mentionMenuOpen,
  filteredMentions,
  mentionMenuId,
  mentionOptionRefs,
  clampedMentionIndex,
  onMentionSelect,
}: {
  minimized: boolean
  slashMenuOpen: boolean
  filteredSlashCommands: SlashCommand[]
  slashMenuId: string
  selectableSlashCommands: SlashCommand[]
  slashOptionRefs: MutableRefObject<(HTMLButtonElement | null)[]>
  clampedIndex: number
  onSlashSelect: (cmd: SlashCommand) => void
  snippetMenuOpen: boolean
  filteredSnippetCommands: SnippetCommand[]
  snippetMenuId: string
  snippetOptionRefs: MutableRefObject<(HTMLButtonElement | null)[]>
  clampedSnippetIndex: number
  onSnippetSelect: (cmd: SnippetCommand) => void
  mentionMenuOpen: boolean
  filteredMentions: FileRef[]
  mentionMenuId: string
  mentionOptionRefs: MutableRefObject<(HTMLButtonElement | null)[]>
  clampedMentionIndex: number
  onMentionSelect: (ref: FileRef) => void
}) {
  if (minimized) return null
  const renderCommandLabel = (cmd: SlashCommand | SnippetCommand) => {
    const label = ('displayName' in cmd && cmd.displayName) ? cmd.displayName : cmd.label
    const colonIndex = label.indexOf(':')
    if (colonIndex === -1) return label
    return (
      <>
        <span>{label.slice(0, colonIndex + 1)}</span>
        <span>{label.slice(colonIndex + 1)}</span>
      </>
    )
  }

  return (
    <>
      {slashMenuOpen && filteredSlashCommands.length > 0 && (
        <div id={slashMenuId} role="listbox" aria-label="Slash commands" className="absolute bottom-full left-0 right-0 z-10 mb-1 max-h-64 overflow-y-auto rounded-lg border border-(--color-border-strong) bg-(--color-surface) shadow-md">
          {filteredSlashCommands.map((cmd) => {
            if ('isSeparator' in cmd && cmd.isSeparator) {
              return (
                <div key={cmd.id} className="px-3 pt-3 pb-1 text-[10px] font-semibold uppercase tracking-wide text-(--color-text-muted)">{cmd.label}</div>
              )
            }
            const idx = selectableSlashCommands.findIndex((item) => item.id === cmd.id)
            const active = idx === clampedIndex
            return (
              <button
                key={cmd.id}
                id={`${slashMenuId}-option-${idx}`}
                ref={(el) => { if (idx >= 0) slashOptionRefs.current[idx] = el }}
                type="button"
                role="option"
                aria-selected={active}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => onSlashSelect(cmd)}
                className={`flex w-full items-start gap-2 px-3 py-2 text-left transition-colors ${active ? 'bg-(--bg-key)' : 'hover:bg-(--bg-key)/70'}`}
              >
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium text-(--color-text)">{renderCommandLabel(cmd)}</span>
                  <span className="block text-xs text-(--color-text-muted)">{cmd.description}</span>
                </span>
              </button>
            )
          })}
        </div>
      )}
      {mentionMenuOpen && filteredMentions.length > 0 && (
        <div id={mentionMenuId} role="listbox" aria-label="Reference workspace file" className="absolute bottom-full left-0 right-0 z-10 mb-1 max-h-64 overflow-y-auto rounded-lg border border-(--color-border-strong) bg-(--color-surface) shadow-md">
          {filteredMentions.map((ref, index) => {
            const active = index === clampedMentionIndex
            return (
              <button key={ref.path} id={`${mentionMenuId}-option-${index}`} ref={(el) => { mentionOptionRefs.current[index] = el }} type="button" role="option" aria-selected={active} onMouseDown={(e) => e.preventDefault()} onClick={() => onMentionSelect(ref)} className={`flex w-full items-center gap-2 px-3 py-2 text-left transition-colors ${active ? 'bg-(--bg-key)' : 'hover:bg-(--bg-key)/70'}`}>
                <span className="truncate text-sm text-(--color-text)">{ref.type === 'directory' ? `${ref.path}/` : ref.path}</span>
              </button>
            )
          })}
        </div>
      )}
      {snippetMenuOpen && filteredSnippetCommands.length > 0 && (
        <div id={snippetMenuId} role="listbox" aria-label="Snippets" className="absolute bottom-full left-0 right-0 z-10 mb-1 max-h-64 overflow-y-auto rounded-lg border border-(--color-border-strong) bg-(--color-surface) shadow-md">
          {filteredSnippetCommands.map((cmd, index) => {
            const active = index === clampedSnippetIndex
            return (
              <button key={cmd.id} id={`${snippetMenuId}-option-${index}`} ref={(el) => { snippetOptionRefs.current[index] = el }} type="button" role="option" aria-selected={active} onMouseDown={(e) => e.preventDefault()} onClick={() => onSnippetSelect(cmd)} className={`flex w-full items-start gap-2 px-3 py-2 text-left transition-colors ${active ? 'bg-(--bg-key)' : 'hover:bg-(--bg-key)/70'}`}>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-medium text-(--color-text)">{renderCommandLabel(cmd)}</span>
                  <span className="block text-xs text-(--color-text-muted)">{cmd.description}</span>
                </span>
              </button>
            )
          })}
        </div>
      )}
    </>
  )
}
