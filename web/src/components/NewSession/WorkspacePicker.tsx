import { useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { Check, ChevronDown, Folder, FolderPlus, GitBranch, MessageCircle, Search } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import type { CodingWorkspaceTreeChat, CodingWorkspaceTreeRepository } from '@/api/types'
import { MENU_ITEM_CLASS, MENU_SEPARATOR_CLASS } from '@/components/ui/menu-styles'
import { sameWorkspacePath } from '@/utils/workspace'
import { hasFinePointer } from '@/lib/pointer'
import { hoverIntent } from '@/hooks/use-hover-intent'

interface PickerOption {
  path: string
  label: string
  kind: 'chat' | 'repo' | 'worktree'
}

function pickerOptions(chat: CodingWorkspaceTreeChat | null, repositories: readonly CodingWorkspaceTreeRepository[]): PickerOption[] {
  const options: PickerOption[] = []
  if (chat) options.push({ path: chat.path, label: chat.name, kind: 'chat' })
  for (const repo of repositories) {
    if (chat && sameWorkspacePath(repo.path, chat.path)) continue
    options.push({ path: repo.path, label: repo.name, kind: 'repo' })
    for (const worktree of repo.worktrees) options.push({ path: worktree.path, label: worktree.name, kind: 'worktree' })
  }
  return options
}

/**
 * The new-session screen's folder chip and its listbox: Chat, then each
 * repository with its worktrees indented, then Open folder…. Type to filter;
 * arrows, Enter and Escape work from the filter field.
 */
export function WorkspacePicker({
  workspace,
  label,
  isChat,
  chat,
  repositories,
  onSelect,
  onOpenFolder,
}: {
  workspace: string
  label: string
  isChat: boolean
  chat: CodingWorkspaceTreeChat | null
  repositories: readonly CodingWorkspaceTreeRepository[]
  onSelect: (path: string) => void
  onOpenFolder: () => void
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const listId = useId()
  const triggerRef = useRef<HTMLButtonElement>(null)
  const all = useMemo(() => pickerOptions(chat, repositories), [chat, repositories])
  const needle = query.trim().toLowerCase()
  const options = needle
    ? all.filter((option) => option.label.toLowerCase().includes(needle) || option.path.toLowerCase().includes(needle))
    : all
  // The rows the arrows walk: every option, then Open folder….
  const rowCount = options.length + 1
  const openFolderIndex = options.length
  const optionId = (index: number) => `${listId}-${index}`

  const close = () => {
    setOpen(false)
    triggerRef.current?.focus()
  }
  const choose = (index: number) => {
    setOpen(false)
    if (index === openFolderIndex) onOpenFolder()
    else if (options[index]) onSelect(options[index].path)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActiveIndex((index) => (index + 1) % rowCount)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActiveIndex((index) => (index - 1 + rowCount) % rowCount)
    } else if (event.key === 'Home') {
      event.preventDefault()
      setActiveIndex(0)
    } else if (event.key === 'End') {
      event.preventDefault()
      setActiveIndex(rowCount - 1)
    } else if (event.key === 'Enter') {
      event.preventDefault()
      choose(Math.min(activeIndex, rowCount - 1))
    } else if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      close()
    }
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (next) {
          setQuery('')
          const current = all.findIndex((option) => sameWorkspacePath(option.path, workspace))
          setActiveIndex(Math.max(0, current))
        }
      }}
    >
      <PopoverTrigger
        ref={triggerRef}
        aria-haspopup="listbox"
        aria-label={`Folder: ${label}. Change folder`}
        className="h-6 max-w-full items-center gap-1.5 rounded-full border border-(--color-border) bg-(--bg-card) pl-2 pr-1.5 text-(--color-text-2) transition-colors hover:bg-(--bg-key) hover:text-(--color-text) pointer-coarse:h-9 pointer-coarse:px-3"
      >
        {isChat
          ? <MessageCircle size={12} className="shrink-0 text-(--color-accent)" aria-hidden="true" />
          : <Folder size={12} className="shrink-0 text-(--color-accent)" aria-hidden="true" />}
        <span className={`min-w-0 truncate text-xs ${isChat ? '' : 'font-mono'}`}>{label}</span>
        <ChevronDown size={12} className="shrink-0 text-(--color-text-subtle)" aria-hidden="true" />
      </PopoverTrigger>
      <PopoverContent align="center" className="w-[min(18rem,calc(100vw-1rem))] gap-0 p-1">
        <div className="flex items-center gap-1.5 border-b border-(--color-border-subtle) px-2 pb-1.5 pt-1">
          <Search size={12} className="shrink-0 text-(--color-text-subtle)" aria-hidden="true" />
          <input
            autoFocus={hasFinePointer()}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value)
              setActiveIndex(0)
            }}
            onKeyDown={onKeyDown}
            placeholder="Filter folders…"
            aria-label="Filter folders"
            role="combobox"
            aria-expanded
            aria-controls={listId}
            aria-activedescendant={optionId(activeIndex)}
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            className="h-7 min-w-0 flex-1 bg-transparent text-xs text-(--color-text) outline-none placeholder:text-(--color-text-subtle)"
          />
        </div>
        <div id={listId} role="listbox" aria-label="Folders" className="max-h-72 overflow-y-auto pt-1">
          {options.length === 0 && (
            <p className="px-2 py-1.5 text-xs text-(--color-text-subtle)">No folder matches.</p>
          )}
          {options.map((option, index) => {
            const selected = sameWorkspacePath(option.path, workspace)
            return (
              <div
                key={option.path}
                id={optionId(index)}
                role="option"
                aria-selected={selected}
                title={option.kind === 'chat' ? undefined : option.path}
                {...hoverIntent(() => setActiveIndex(index))}
                onClick={() => choose(index)}
                className={`${MENU_ITEM_CLASS} ${index === activeIndex ? 'bg-(--bg-key) text-(--color-text)' : 'text-(--color-text-2)'} ${option.kind === 'worktree' ? 'pl-7' : ''}`}
              >
                {option.kind === 'chat' && <MessageCircle size={12} className="shrink-0 text-(--color-accent)" aria-hidden="true" />}
                {option.kind === 'repo' && <Folder size={12} className="shrink-0 text-(--color-accent)" aria-hidden="true" />}
                {option.kind === 'worktree' && <GitBranch size={12} className="shrink-0 text-(--accent-orange-text)" aria-hidden="true" />}
                <span className={`min-w-0 flex-1 truncate ${option.kind === 'chat' ? '' : 'font-mono'}`}>{option.label}</span>
                {selected && <Check size={12} className="shrink-0" aria-hidden="true" />}
              </div>
            )
          })}
          <div role="separator" className={MENU_SEPARATOR_CLASS} />
          <div
            id={optionId(openFolderIndex)}
            role="option"
            aria-selected={false}
            {...hoverIntent(() => setActiveIndex(openFolderIndex))}
            onClick={() => choose(openFolderIndex)}
            className={`${MENU_ITEM_CLASS} ${activeIndex === openFolderIndex ? 'bg-(--bg-key) text-(--color-text)' : 'text-(--color-text-2)'}`}
          >
            <FolderPlus size={12} className="shrink-0" aria-hidden="true" />
            Open folder…
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}
