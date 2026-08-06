import { useRef, useState, useCallback, useImperativeHandle, forwardRef, useEffect, useMemo } from 'react'
import { ArrowUp, Loader2, MessageCircle, Paperclip, Square, Terminal } from 'lucide-react'
import { motion } from 'framer-motion'
import { FilePreviewStrip } from './FilePreviewStrip'
import { VoiceMicButton } from './VoiceMicButton'
import { findActiveMention, getExplicitMentionRanges, type FileRef } from './InputBar.mentions'
import { MentionOverlay } from './InputBar.overlay'
import { CHAR_WARN_THRESHOLD, findActiveSnippet } from './InputBar.helpers'
import { InputBarSuggestions } from './InputBar.suggestions'
import { useInputBarSuggestionEngine } from './InputBar.suggestionEngine'
import { MAX_TEXTAREA_HEIGHT, useTextareaAutosize } from './InputBar.autosize'
import type { AgentCapabilities } from '@/api/types'
import { buildAcceptString } from './InputBar.files'
import { useInputBarAttachments } from './InputBar.attachments'
import { buildHistoryEntries } from './InputBar.menus'
import { useIsMobile } from '@/hooks/use-mobile'
import { useReducedMotion } from '@/hooks/useReducedMotion'

// Re-export the public type so callers can import ``FileRef`` from this module
// alongside the component. (The helper ``findActiveMention`` is imported from
// './InputBar.mentions' directly to keep this file free of non-component
// runtime exports — react-refresh requirement.)
export type { FileRef } from './InputBar.mentions'

// ── Slash commands ──────────────────────────────────────────────────────────

export interface SlashCommand {
  id: string
  label: string
  description: string
  /**
   * When true, picking this command from the menu inserts ``/<id> `` into
   * the textarea and leaves the caret after the trailing space — for
   * commands that take free-form arguments the user still needs to type
   * (e.g. backend-discovered commands with ``$ARGUMENTS``). The default
   * is the legacy behaviour: the input is cleared and the parent's
   * ``onSlashCommand`` runs immediately.
   */
  keepInputOpen?: boolean
  /**
   * Optional visual category tag displayed in a small badge to the right of
   * the description (e.g. ``"skill"`` or ``"command"``). Use this to visually
   * distinguish different kinds of slash entries without adding a separate
   * separator row for every group.
   */
  category?: string
  /** Text shown after the leading slash in the picker. Defaults to ``id``. */
  displayName?: string
  /** Text inserted after the leading slash when ``keepInputOpen`` is true. Defaults to ``id``. */
  insertText?: string
  /**
   * When ``true`` this entry is rendered as a non-interactive section header
   * (a label row). Set ``id`` to something unique but non-actionable and
   * leave ``description`` blank. Keyboard navigation skips these rows.
   */
  isSeparator?: boolean
}

export interface SnippetCommand {
  id: string
  label: string
  description: string
  category?: string
}

export interface InputBarProps {
  onSubmit: (message: string, files?: File[], mentionedFiles?: string[]) => void
  onStop?: () => void
  onSlashCommand?: (id: string) => void
  onSnippetCommand?: (id: string) => Promise<string | null> | string | null
  slashCommands?: SlashCommand[]
  snippetCommands?: SnippetCommand[]
  /**
   * Workspace files/folders the user can reference with `@`. When the list is
   * empty (or omitted) the picker stays dormant — the `@` character behaves as
   * plain text.
   */
  fileRefs?: FileRef[]
  onFileRefsNeeded?: () => void
  isStreaming?: boolean
  disabled?: boolean
  placeholder?: string
  autoFocus?: boolean
  capabilities?: AgentCapabilities
  /**
   * When true, the component renders only the inner rounded pill (no
   * top border, no background row chrome). A parent wrapper is expected
   * to provide positioning, shadow, and backdrop. Used by
   * `FloatingInputBar` for the draggable variant.
   */
  floating?: boolean
  /**
   * When true, file previews render below the input container instead of
   * above it. Used by `FloatingInputBar` when the panel is near the top
   * edge of its bounds so previews stay visible.
   */
  filesBelow?: boolean
  suggestionsBelow?: boolean
  /**
   * Optional render-prop for a drag handle rendered anchored to the top
   * edge of the input pill (not the outer wrapper). This keeps the handle
   * pinned to the input regardless of whether file previews are rendered
   * above or below. Used by `FloatingInputBar`.
   */
  renderDragHandle?: () => React.ReactNode
  /**
   * Whether voice input is enabled.
   * When false the mic button is shown disabled with an explanatory tooltip.
   * When true the mic button starts client-side speech recognition and appends the transcript to input.
   */
  voiceEnabled?: boolean
  /**
   * When set, the bundled speech runtime can't load on this host. The mic
   * button stays disabled and surfaces this reason in its tooltip so users
   * understand why voice is off even though it's enabled in settings.
   */
  voiceUnavailableReason?: string | null
  /**
   * When true, render the slim collapsed action strip instead of the full
   * pill. The strip keeps file, voice, chat, and send/stop controls visible.
   * Clicking the chat affordance calls `onUnminimize` so the parent can swap
   * back to the full variant and focus the textarea.
   */
  minimized?: boolean
  /** Called when the user clicks the collapsed bar to expand it. */
  onUnminimize?: () => void
  /** Forwarded to the textarea so the parent can drive minimize-on-blur. */
  onFocus?: () => void
  /**
   * Fired when the textarea blurs. ``canMinimize`` is ``false`` when the
   * input has uncommitted content (text or attachments) the user would
   * lose visual access to if the bar collapsed; the parent should keep
   * the bar expanded in that case.
   */
  onBlur?: (canMinimize: boolean) => void
  /**
   * Called whenever uncommitted content (text or attachments) appears or
   * disappears. The parent uses this to keep the bar expanded when the
   * user adds files via the minimized strip's attach button — without
   * this signal, dropping a file while collapsed would leave the bar
   * collapsed and the new file invisible.
   */
  onHasContentChange?: (hasContent: boolean) => void
  /** Called whenever the current unsent text changes. */
  onValueChange?: (value: string) => void
  /** Called when the suggestions menu open state changes (slash, snippet, or mention). */
  onSuggestionsMenuChange?: (open: boolean) => void
  /** Newest-first prompt history supplied by the parent, e.g. loaded chat history. */
  historyPrompts?: string[]
}

export interface InputBarHandle {
  focus: () => void
  setValue: (text: string) => void
  appendValue: (text: string) => void
  insertText: (text: string) => void
  setFiles: (files: File[]) => void
  addFiles: (files: File[]) => void
  /**
   * Put back the text, attachments, and mode of the last submitted message.
   * Called when the send failed — the composer clears optimistically, so this
   * is what stops a failed request from destroying the user's work. No-ops if
   * the user has already started a new draft.
   */
  restoreLastSubmission: () => void
}


export const InputBar = forwardRef<InputBarHandle, InputBarProps>(function InputBar({
  onSubmit,
  onStop,
  onSlashCommand,
  onSnippetCommand,
  slashCommands = [],
  snippetCommands = [],
  fileRefs = [],
  onFileRefsNeeded,
  isStreaming = false,
  disabled,
  placeholder = 'Message OpenAgentd…',
  autoFocus,
  capabilities,
  floating = false,
  filesBelow = false,
  suggestionsBelow,
  renderDragHandle,
  voiceEnabled = false,
  voiceUnavailableReason = null,
  minimized = false,
  onUnminimize,
  onFocus,
  onBlur,
  onHasContentChange,
  onValueChange,
  onSuggestionsMenuChange,
  historyPrompts = [],
}, ref) {
  const [value, setValue] = useState('')
  const {
    files,
    setFiles,
    fileInputRef,
    blobUrls,
    removeFile,
    addFiles: addAllowedFiles,
    extractPastedFiles,
    handleDragEnter,
    handleDragLeave,
    handleDragOver,
    handleDrop,
    handleFileSelect,
  } = useInputBarAttachments({ capabilities })
  const [localHistory, setLocalHistory] = useState<string[]>([])
  const [historyIndex, setHistoryIndex] = useState(-1)
  const [shellMode, setShellMode] = useState(false)
  const [mentions, setMentions] = useState<string[]>([])

  /** Last submitted draft, held only until the send is confirmed or restored. */
  const lastSubmissionRef = useRef<{
    value: string
    files: File[]
    mentions: string[]
    shellMode: boolean
  } | null>(null)

  // Single source of truth for where committed ``@mention`` tokens live in
  // the current value. Memoized once per (value, mentions) change and shared
  // by atomic selection (syncMention), atomic deletion, and mention pruning —
  // previously each of those re-scanned the text with its own copy of the
  // boundary rules on every keystroke/caret move.
  const mentionRanges = useMemo(
    () => getExplicitMentionRanges(value, mentions),
    [value, mentions],
  )

  // Synchronise mentions with the actual textarea value: a mention survives
  // only while its ``@path`` / ``@path/`` token still resolves to a range in
  // the text (i.e. the user hasn't typed over or deleted it).
  useEffect(() => {
    setMentions((prev) => {
      const present = new Set(mentionRanges.map((r) => r.path))
      const next = prev.filter((path) => present.has(path))
      return next.length !== prev.length ? next : prev
    })
  }, [mentionRanges])
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const isMobile = useIsMobile()
  const prefersReducedMotion = useReducedMotion()

  const history = useMemo(
    () => buildHistoryEntries(localHistory, historyPrompts),
    [localHistory, historyPrompts],
  )

  // Height-to-content resizing + the single/multi-line layout flag. See
  // InputBar.autosize.ts for the promote/demote hysteresis rationale.
  const {
    isMultiLine,
    resize,
    scheduleResize,
    resizeAfterLayout,
    resetHeightNow,
    resetMultiLine,
  } = useTextareaAutosize(textareaRef)

  const {
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
  } = useInputBarSuggestionEngine({
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
    setMentions,
    minimized,
    onSuggestionsMenuChange,
  })

  // Refresh the active mention window from the current caret position. Called
  // whenever the caret might have moved without the value changing (arrow keys,
  // click, focus from history nav). Cheap; just a left-scan from the caret.
  const syncMention = useCallback(() => {
    const el = textareaRef.current
    if (!el) return
    const caret = el.selectionStart ?? el.value.length
    const selectionEnd = el.selectionEnd ?? caret

    // Atomic mention selection: if the cursor is placed inside an explicit mention,
    // select the entire mention so that any edit/delete action applies to it as a whole.
    if (caret === selectionEnd) {
      // ``onSelect`` also fires mid-typing, before React re-renders — in that
      // window ``el.value`` is ahead of the ``value`` state the memoized
      // ranges were computed from, so fall back to a fresh scan.
      const ranges = el.value === value
        ? mentionRanges
        : getExplicitMentionRanges(el.value, mentions)
      const hit = ranges.find((r) => caret > r.start && caret < r.end)
      if (hit) {
        requestAnimationFrame(() => {
          el.setSelectionRange(hit.start, hit.end)
        })
        return
      }
    }

    const next = shellMode ? null : findActiveMention(el.value, caret)
    setSnippetRange((next !== null || shellMode) ? null : findActiveSnippet(el.value, caret))
    setMentionRange((prev) => {
      if (!prev && !next) return prev
      if (
        prev && next &&
        prev.start === next.start &&
        prev.end === next.end &&
        prev.query === next.query
      ) return prev
      return next
    })
  }, [shellMode, value, mentionRanges, mentions, setMentionRange, setSnippetRange])

  const navigateHistory = useCallback((dir: 'up' | 'down') => {
    if (history.length === 0) return false
    const direction = dir === 'up' ? 1 : -1
    const canEnterHistory = dir === 'up' && value.length === 0 && historyIndex === -1
    const inHistory = historyIndex >= 0

    if (canEnterHistory || inHistory) {
      const nextIndex = canEnterHistory ? 0 : historyIndex + direction
      if (nextIndex < 0) {
        setHistoryIndex(-1)
        setValue('')
        setShellMode(false)
        setMentionRange(null)
        setSnippetRange(null)
        requestAnimationFrame(resize)
        return true
      }
      if (nextIndex >= history.length) return true
      const next = history[nextIndex]
      const shellHistoryEntry = next.startsWith('!')
      const nextValue = shellHistoryEntry ? next.slice(1) : next
      setHistoryIndex(nextIndex)
      setShellMode(shellHistoryEntry)
      setValue(nextValue)
      setMentionRange(null)
      setSnippetRange(null)
      requestAnimationFrame(() => {
        const el = textareaRef.current
        el?.setSelectionRange(nextValue.length, nextValue.length)
        resize()
      })
      return true
    }
    return false
  }, [history, value, historyIndex, resize, setMentionRange, setSnippetRange])

  // Shared bookkeeping for every programmatic draft mutation: leave history
  // navigation and close any open picker — a value replacement invalidates
  // the pickers' ``start``/``end`` indices, which refer to the old text.
  const resetDraftState = useCallback(() => {
    setHistoryIndex(-1)
    setMentionRange(null)
    setSnippetRange(null)
  }, [setMentionRange, setSnippetRange])

  useImperativeHandle(ref, () => ({
    focus: () => textareaRef.current?.focus(),
    setValue: (text: string) => {
      setValue(text)
      setShellMode(false)
      resetDraftState()
      // Recalculate height after injecting text programmatically — see
      // ``resizeAfterLayout`` for why this must wait two frames.
      resizeAfterLayout()
    },
    appendValue: (text: string) => {
      // Mirrors the textarea's own paste handling: appending "!command" to
      // an empty draft (the FloatingInputBar's paste-while-minimized path
      // forwards clipboard text here) should land in shell mode with the
      // bang stripped, not insert a literal "!" into a normal chat message.
      // Only applies when the draft is empty — a mid-sentence append (e.g.
      // voice transcript, @mention comment) keeps "!" as plain text.
      const shouldEnterShellMode = !shellMode && value.length === 0 && text.startsWith('!')
      setValue((prev) => {
        if (shouldEnterShellMode) return text.slice(1)
        const spacer = prev && !/\s$/.test(prev) ? ' ' : ''
        return `${prev}${spacer}${text}`
      })
      setShellMode(shouldEnterShellMode)
      resetDraftState()
      resizeAfterLayout()
    },
    insertText: (text: string) => {
      const el = textareaRef.current
      const shouldEnterShellMode = !shellMode && value.length === 0 && text === '!'
      setValue((prev) => {
        const start = el?.selectionStart ?? prev.length
        const end = el?.selectionEnd ?? start
        if (shouldEnterShellMode && prev.length === 0 && start === 0 && end === 0) {
          requestAnimationFrame(resize)
          return ''
        }
        const next = prev.slice(0, start) + text + prev.slice(end)
        // Single rAF (not ``resizeAfterLayout``): this path forwards live
        // keystrokes, so the caret must land as soon as React has painted.
        requestAnimationFrame(() => {
          el?.setSelectionRange(start + text.length, start + text.length)
          resize()
        })
        return next
      })
      setShellMode(shouldEnterShellMode)
      resetDraftState()
    },
    setFiles: (nextFiles: File[]) => {
      setFiles(nextFiles)
    },
    addFiles: (nextFiles: File[]) => {
      addAllowedFiles(nextFiles)
    },
    restoreLastSubmission: () => {
      const snapshot = lastSubmissionRef.current
      if (!snapshot) return
      // One restore per submission — a second failure report (or a retry
      // that also failed) must not resurrect an older draft.
      lastSubmissionRef.current = null
      // The failure can land seconds later, by which time the user may have
      // moved on and started typing. Their current draft wins; overwriting it
      // would trade one lost message for another.
      if (value.trim().length > 0 || files.length > 0) return

      setValue(snapshot.value)
      setFiles(snapshot.files)
      setMentions(snapshot.mentions)
      setShellMode(snapshot.shellMode)
      resetDraftState()
      resizeAfterLayout(() => textareaRef.current?.focus())
    },
  }))

  // Auto-focus the textarea whenever the bar transitions from
  // minimized → expanded. The textarea is always mounted (visibility
  // is opacity-driven, not mount-driven) so the ref is reliably
  // populated; we just need to call ``.focus()`` at the transition.
  const prevMinimizedRef = useRef(minimized)
  useEffect(() => {
    const wasMinimized = prevMinimizedRef.current
    prevMinimizedRef.current = minimized
    if (!wasMinimized || minimized) return
    // Reset multi-line state only when the textarea is empty — if
    // content was just injected (e.g. via /undo) we must not clear
    // isMultiLine/promoteLengthRef here because the setValue rAF
    // will compute the correct height from the actual content.
    if (!textareaRef.current?.value) {
      resetMultiLine()
    }
    // ``resizeAfterLayout``'s double-rAF lets Framer's spring reach (or get
    // very close to) the bar's final width before scrollHeight is measured.
    return resizeAfterLayout(() => textareaRef.current?.focus())
  }, [minimized, resizeAfterLayout, resetMultiLine])

  // Plain ref now — no auto-focus-on-mount magic needed since the
  // textarea never unmounts.
  const setTextareaRef = useCallback((node: HTMLTextAreaElement | null) => {
    textareaRef.current = node
  }, [])

  const submit = useCallback(() => {
    if (disabled) return
    const trimmed = value.trim()
    if (trimmed.length === 0 && files.length === 0) return
    if (isStreaming && value.trim().length === 0) return

    // Snapshot everything the clear below is about to throw away, so a
    // failed send can hand it back (see ``restoreLastSubmission``).
    lastSubmissionRef.current = { value: trimmed, files, mentions, shellMode }

    const submitted = shellMode ? `!${trimmed}` : trimmed
    onSubmit(
      submitted,
      files.length > 0 ? files : undefined,
      mentions.length > 0 ? mentions : undefined
    )
    setLocalHistory((prev) =>
      prev[0] === submitted ? prev : [submitted, ...prev].slice(0, 100),
    )
    setValue('')
    setFiles([])
    setMentions([])
    setShellMode(false)
    resetDraftState()
    setMenuIndex(0)

    // Reset the visible height synchronously — see ``resetHeightNow`` for
    // why this can't wait for the next animation frame.
    resetHeightNow()
  }, [disabled, value, files, isStreaming, shellMode, onSubmit, mentions, resetDraftState, resetHeightNow, setFiles, setMenuIndex])

  const handlePaste = useCallback((e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.items
    if (!items) return
    const pastedFiles = extractPastedFiles(items)
    if (pastedFiles.length > 0) {
      e.preventDefault()
      // Routed through ``addAllowedFiles`` (not a raw ``setFiles``) so pasted
      // files go through the same size budget as dropped and picked ones.
      addAllowedFiles(pastedFiles)
      return
    }

    const el = e.currentTarget
    const text = e.clipboardData?.getData('text/plain') ?? ''
    const replacesEntireDraft = el.selectionStart === 0 && el.selectionEnd === value.length
    if (!shellMode && replacesEntireDraft && text.startsWith('!')) {
      e.preventDefault()
      const command = text.slice(1)
      setValue(command)
      setShellMode(true)
      resetDraftState()
      requestAnimationFrame(() => {
        el.focus()
        el.setSelectionRange(command.length, command.length)
        resize()
      })
    }
  }, [extractPastedFiles, addAllowedFiles, resetDraftState, resize, shellMode, value])

  const handleAtomicMentionDeletion = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (e.key !== 'Backspace' && e.key !== 'Delete') return false
    const el = textareaRef.current
    if (!el || el.selectionStart !== el.selectionEnd) return false
    const caret = el.selectionStart
    const targetIdx = e.key === 'Backspace' ? caret - 1 : caret
    // Keydown fires before the value changes, so the memoized ranges are
    // guaranteed fresh here.
    const hit = mentionRanges.find((r) => targetIdx >= r.start && targetIdx < r.end)
    if (!hit) return false

    e.preventDefault()
    const before = value.slice(0, hit.start)
    const after = value.slice(hit.end)
    const next = before + after
    setValue(next)

    requestAnimationFrame(() => {
      el.focus()
      el.setSelectionRange(hit.start, hit.start)
      resize()
    })
    return true
  }, [mentionRanges, resize, value])

  const handleShellKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (e.key === '!' && !shellMode && value.length === 0) {
      e.preventDefault()
      setShellMode(true)
      setMentionRange(null)
      setSnippetRange(null)
      return true
    }
    if (shellMode) {
      if ((e.key === 'Backspace' && value.length === 0) || e.key === 'Escape') {
        e.preventDefault()
        setShellMode(false)
        return true
      }
    }
    return false
  }, [setMentionRange, setShellMode, setSnippetRange, shellMode, value.length])

  const handlePickerMenuKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!menu || menu.selectable.length === 0) return false
    const count = menu.selectable.length
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setMenuIndex((i) => (i + 1) % count)
      return true
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault()
      setMenuIndex((i) => (i - 1 + count) % count)
      return true
    }
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault()
      commitActive()
      return true
    }
    if (e.key === 'Escape') {
      e.preventDefault()
      dismiss()
      return true
    }
    return false
  }, [menu, setMenuIndex, commitActive, dismiss])

  const handleHistoryKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && history.length > 0) {
      if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return false
      const handled = navigateHistory(e.key === 'ArrowUp' ? 'up' : 'down')
      if (handled) {
        e.preventDefault()
        return true
      }
    }
    return false
  }, [history.length, navigateHistory])

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return

    // Word-by-word caret movement (Alt/Ctrl+Arrow) is native textarea
    // behaviour; `onSelect` keeps the mention picker in sync afterwards.
    if (handleAtomicMentionDeletion(e)) return
    if (handleShellKeyDown(e)) return
    if (handlePickerMenuKeyDown(e)) return
    if (handleHistoryKeyDown(e)) return

    if (e.key === 'Enter' && !e.shiftKey && !isMobile) {
      e.preventDefault()
      submit()
    }
  }

  const handleBeforeInput = (e: React.FormEvent<HTMLTextAreaElement>) => {
    if ((e.nativeEvent as InputEvent).inputType !== 'insertLineBreak') return
    if (menu?.kind !== 'slash') return

    e.preventDefault()
    commitActive()
  }

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const nextValue = e.target.value
    if (!shellMode && nextValue === '!') {
      setShellMode(true)
      setValue('')
      resetDraftState()
      setMenuIndex(0)
      scheduleResize()
      return
    }
    setValue(nextValue)
    setHistoryIndex(-1)
    setMenuIndex(0)
    // ``selectionStart`` is already at the post-change caret position by the
    // time React fires onChange.
    const caret = e.target.selectionStart ?? nextValue.length
    const next = shellMode ? null : findActiveMention(nextValue, caret)
    if (next) onFileRefsNeeded?.()
    setMentionRange(next)
    setSnippetRange((next !== null || shellMode) ? null : findActiveSnippet(nextValue, caret))
    scheduleResize()
  }

  // ── Voice transcript insertion ────────────────────────────────────────────
  const handleVoiceTranscript = useCallback((transcript: string) => {
    setValue((prev) => {
      const trimmed = prev.trimEnd()
      return trimmed ? `${trimmed} ${transcript}` : transcript
    })
    setShellMode(false)
    requestAnimationFrame(resize)
  }, [resize])

  const hasText = value.trim().length > 0
  useEffect(() => {
    onValueChange?.(value)
  }, [onValueChange, value])

  const canSend = hasText && !disabled
  const canStop = isStreaming && !disabled && onStop != null
  const charCount = value.length
  const showCharCount = charCount > CHAR_WARN_THRESHOLD

  // Surface "has uncommitted content" to the parent so a minimized bar
  // can re-expand when the user attaches a file via the slim strip.
  // Edge-triggered on the boolean — not on the underlying length values —
  // so we only re-render the parent when crossing 0↔1.
  const hasContent = hasText || shellMode || files.length > 0
  const lastHasContentRef = useRef(hasContent)
  useEffect(() => {
    if (lastHasContentRef.current !== hasContent) {
      lastHasContentRef.current = hasContent
      onHasContentChange?.(hasContent)
    }
  }, [hasContent, onHasContentChange])

  // Single-row, horizontally scrollable list so many attachments don't push
  // the input off-screen vertically. The strip owns its own scroll-position
  // hint (matches pencil's MultiAttachOverflow `attachmentScrollHint`).
  const filePreviews = files.length > 0 ? (
    <FilePreviewStrip
      files={files}
      blobUrls={blobUrls}
      onRemove={removeFile}
      filesBelow={filesBelow}
    />
  ) : null

  // Reusable pill button styles for the action row (attach, mic — pencil
  // calls these `inputBarAttach`, `inputBarMic`: 32×32 rounded controls,
  // warm card fill).
  // ``active:scale-90`` gives a tactile press response on touch (``hover``
  // never fires on a finger), and ``motion-reduce`` opts out for users who
  // disable animation. The transition is transform+color only — both
  // GPU-cheap, no layout.
  const actionBtnClass =
    'flex h-7 w-7 shrink-0 items-center justify-center rounded-[10px] border border-(--color-border) bg-(--bg-card) text-(--color-text-2) transition duration-100 hover:bg-(--bg-key) hover:text-(--color-text) active:scale-90 active:bg-(--bg-key) motion-reduce:transition-none motion-reduce:active:scale-100 disabled:cursor-not-allowed disabled:opacity-50'
  const shellBtnClass = shellMode
    ? 'flex h-7 shrink-0 items-center gap-1 rounded-[10px] border border-(--color-accent) bg-(--bg-key) px-2 font-mono text-xs text-(--color-text) transition duration-100 hover:bg-(--bg-card) active:scale-95 motion-reduce:transition-none motion-reduce:active:scale-100 disabled:cursor-not-allowed disabled:opacity-50'
    : actionBtnClass

  // Three states share one DOM tree: minimized, single-line, multi-line.
  // Multi-line is triggered by the slot's flex-basis:100% which wraps the
  // row so action buttons land on the line below — no DOM reordering.
  const handleExpand = () => {
    onUnminimize?.()
  }
  const stopClick = (e: React.MouseEvent) => e.stopPropagation()

  const attachEl = (
    <button
      type="button"
      onClick={(e) => { stopClick(e); fileInputRef.current?.click() }}
      disabled={disabled}
      aria-label="Attach file"
      title="Attach file (paste or drag)"
      className={actionBtnClass}
    >
      <Paperclip size={14} aria-hidden="true" />
    </button>
  )

  const voiceEl = (
    <div onClick={stopClick}>
      <VoiceMicButton
        voiceEnabled={voiceEnabled}
        onTranscript={handleVoiceTranscript}
        disabled={disabled}
        unavailableReason={voiceUnavailableReason}
      />
    </div>
  )

  const shellEl = !minimized ? (
    <button
      type="button"
      // ``preventDefault`` on the press stops the button from stealing focus,
      // so in the common case the textarea keeps focus and the keyboard never
      // drops — avoiding the blur→refocus round-trip that blipped the visual
      // viewport and flickered the shell on iOS. The guarded refocus in
      // ``onClick`` is a safety net: it only re-focuses if focus actually left
      // the textarea, so it doesn't reintroduce the blip when focus was held.
      onPointerDown={(e) => e.preventDefault()}
      onClick={(e) => {
        stopClick(e)
        setShellMode((next) => !next)
        setMentionRange(null)
        setSnippetRange(null)
        const el = textareaRef.current
        if (el && document.activeElement !== el) el.focus({ preventScroll: true })
      }}
      disabled={disabled}
      aria-label={shellMode ? 'Exit shell mode' : 'Use shell mode'}
      aria-pressed={shellMode}
      title={shellMode ? 'Exit shell mode (Esc)' : 'Run a shell command'}
      className={shellBtnClass}
    >
      <Terminal size={13} aria-hidden="true" />
      {shellMode && <span>Shell</span>}
    </button>
  ) : null

  const chatEl = minimized ? (
    <button
      type="button"
      onClick={(e) => { stopClick(e); handleExpand() }}
      aria-label="Expand input bar"
      title="Click to write"
      className={actionBtnClass}
    >
      <MessageCircle size={14} aria-hidden="true" />
    </button>
  ) : null

  const effectivePlaceholder = shellMode
    ? 'Enter shell command... git status'
    : disabled
      ? 'Waiting for response…'
      : isStreaming
        ? 'Queue a follow-up or /stop…'
        : placeholder

  const activePopupId = menu?.id
  const activeOptionId = menu ? `${menu.id}-option-${activeIndex}` : undefined



  const sendOrStopEl = canStop && !hasText ? (
    <button
      type="button"
      onClick={(e) => { stopClick(e); onStop?.() }}
      aria-label="Stop generation"
      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[10px] border border-(--color-error) bg-(--color-error) text-(--bg-page) transition duration-100 hover:opacity-90 active:scale-90 motion-reduce:transition-none motion-reduce:active:scale-100"
    >
      <Square size={12} fill="currentColor" />
    </button>
  ) : (
    <button
      type="button"
      onClick={(e) => {
        stopClick(e)
        submit()
      }}
      disabled={!canSend}
      aria-label="Send message"
      title={isMobile ? 'Send message' : 'Send (Enter) · New line (Shift+Enter) · Commands (/)'}
      className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-[10px] border transition duration-100 active:scale-90 motion-reduce:transition-none motion-reduce:active:scale-100 disabled:cursor-not-allowed disabled:opacity-50 ${
        canSend
          // When there's something to send, promote the button to an accent
          // fill so the primary action reads clearly — a small but meaningful
          // clarity win over the flat grey it always was.
          ? 'border-(--color-accent) bg-(--color-accent) text-(--bg-page) hover:opacity-90'
          : 'border-(--color-border) bg-(--bg-card) text-(--color-text-2) hover:bg-(--bg-key) hover:text-(--color-text)'
      }`}
    >
      {disabled && !minimized ? (
        <Loader2 size={14} className="animate-spin" aria-hidden="true" />
      ) : (
        <ArrowUp size={14} aria-hidden="true" />
      )}
    </button>
  )

  // The textarea stays mounted while minimized (opacity + pointer-events
  // toggle) so the ref stays valid and there's no remount flicker.
  const messageSlot = (
    <div
      aria-hidden={minimized}
      className={`flex w-full items-center transition-opacity duration-150 ${
        minimized ? 'pointer-events-none opacity-0 h-0 overflow-hidden' : 'opacity-100'
      }`}
    >
      {/* Position context for the chip overlay. ``relative`` + ``w-full``
          keep the overlay's bounding box equal to the textarea's, so
          chips line up pixel-for-pixel with the text glyphs above them.
          Intentionally not nesting the textarea's props one level deeper —
          keeps the diff against the prior version minimal. */}
      <div className="relative w-full">
      <MentionOverlay
        value={value}
        activeRange={mentionRange}
        textareaRef={textareaRef}
        fileRefs={fileRefs}
        mentions={mentions.length > 0 ? mentions : undefined}
      />
      <textarea
        ref={setTextareaRef}
        value={value}
        onBeforeInput={handleBeforeInput}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        // Caret-only moves (arrow keys, Home/End) don't fire onChange but
        // they can land the caret inside an existing `@token`. ``onSelect``
        // is the React-supported event that fires on selection / caret
        // moves and works in jsdom (used by our tests), so it's the
        // right hook for keeping the picker in sync.
        onSelect={syncMention}
        onClick={syncMention}
        onPaste={handlePaste}
        onFocus={(e) => {
          onFocus?.()
          if (!shellMode && findActiveMention(value, e.currentTarget.selectionStart ?? value.length)) onFileRefsNeeded?.()
        }}
        onBlur={() => {
          const canMinimize = value.trim().length === 0 && files.length === 0
          onBlur?.(canMinimize)
          // Close all pickers on blur — clicks on their items use
          // ``onMouseDown`` with ``preventDefault`` so they fire before the
          // textarea blurs and the menu still gets to commit its choice.
          setMentionRange(null)
          setSnippetRange(null)
        }}
        disabled={disabled || minimized}
        placeholder={minimized ? '' : effectivePlaceholder}
        rows={1}
        autoFocus={autoFocus}
        tabIndex={minimized ? -1 : 0}
        // ``p-0`` zeroes WebKit's asymmetric default textarea padding (WKWebView
        // in the macOS Tauri shell ships ~2px top + ~1px bottom that bias the
        // single-line baseline upward). ``align-middle`` keeps the textarea's
        // bounding box centred in the flex row instead of sitting on the
        // baseline of adjacent inline-block buttons. Together they make the
        // placeholder sit vertically centred against the 28px action buttons
        // both in Chrome (web build) and WKWebView (desktop build).
        //
        // ``text-transparent`` + ``caret-color`` hides the textarea's own
        // glyphs so the syntax-highlight overlay (``MentionOverlay``) is
        // the one painting visible text. The caret stays visible. The
        // placeholder is exempt from ``text-transparent`` — it's owned by
        // ``::placeholder`` and ``placeholder-(--color-text-subtle)``
        // keeps it readable.
        // ``scrollbar-none`` hides the textarea's own scrollbar. Without it,
        // the textarea grows a ~15px-wide vertical scrollbar once content
        // exceeds ``maxHeight``, which narrows its inner text-width and makes
        // it wrap a few characters earlier than the overlay mirror (which
        // has no scrollbar). The wrap-point drift is invisible while typing
        // but the native spellcheck squiggle is anchored to textarea text
        // positions, so it ends up under the wrong overlay word and drifts
        // further with every scroll. The wrapper around the overlay handles
        // overflow via the overlay's ``overflow-hidden`` + scroll sync.
        className="block w-full resize-none scrollbar-none overscroll-contain bg-transparent p-0 align-middle text-sm leading-relaxed break-words text-transparent caret-(--color-text) placeholder-(--color-text-subtle) selection:bg-(--color-accent)/30 selection:text-(--color-text) focus:outline-none disabled:opacity-50"
        // Cap matches the ``resize()`` ceiling in InputBar.autosize.ts so the
        // JS-driven height and the CSS limit stay in lockstep.
        style={{ maxHeight: `${MAX_TEXTAREA_HEIGHT}px` }}
        // Spellcheck disabled: the squiggle is painted by the browser under
        // the textarea's own glyphs, but the visible text comes from the
        // overlay mirror. Even with identical font/wrap/scroll the two
        // text-layout paths drift by 1–2px, leaving the squiggle a word
        // off. Same call Discord/Slack/ChatGPT make for the same reason.
        spellCheck={false}
        aria-label={shellMode ? 'Shell command input' : 'Message input'}
        aria-expanded={menu !== null}
        aria-controls={activePopupId}
        aria-activedescendant={activeOptionId}
      />
      </div>
    </div>
  )

  const pillClassName = `relative block rounded-[14px] border bg-(--color-surface) transition-[border-color,box-shadow,background-color] duration-200 ${
    minimized
      ? 'w-fit border-(--color-border) shadow-sm hover:bg-(--bg-key)'
      : shellMode
        // Shell mode: accent ring instantly signals the distinct "running a
        // command" state — a clear, animation-free UX cue.
        ? 'w-full border-(--color-accent) shadow-md ring-1 ring-(--color-accent)/40'
        : 'w-full border-(--color-border-strong) shadow-md focus-within:ring-1 focus-within:ring-(--color-accent)'
  }`

  const pillInner = (
    // Click-anywhere-to-expand on bare strip whitespace. Action buttons call
    // stopClick so they don't trigger this. No ARIA role — the Send button is
    // the keyboard-accessible "Expand input bar" affordance.
    <div
      onClick={minimized ? handleExpand : undefined}
      className={`flex w-full flex-wrap items-center gap-2 ${minimized ? 'cursor-text' : ''}`}
    >
      {shellEl}
      {!shellMode && (
        <>
          {attachEl}
          {voiceEl}
          {chatEl}
        </>
      )}
      {/* Slot snaps w-0 ↔ flex-1 in lockstep with the card's w-fit ↔ w-full.
          ``-ml-2`` absorbs the parent gap-2 when collapsed. */}
      <div
        style={{
          flexBasis: !minimized && isMultiLine ? '100%' : undefined,
          order: !minimized && isMultiLine ? -1 : 0,
        }}
        className={`min-w-0 overflow-hidden ${minimized ? 'w-0 -ml-2' : 'flex-1'}`}
      >
        {messageSlot}
      </div>
      {!minimized && showCharCount && (
        <span
          className={`shrink-0 font-mono text-xs ${
            charCount > 2000 ? 'text-(--color-error)' : 'text-(--color-text-muted)'
          }`}
        >
          {charCount}
        </span>
      )}
      {/* Spacer pushes Send to the right edge in multi-line. */}
      {!minimized && isMultiLine && <div className="flex-1" />}
      {sendOrStopEl}
    </div>
  )

  // Mobile renders a plain ``div`` — no framer-motion. The pill has no
  // animation on mobile (no ``layout``, static padding), and rendering it
  // through ``motion.div`` still made framer reconcile inline styles on every
  // shell-mode toggle, which flickered in the WebView. A bare div makes the
  // toggle a pure, cheap class swap. Desktop keeps the polished morph.
  const pill = isMobile ? (
    <div
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      className={pillClassName}
      style={{ padding: 8 }}
    >
      {pillInner}
    </div>
  ) : (
    <motion.div
      layout
      initial={false}
      animate={{ padding: minimized ? 6 : 8 }}
      transition={{ duration: prefersReducedMotion ? 0.01 : 0.24, ease: [0.32, 0.72, 0, 1] }}
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      className={pillClassName}
    >
      {pillInner}
    </motion.div>
  )

  return (
    <div className={floating ? '' : 'border-t border-(--color-border) bg-(--bg-page) px-4 py-3'}>
      <div className={floating ? 'relative' : 'relative mx-auto max-w-3xl'}>
        {!minimized && !filesBelow && filePreviews}

        <InputBarSuggestions
          minimized={minimized}
          menu={menu}
          activeIndex={activeIndex}
          optionRefs={optionRefs}
          onSelect={commit}
          suggestionsBelow={suggestionsBelow ?? filesBelow}
        />

        {/* ``flex justify-center`` centers the self-sized minimized pill. */}
        <div className={`relative ${minimized ? 'flex justify-center' : ''}`}>
          {renderDragHandle?.()}
          {pill}
        </div>

        {!minimized && filesBelow && filePreviews}

        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept={buildAcceptString(capabilities)}
          onChange={handleFileSelect}
          className="hidden"
          aria-hidden="true"
        />
      </div>
    </div>
  )
})
