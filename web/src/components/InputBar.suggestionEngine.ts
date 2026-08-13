/**
 * Suggestion-menu engine for InputBar — owns the state, filtering, and
 * commit actions for all three picker menus (slash commands, `@`-mentions,
 * `#`-snippets).
 *
 * Only one menu can ever be open at a time (mention > snippet > slash
 * precedence — the ranges are mutually exclusive by construction in
 * InputBar's handleChange/syncMention), so the engine models the open menu
 * as a single discriminated union (`SuggestionMenu`) plus one
 * highlighted-index state, instead of three parallel copies of the
 * index/refs/open/commit machinery.
 *
 * Split out of InputBar.tsx (not `.tsx` itself — react-refresh forbids
 * non-component runtime exports from `.tsx` files) so the component only
 * has to wire this hook's output into `<InputBarSuggestions>` (the render
 * half, in `InputBar.suggestions.tsx`) and into its own `handleKeyDown` /
 * `handleChange` for keyboard navigation and the active-mention window.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import type { SlashCommand, SnippetCommand } from './InputBar'
import type { FileRef } from './InputBar.mentions'
import {
  filterMentions,
  filterSlashCommands,
  filterSnippetCommands,
} from './InputBar.menus'

export type SuggestionRange = { start: number; end: number; query: string } | null

/**
 * The currently open picker menu. ``rows`` is what gets rendered (for slash
 * menus this includes non-interactive separator rows); ``selectable`` is what
 * keyboard navigation cycles through (rows minus separators).
 */
export type SuggestionMenu =
  | { kind: 'slash'; id: string; rows: SlashCommand[]; selectable: SlashCommand[] }
  | { kind: 'snippet'; id: string; rows: SnippetCommand[]; selectable: SnippetCommand[] }
  | { kind: 'mention'; id: string; rows: FileRef[]; selectable: FileRef[] }

export type SuggestionRow = SlashCommand | SnippetCommand | FileRef

export interface UseInputBarSuggestionEngineOptions {
  value: string
  setValue: Dispatch<SetStateAction<string>>
  textareaRef: React.RefObject<HTMLTextAreaElement | null>
  resize: () => void
  slashCommands: SlashCommand[]
  snippetCommands: SnippetCommand[]
  fileRefs: FileRef[]
  onSnippetCommand?: (id: string) => Promise<string | null> | string | null
  onSlashCommand?: (id: string) => void
  setMentions: Dispatch<SetStateAction<string[]>>
  minimized: boolean
  onSuggestionsMenuChange?: (open: boolean) => void
}

/** Helper hook for option button refs & auto-scrolling highlighted option into view. */
function useScrollOptionIntoView(open: boolean, index: number, count: number) {
  const refs = useRef<(HTMLButtonElement | null)[]>([])
  useEffect(() => {
    refs.current.length = count
    if (!open) return
    refs.current[index]?.scrollIntoView({ block: 'nearest' })
  }, [open, index, count])
  return refs
}

export function useInputBarSuggestionEngine({
  value,
  setValue,
  textareaRef,
  resize,
  slashCommands,
  snippetCommands,
  fileRefs,
  onSnippetCommand,
  onSlashCommand,
  setMentions,
  minimized,
  onSuggestionsMenuChange,
}: UseInputBarSuggestionEngineOptions) {
  const [menuIndex, setMenuIndex] = useState(0)
  const [snippetRange, setSnippetRange] = useState<SuggestionRange>(null)
  const [mentionRange, setMentionRange] = useState<SuggestionRange>(null)

  const slashFilter = value.startsWith('/') && !value.includes(' ')
    ? value.slice(1).toLowerCase()
    : null

  // ── Filtering ──────────────────────────────────────────────────────────────

  const filteredSlashCommands = useMemo(
    () => filterSlashCommands(slashCommands, slashFilter),
    [slashCommands, slashFilter],
  )

  const selectableSlashCommands = useMemo(
    () => filteredSlashCommands.filter((cmd) => !cmd.isSeparator),
    [filteredSlashCommands],
  )

  const filteredSnippetCommands = useMemo(
    () => filterSnippetCommands(snippetCommands, snippetRange),
    [snippetCommands, snippetRange],
  )

  const filteredMentions = useMemo(
    () => filterMentions(fileRefs, mentionRange),
    [fileRefs, mentionRange],
  )

  // ── The single open menu ───────────────────────────────────────────────────

  const menu: SuggestionMenu | null = useMemo(() => {
    if (mentionRange !== null && filteredMentions.length > 0) {
      return { kind: 'mention', id: 'inputbar-mention-menu', rows: filteredMentions, selectable: filteredMentions }
    }
    if (snippetRange !== null && filteredSnippetCommands.length > 0) {
      return { kind: 'snippet', id: 'inputbar-snippet-menu', rows: filteredSnippetCommands, selectable: filteredSnippetCommands }
    }
    if (slashFilter !== null && filteredSlashCommands.length > 0) {
      return { kind: 'slash', id: 'inputbar-slash-menu', rows: filteredSlashCommands, selectable: selectableSlashCommands }
    }
    return null
  }, [mentionRange, filteredMentions, snippetRange, filteredSnippetCommands, slashFilter, filteredSlashCommands, selectableSlashCommands])

  const selectableCount = menu?.selectable.length ?? 0
  const activeIndex = selectableCount > 0 ? menuIndex % selectableCount : 0
  const optionRefs = useScrollOptionIntoView(menu !== null, activeIndex, selectableCount)

  // Reset the highlight when the menu switches kind — e.g. a caret-only move
  // from inside a `#snippet` token into an `@mention` token swaps menus
  // without a value change (which is what normally resets the index).
  const menuKind = menu?.kind
  useEffect(() => {
    setMenuIndex(0)
  }, [menuKind])

  // ── Commit actions ─────────────────────────────────────────────────────────

  const executeSlashCommand = useCallback((cmd: SlashCommand) => {
    if (cmd.isSeparator) return
    if (cmd.keepInputOpen) {
      const next = `/${cmd.insertText ?? cmd.displayName ?? cmd.id} `
      setValue(next)
      const el = textareaRef.current
      if (el) {
        requestAnimationFrame(() => {
          el.focus()
          el.setSelectionRange(next.length, next.length)
          resize()
        })
      }
      return
    }
    setValue('')
    if (textareaRef.current) textareaRef.current.style.height = 'auto'
    onSlashCommand?.(cmd.id)
  }, [onSlashCommand, resize, setValue, textareaRef])

  const insertSnippet = useCallback(async (cmd: SnippetCommand) => {
    if (!snippetRange) return
    const rendered = await onSnippetCommand?.(cmd.id)
    if (rendered == null) return
    const before = value.slice(0, snippetRange.start)
    const after = value.slice(snippetRange.end)
    const body = rendered
    const spacerBefore = before && !/\s$/.test(before) && body ? ' ' : ''
    const spacerAfter = after && !/^\s/.test(after) && body ? ' ' : ''
    const next = before + spacerBefore + body + spacerAfter + after
    setValue(next)
    setSnippetRange(null)
    setMenuIndex(0)
    const el = textareaRef.current
    if (el) {
      const caret = before.length + spacerBefore.length + body.length
      requestAnimationFrame(() => {
        el.focus()
        el.setSelectionRange(caret, caret)
        resize()
      })
    }
  }, [onSnippetCommand, resize, setValue, snippetRange, textareaRef, value])

  const insertMention = useCallback((ref: FileRef) => {
    if (!mentionRange) return
    const el = textareaRef.current
    const display = ref.type === 'directory' ? `${ref.path}/` : ref.path
    const insertion = `@${display} `
    const before = value.slice(0, mentionRange.start)
    const after = value.slice(mentionRange.end)
    const next = before + insertion + after
    setValue(next)
    setMentions((prev) => prev.includes(ref.path) ? prev : [...prev, ref.path])
    setMentionRange(null)
    setSnippetRange(null)
    setMenuIndex(0)
    if (el) {
      const caret = before.length + insertion.length
      requestAnimationFrame(() => {
        el.focus()
        el.setSelectionRange(caret, caret)
        resize()
      })
    }
  }, [mentionRange, resize, setMentions, setValue, textareaRef, value])

  /** Commit a row from the currently open menu (mouse click or Enter/Tab). */
  const commit = useCallback((row: SuggestionRow) => {
    if (!menu) return
    if (menu.kind === 'slash') executeSlashCommand(row as SlashCommand)
    else if (menu.kind === 'snippet') void insertSnippet(row as SnippetCommand)
    else insertMention(row as FileRef)
  }, [menu, executeSlashCommand, insertSnippet, insertMention])

  /** Commit the currently highlighted row. */
  const commitActive = useCallback(() => {
    if (!menu || menu.selectable.length === 0) return
    commit(menu.selectable[activeIndex])
  }, [menu, activeIndex, commit])

  /** Close the open menu (Escape). Slash keeps its legacy clear-the-draft behaviour. */
  const dismiss = useCallback(() => {
    if (!menu) return
    if (menu.kind === 'slash') setValue('')
    else if (menu.kind === 'snippet') setSnippetRange(null)
    else setMentionRange(null)
  }, [menu, setValue])

  const suggestionsOpen = !minimized && menu !== null
  useEffect(() => {
    onSuggestionsMenuChange?.(suggestionsOpen)
  }, [suggestionsOpen, onSuggestionsMenuChange])

  return {
    mentionRange,
    setMentionRange,
    setSnippetRange,

    menu,
    activeIndex,
    setMenuIndex,
    optionRefs,

    commit,
    commitActive,
    dismiss,

    suggestionsOpen,
  }
}
