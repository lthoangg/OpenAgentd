import type { MutableRefObject } from 'react'
import { File, Folder } from 'lucide-react'
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
  const slashDisplayParts = (cmd: SlashCommand) => {
    const displayName = cmd.displayName ?? cmd.id
    const colon = displayName.indexOf(':')
    return {
      prefix: colon === -1 ? '' : displayName.slice(0, colon + 1),
      suffix: colon === -1 ? displayName : displayName.slice(colon + 1),
    }
  }

  return (
    <>
      {slashMenuOpen && filteredSlashCommands.length > 0 && (
        <div id={slashMenuId} role="listbox" aria-label="Slash commands" className="absolute bottom-full left-0 right-0 z-10 mb-1 max-h-64 overflow-y-auto overscroll-contain rounded-lg border border-(--color-border-strong) bg-(--color-surface) shadow-md">
          {filteredSlashCommands.map((cmd) => {
            if ('isSeparator' in cmd && cmd.isSeparator) {
              return (
                <div key={cmd.id} className="px-3 pt-3 pb-1 text-[10px] font-semibold uppercase tracking-wide text-(--color-text-muted)">{cmd.label}</div>
              )
            }
            const idx = selectableSlashCommands.findIndex((item) => item.id === cmd.id)
            const active = idx === clampedIndex
            const { prefix, suffix } = slashDisplayParts(cmd)
            return (
              <button
                key={cmd.id}
                id={`${slashMenuId}-option-${idx}`}
                ref={(el) => { if (idx >= 0) slashOptionRefs.current[idx] = el }}
                type="button"
                role="option"
                aria-selected={active}
                onMouseDown={(e) => { e.preventDefault(); onSlashSelect(cmd) }}
                className={`flex w-full items-center gap-3 px-3 py-2 text-left text-sm transition-colors ${active ? 'bg-(--bg-key) text-(--color-text)' : 'text-(--color-text-muted) hover:bg-(--bg-key)'}`}
              >
                <span className="shrink-0 font-mono text-xs text-(--color-accent)">
                  /
                  {prefix && <span className="text-(--color-text-muted)">{prefix}</span>}
                  <span>{suffix}</span>
                </span>
                <span className="min-w-0 flex-1 truncate text-(--color-text-2)">
                  {cmd.description}
                </span>
                {cmd.category && (
                  <span className="shrink-0 rounded-md bg-(--bg-key) px-1.5 py-0.5 font-mono text-[10px] text-(--color-text-muted) ring-1 ring-(--color-border)">
                    {cmd.category}
                  </span>
                )}
              </button>
            )
          })}
        </div>
      )}
      {mentionMenuOpen && filteredMentions.length > 0 && (
        <div id={mentionMenuId} role="listbox" aria-label="Reference workspace file" className="absolute bottom-full left-0 right-0 z-10 mb-1 max-h-64 overflow-y-auto overscroll-contain rounded-lg border border-(--color-border-strong) bg-(--color-surface) shadow-md">
          {filteredMentions.map((ref, index) => {
            const active = index === clampedMentionIndex
            const isDir = ref.type === 'directory'
            const slash = ref.path.lastIndexOf('/')
            const parent = slash === -1 ? '' : ref.path.slice(0, slash + 1)
            const basename = slash === -1 ? ref.path : ref.path.slice(slash + 1)
            return (
              <button key={`${ref.type}:${ref.path}`} id={`${mentionMenuId}-option-${index}`} ref={(el) => { mentionOptionRefs.current[index] = el }} type="button" role="option" aria-selected={active} onMouseDown={(e) => { e.preventDefault(); onMentionSelect(ref) }} className={`flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm transition-colors ${active ? 'bg-(--bg-key) text-(--color-text)' : 'text-(--color-text-muted) hover:bg-(--bg-key)'}`}>
                {isDir ? (
                  <Folder className="size-4 shrink-0 text-(--color-accent)" aria-hidden />
                ) : (
                  <File className="size-4 shrink-0 text-(--color-text-subtle)" aria-hidden />
                )}
                <span className="min-w-0 flex-1 truncate font-mono text-xs">
                  {parent && <span className="text-(--color-text-subtle)">{parent}</span>}
                  <span className="text-(--color-text)">{basename}</span>
                  {isDir && <span className="text-(--color-text-subtle)">/</span>}
                </span>
              </button>
            )
          })}
        </div>
      )}
      {snippetMenuOpen && filteredSnippetCommands.length > 0 && (
        <div id={snippetMenuId} role="listbox" aria-label="Snippets" className="absolute bottom-full left-0 right-0 z-10 mb-1 max-h-64 overflow-y-auto overscroll-contain rounded-lg border border-(--color-border-strong) bg-(--color-surface) shadow-md">
          {filteredSnippetCommands.map((cmd, index) => {
            const active = index === clampedSnippetIndex
            return (
              <button key={cmd.id} id={`${snippetMenuId}-option-${index}`} ref={(el) => { snippetOptionRefs.current[index] = el }} type="button" role="option" aria-selected={active} onMouseDown={(e) => { e.preventDefault(); onSnippetSelect(cmd) }} className={`flex w-full items-center gap-3 px-3 py-2 text-left text-sm transition-colors ${active ? 'bg-(--bg-key) text-(--color-text)' : 'text-(--color-text-muted) hover:bg-(--bg-key)'}`}>
                <span className="shrink-0 font-mono text-xs text-(--color-accent)">#{cmd.label}</span>
                <span className="min-w-0 flex-1 truncate text-(--color-text-2)">{cmd.description}</span>
                {cmd.category && (
                  <span className="shrink-0 rounded-md bg-(--bg-key) px-1.5 py-0.5 font-mono text-[10px] text-(--color-text-muted) ring-1 ring-(--color-border)">
                    {cmd.category}
                  </span>
                )}
              </button>
            )
          })}
        </div>
      )}
    </>
  )
}
