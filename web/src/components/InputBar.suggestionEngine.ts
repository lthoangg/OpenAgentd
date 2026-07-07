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
  // The active @-mention window (positions in ``value``) — null when no
  // mention is being edited at the caret. Recomputed on every keystroke
  // and on caret-only moves (arrow keys, clicks) via ``syncMention``.
  const [mentionRange, setMentionRange] = useState<SuggestionRange>(null)

  const slashFilter = !shellMode && value.startsWith('/') && !value.includes(' ')
    ? value.slice(1).toLowerCase()
    : null

  const executeSlashCommand = useCallback((cmd: SlashCommand) => {
    if (cmd.isSeparator) return
    setShellMode(false)
    if (cmd.keepInputOpen) {
      // Insert ``/<id> `` and keep the textarea focused so the user can
      // append arguments. Submission is what triggers the action — the
      // parent's onSubmit handler inspects the raw text.
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

  // ── Slash command filtering ────────────────────────────────────────────────

  /**
   * ``filteredSlashCommands`` — the visible list shown in the popover.
   *
   * When a filter string is present, separator rows are only kept when at
   * least one actionable entry in their group matches (so we never render a
   * dangling header with nothing beneath it). With an empty filter string
   * (the user just typed ``/``) every entry is shown.
   *
   * Separator rows are excluded from keyboard-navigation indexing; only
   * actionable entries count as "selectable" positions.
   */
  const filteredSlashCommands = useMemo(
    () => filterSlashCommands(slashCommands, slashFilter),
    [slashCommands, slashFilter],
  )

  /** Actionable entries only — used for keyboard index arithmetic. */
  const selectableSlashCommands = useMemo(
    () => filteredSlashCommands.filter((cmd) => !cmd.isSeparator),
    [filteredSlashCommands],
  )

  const slashMenuOpen = slashFilter !== null && filteredSlashCommands.length > 0
  const slashMenuId = 'inputbar-slash-menu'
  const mentionMenuId = 'inputbar-mention-menu'
  const snippetMenuId = 'inputbar-snippet-menu'

  const filteredSnippetCommands = useMemo(
    () => filterSnippetCommands(snippetCommands, snippetRange),
    [snippetCommands, snippetRange],
  )

  const snippetMenuOpen = snippetRange !== null && filteredSnippetCommands.length > 0
  const clampedSnippetIndex = filteredSnippetCommands.length > 0
    ? snippetMenuIndex % filteredSnippetCommands.length
    : 0

  const snippetOptionRefs = useRef<(HTMLButtonElement | null)[]>([])
  useEffect(() => {
    snippetOptionRefs.current.length = filteredSnippetCommands.length
    if (!snippetMenuOpen) return
    snippetOptionRefs.current[clampedSnippetIndex]?.scrollIntoView({ block: 'nearest' })
  }, [clampedSnippetIndex, filteredSnippetCommands, snippetMenuOpen])

  // Clamp index to valid range (handles filter changes reducing the list).
  // The index tracks position within ``selectableSlashCommands``, not the full
  // ``filteredSlashCommands`` list, so separator rows are never "focused".
  const clampedIndex = selectableSlashCommands.length > 0
    ? slashMenuIndex % selectableSlashCommands.length
    : 0

  // Refs for slash option buttons so the highlighted row stays visible when
  // the list overflows ``max-h-64``. Same pattern as the mention picker —
  // truncate to the current option count inside the effect, not during
  // render, so unmounted-but-still-recorded nulls don't accumulate.
  const slashOptionRefs = useRef<(HTMLButtonElement | null)[]>([])
  useEffect(() => {
    slashOptionRefs.current.length = selectableSlashCommands.length
    if (!slashMenuOpen) return
    const el = slashOptionRefs.current[clampedIndex]
    el?.scrollIntoView({ block: 'nearest' })
  }, [clampedIndex, slashMenuOpen, selectableSlashCommands])

  const insertSnippet = useCallback(async (cmd: SnippetCommand) => {
    if (!snippetRange) return
    const rendered = await onSnippetCommand?.(cmd.id)
    if (rendered == null) return
    const before = value.slice(0, snippetRange.start)
    const after = value.slice(snippetRange.end)
    // A snippet body starting with "!" (e.g. `.openagentd/snippets/*.md`
    // authored as a shell command) should drop the user straight into
    // shell mode, matching what typing "!" as the first character does —
    // otherwise the bang is inserted as literal text and the composer
    // stays in normal chat mode, submitting the wrong content.
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

  // ── @-mention filtering ────────────────────────────────────────────────────

  const filteredMentions = useMemo(
    () => filterMentions(fileRefs, mentionRange),
    [fileRefs, mentionRange],
  )

  const mentionMenuOpen = mentionRange !== null && filteredMentions.length > 0
  const clampedMentionIndex = filteredMentions.length > 0
    ? mentionMenuIndex % filteredMentions.length
    : 0

  // Refs for each rendered option so the highlighted one can be scrolled
  // into view when the user arrow-keys past the visible window. The array is
  // truncated to the current option count inside the effect (not during
  // render) so unmounted-but-still-recorded nulls don't accumulate.
  const mentionOptionRefs = useRef<(HTMLButtonElement | null)[]>([])
  useEffect(() => {
    mentionOptionRefs.current.length = filteredMentions.length
    if (!mentionMenuOpen) return
    const el = mentionOptionRefs.current[clampedMentionIndex]
    // ``block: 'nearest'`` only scrolls when the item is actually outside the
    // viewport, so it's a no-op for items already visible — no jitter on the
    // initial render or when the user arrows within the visible band.
    el?.scrollIntoView({ block: 'nearest' })
  }, [clampedMentionIndex, mentionMenuOpen, filteredMentions])

  /** Replace the active @-token with the selected reference plus a trailing space. */
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
    // Move the caret to just after the inserted token + trailing space. The
    // textarea state lags by one render so we defer with rAF.
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
    // Range state — read/write. ``syncMention``/``handleChange`` in
    // InputBar.tsx recompute these directly from caret position.
    mentionRange,
    setMentionRange,
    snippetRange,
    setSnippetRange,
    mentions,

    // Menu-index state — InputBar.tsx's handleKeyDown/handleChange drive
    // these directly for arrow-key navigation and index resets.
    slashMenuIndex,
    setSlashMenuIndex,
    snippetMenuIndex,
    setSnippetMenuIndex,
    mentionMenuIndex,
    setMentionMenuIndex,

    // Slash
    slashMenuId,
    filteredSlashCommands,
    selectableSlashCommands,
    slashMenuOpen,
    clampedIndex,
    slashOptionRefs,
    executeSlashCommand,

    // Snippet
    snippetMenuId,
    filteredSnippetCommands,
    snippetMenuOpen,
    clampedSnippetIndex,
    snippetOptionRefs,
    insertSnippet,

    // Mention
    mentionMenuId,
    filteredMentions,
    mentionMenuOpen,
    clampedMentionIndex,
    mentionOptionRefs,
    insertMention,

    suggestionsOpen,
  }
}
