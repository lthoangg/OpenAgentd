/**
 * Suggestion-menu engine for InputBar — owns the state, filtering, and
 * commit actions for all three picker menus (slash commands, `@`-mentions,
 * `#`-snippets).
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

export interface UseInputBarSuggestionEngineOptions {
  value: string
  setValue: Dispatch<SetStateAction<string>>
  shellMode: boolean
  setShellMode: Dispatch<SetStateAction<boolean>>
  textareaRef: React.RefObject<HTMLTextAreaElement | null>
  resize: () => void
  slashCommands: SlashCommand[]
  snippetCommands: SnippetCommand[]
  fileRefs: FileRef[]
  onSnippetCommand?: (id: string) => Promise<string | null> | string | null
  onSlashCommand?: (id: string) => void
  mentions: string[]
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

/** Helper to safely clamp menu selection index. */
function clampIndex(index: number, count: number): number {
  return count > 0 ? index % count : 0
}

export function useInputBarSuggestionEngine({
  value,
  setValue,
  shellMode,
  setShellMode,
  textareaRef,
  resize,
  slashCommands,
  snippetCommands,
  fileRefs,
  onSnippetCommand,
  onSlashCommand,
  mentions,
  setMentions,
  minimized,
  onSuggestionsMenuChange,
}: UseInputBarSuggestionEngineOptions) {
  const [slashMenuIndex, setSlashMenuIndex] = useState(0)
  const [snippetMenuIndex, setSnippetMenuIndex] = useState(0)
  const [mentionMenuIndex, setMentionMenuIndex] = useState(0)
  const [snippetRange, setSnippetRange] = useState<SuggestionRange>(null)
  const [mentionRange, setMentionRange] = useState<SuggestionRange>(null)

  const slashFilter = !shellMode && value.startsWith('/') && !value.includes(' ')
    ? value.slice(1).toLowerCase()
    : null

  const executeSlashCommand = useCallback((cmd: SlashCommand) => {
    if (cmd.isSeparator) return
    setShellMode(false)
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
  }, [onSlashCommand, resize, setShellMode, setValue, textareaRef])

  // ── Slash command filtering & state ────────────────────────────────────────

  const filteredSlashCommands = useMemo(
    () => filterSlashCommands(slashCommands, slashFilter),
    [slashCommands, slashFilter],
  )

  const selectableSlashCommands = useMemo(
    () => filteredSlashCommands.filter((cmd) => !cmd.isSeparator),
    [filteredSlashCommands],
  )

  const slashMenuOpen = slashFilter !== null && filteredSlashCommands.length > 0
  const slashMenuId = 'inputbar-slash-menu'
  const clampedIndex = clampIndex(slashMenuIndex, selectableSlashCommands.length)
  const slashOptionRefs = useScrollOptionIntoView(slashMenuOpen, clampedIndex, selectableSlashCommands.length)

  // ── Snippet command filtering & state ──────────────────────────────────────

  const snippetMenuId = 'inputbar-snippet-menu'
  const filteredSnippetCommands = useMemo(
    () => filterSnippetCommands(snippetCommands, snippetRange),
    [snippetCommands, snippetRange],
  )

  const snippetMenuOpen = snippetRange !== null && filteredSnippetCommands.length > 0
  const clampedSnippetIndex = clampIndex(snippetMenuIndex, filteredSnippetCommands.length)
  const snippetOptionRefs = useScrollOptionIntoView(snippetMenuOpen, clampedSnippetIndex, filteredSnippetCommands.length)

  const insertSnippet = useCallback(async (cmd: SnippetCommand) => {
    if (!snippetRange) return
    const rendered = await onSnippetCommand?.(cmd.id)
    if (rendered == null) return
    const before = value.slice(0, snippetRange.start)
    const after = value.slice(snippetRange.end)
    const isShellSnippet = before.length === 0 && after.length === 0 && rendered.startsWith('!')
    const body = isShellSnippet ? rendered.slice(1) : rendered
    const spacerBefore = before && !/\s$/.test(before) && body ? ' ' : ''
    const spacerAfter = after && !/^\s/.test(after) && body ? ' ' : ''
    const next = before + spacerBefore + body + spacerAfter + after
    setValue(next)
    setShellMode(isShellSnippet)
    setSnippetRange(null)
    setSnippetMenuIndex(0)
    const el = textareaRef.current
    if (el) {
      const caret = before.length + spacerBefore.length + body.length
      requestAnimationFrame(() => {
        el.focus()
        el.setSelectionRange(caret, caret)
        resize()
      })
    }
  }, [onSnippetCommand, resize, setShellMode, setValue, snippetRange, textareaRef, value])

  // ── @-mention filtering & state ────────────────────────────────────────────

  const mentionMenuId = 'inputbar-mention-menu'
  const filteredMentions = useMemo(
    () => filterMentions(fileRefs, mentionRange),
    [fileRefs, mentionRange],
  )

  const mentionMenuOpen = mentionRange !== null && filteredMentions.length > 0
  const clampedMentionIndex = clampIndex(mentionMenuIndex, filteredMentions.length)
  const mentionOptionRefs = useScrollOptionIntoView(mentionMenuOpen, clampedMentionIndex, filteredMentions.length)

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
    setShellMode(false)
    setMentionRange(null)
    setSnippetRange(null)
    setMentionMenuIndex(0)
    if (el) {
      const caret = before.length + insertion.length
      requestAnimationFrame(() => {
        el.focus()
        el.setSelectionRange(caret, caret)
        resize()
      })
    }
  }, [mentionRange, resize, setMentions, setShellMode, setValue, textareaRef, value])

  const suggestionsOpen = !minimized && (slashMenuOpen || snippetMenuOpen || mentionMenuOpen)
  useEffect(() => {
    onSuggestionsMenuChange?.(suggestionsOpen)
  }, [suggestionsOpen, onSuggestionsMenuChange])

  return {
    mentionRange,
    setMentionRange,
    snippetRange,
    setSnippetRange,
    mentions,

    slashMenuIndex,
    setSlashMenuIndex,
    snippetMenuIndex,
    setSnippetMenuIndex,
    mentionMenuIndex,
    setMentionMenuIndex,

    slashMenuId,
    filteredSlashCommands,
    selectableSlashCommands,
    slashMenuOpen,
    clampedIndex,
    slashOptionRefs,
    executeSlashCommand,

    snippetMenuId,
    filteredSnippetCommands,
    snippetMenuOpen,
    clampedSnippetIndex,
    snippetOptionRefs,
    insertSnippet,

    mentionMenuId,
    filteredMentions,
    mentionMenuOpen,
    clampedMentionIndex,
    mentionOptionRefs,
    insertMention,

    suggestionsOpen,
  }
}
