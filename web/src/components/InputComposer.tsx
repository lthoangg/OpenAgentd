import { useRef, useState, useCallback, useImperativeHandle, forwardRef, useEffect, useMemo } from 'react'
import { ArrowUp, Loader2, MessageCircle, Paperclip, Square } from 'lucide-react'
import { motion } from 'framer-motion'
import { FilePreviewStrip } from './FilePreviewStrip'
import { DesignFeedbackStrip } from './DesignFeedbackViews'
import { findActiveMention, getExplicitMentionRanges, type FileRef } from './InputComposer.mentions'
import { MentionOverlay } from './InputComposer.overlay'
import { findActiveSnippet } from './InputComposer.helpers'
import { InputComposerSuggestions } from './InputComposer.suggestions'
import { useInputComposerSuggestionEngine } from './InputComposer.suggestionEngine'
import { MAX_TEXTAREA_HEIGHT, useTextareaAutosize } from './InputComposer.autosize'
import type { AgentCapabilities, SessionInteractionMode } from '@/api/types'
import { buildAcceptString } from './InputComposer.files'
import { useInputComposerAttachments } from './InputComposer.attachments'
import { DeliveryMenu } from './InputComposer.deliveryMenu'
import { cn } from '@/lib/utils'
import { composeWithDesignFeedback, designFeedbackMentions, splitDesignFeedback, type DesignFeedback } from '@/lib/design-feedback'
import { buildHistoryEntries } from './InputComposer.menus'
import { useIsMobile } from '@/hooks/use-mobile'
import { usePlatform } from '@/hooks/use-platform'
import { useReducedMotion } from '@/hooks/useReducedMotion'
import { isPrimaryModifierOS } from '@/lib/keyboard-shortcut'
import { focusQuietly } from '@/lib/focus/quiet'
import { SessionModeToggle } from './SessionModeToggle'

// Re-export the public type so callers can import ``FileRef`` from this module
// alongside the component. (The helper ``findActiveMention`` is imported from
// './InputComposer.mentions' directly to keep this file free of non-component
// runtime exports — react-refresh requirement.)
export type { FileRef } from './InputComposer.mentions'

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

/**
 * How a message sent during a turn is delivered: ``steer`` hands it to the
 * running turn before the agent's next step, ``after-turn`` holds it until
 * the turn ends, ``interrupt`` stops the turn and sends it in its place.
 * Idle sends are always ``steer``, which simply starts a turn.
 */
export type SendDelivery = 'steer' | 'after-turn' | 'interrupt'

/** Either primary modifier stops and sends, so a Mac user reaching for Ctrl is not surprised. */
function deliveryForKey(e: { metaKey: boolean; ctrlKey: boolean; altKey: boolean }): SendDelivery {
  if (e.metaKey || e.ctrlKey) return 'interrupt'
  if (e.altKey) return 'after-turn'
  return 'steer'
}

/** The chevron half of the split Send pill. */
const DELIVERY_TRIGGER_CLASS =
  'flex h-8 w-5 shrink-0 items-center justify-center gap-0 rounded-l-none rounded-r-full border-0 border-l border-l-(--color-text-on-accent)/20 bg-(--bg-send) px-0 py-0 text-(--color-text-on-accent) hover:bg-(--bg-send) hover:opacity-90 hover:shadow-none active:bg-(--bg-send) md:h-7 [&>span]:hidden [&_svg]:text-(--color-text-on-accent)'

export interface InputComposerProps {
  onSubmit: (message: string, files?: File[], mentionedFiles?: string[], delivery?: SendDelivery) => void
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
  interactionMode?: SessionInteractionMode
  /** True while `interactionMode` is a queued switch waiting on the active turn. */
  interactionModePending?: boolean
  onInteractionModeChange?: (mode: SessionInteractionMode) => void
  interactionModeDisabled?: boolean
  /**
   * When true, the component renders only the inner rounded pill (no
   * top border, no background row chrome). A parent wrapper is expected
   * to provide positioning, shadow, and backdrop. Used by
   * `FloatingInputComposer` for the draggable variant.
   */
  floating?: boolean
  /**
   * When true, file previews render below the input container instead of
   * above it. Used by `FloatingInputComposer` when the panel is near the top
   * edge of its bounds so previews stay visible.
   */
  filesBelow?: boolean
  suggestionsBelow?: boolean
  /**
   * Optional render-prop for a drag handle rendered anchored to the top
   * edge of the input pill (not the outer wrapper). This keeps the handle
   * pinned to the input regardless of whether file previews are rendered
   * above or below. Used by `FloatingInputComposer`.
   */
  renderDragHandle?: () => React.ReactNode
  /**
   * When true, render the slim collapsed action strip instead of the full
   * pill. The strip keeps file, chat, and send/stop controls visible.
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
  /**
   * ``↑``/``↓`` recalled a history prompt into the input (its text), or
   * walked back out to an empty draft (``null``).
   */
  onHistoryRecall?: (prompt: string | null) => void
  /** A design feedback chip's x was clicked; the chip is already gone. */
  onDesignFeedbackRemoved?: (feedback: DesignFeedback) => void
}

export interface InputComposerHandle {
  /**
   * ``expand: false`` leaves a collapsed floating bar collapsed, focusing its
   * Expand button instead — for handing focus back rather than summoning it.
   */
  focus: (options?: { expand?: boolean }) => void
  setValue: (text: string) => void
  /**
   * ``paragraph`` puts a blank line, rather than a space, before the text.
   * ``mentions`` registers ``@path`` tokens inside ``text`` as committed
   * mentions, so they render as chips and the backend attaches the files.
   */
  appendValue: (text: string, options?: { paragraph?: boolean; mentions?: readonly string[] }) => void
  /** Attach design feedback from a Preview tab as a removable chip. */
  addDesignFeedback: (feedback: DesignFeedback) => void
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


export const InputComposer = forwardRef<InputComposerHandle, InputComposerProps>(function InputComposer({
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
  interactionMode = 'code',
  interactionModePending = false,
  onInteractionModeChange,
  interactionModeDisabled = false,
  floating = false,
  filesBelow = false,
  suggestionsBelow,
  renderDragHandle,
  minimized = false,
  onUnminimize,
  onFocus,
  onBlur,
  onHasContentChange,
  onValueChange,
  onSuggestionsMenuChange,
  historyPrompts = [],
  onHistoryRecall,
  onDesignFeedbackRemoved,
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
  } = useInputComposerAttachments({ capabilities })
  const [localHistory, setLocalHistory] = useState<string[]>([])
  const [historyIndex, setHistoryIndex] = useState(-1)
  const [mentions, setMentions] = useState<string[]>([])
  // Design feedback chips. Written into the message on send; text set from
  // outside (restores, history) has its blocks turned back into chips.
  const [designFeedback, setDesignFeedback] = useState<DesignFeedback[]>([])
  const [isComposing, setIsComposing] = useState(false)

  /** Last submitted draft, held only until the send is confirmed or restored. */
  const lastSubmissionRef = useRef<{
    value: string
    files: File[]
    mentions: string[]
    designFeedback: DesignFeedback[]
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
  const expandButtonRef = useRef<HTMLButtonElement>(null)
  const isMobile = useIsMobile()
  const { os } = usePlatform()
  const prefersReducedMotion = useReducedMotion()

  const history = useMemo(
    () => buildHistoryEntries(localHistory, historyPrompts),
    [localHistory, historyPrompts],
  )

  // Height-to-content resizing. See InputComposer.autosize.ts.
  const {
    resize,
    scheduleResize,
    resizeAfterLayout,
    resetHeightNow,
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
  } = useInputComposerSuggestionEngine({
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

    const next = findActiveMention(el.value, caret)
    setSnippetRange(next !== null ? null : findActiveSnippet(el.value, caret))
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
  }, [value, mentionRanges, mentions, setMentionRange, setSnippetRange])

  const navigateHistory = useCallback((dir: 'up' | 'down') => {
    if (history.length === 0) return false
    const direction = dir === 'up' ? 1 : -1
    // Attached design feedback counts as a draft: ↑ must not replace it.
    const canEnterHistory = dir === 'up' && value.length === 0 && designFeedback.length === 0 && historyIndex === -1
    const inHistory = historyIndex >= 0

    if (canEnterHistory || inHistory) {
      const nextIndex = canEnterHistory ? 0 : historyIndex + direction
      if (nextIndex < 0) {
        setHistoryIndex(-1)
        setValue('')
        setDesignFeedback([])
        setMentionRange(null)
        setSnippetRange(null)
        requestAnimationFrame(resize)
        onHistoryRecall?.(null)
        return true
      }
      if (nextIndex >= history.length) return true
      const next = history[nextIndex]
      // A recalled prompt's design feedback comes back as chips.
      const recalled = splitDesignFeedback(next)
      setHistoryIndex(nextIndex)
      setValue(recalled.text)
      setDesignFeedback(recalled.blocks)
      setMentionRange(null)
      setSnippetRange(null)
      requestAnimationFrame(() => {
        const el = textareaRef.current
        el?.setSelectionRange(recalled.text.length, recalled.text.length)
        resize()
      })
      onHistoryRecall?.(next)
      return true
    }
    return false
  }, [history, value, designFeedback.length, historyIndex, resize, setMentionRange, setSnippetRange, onHistoryRecall])

  // Shared bookkeeping for every programmatic draft mutation: leave history
  // navigation and close any open picker — a value replacement invalidates
  // the pickers' ``start``/``end`` indices, which refer to the old text.
  const resetDraftState = useCallback(() => {
    setHistoryIndex(-1)
    setMentionRange(null)
    setSnippetRange(null)
  }, [setMentionRange, setSnippetRange])

  useImperativeHandle(ref, () => ({
    focus: (options) => {
      const pill = options?.expand === false && minimized ? expandButtonRef.current : null
      // Handing focus back (page load, dock close) isn't keyboard-steered, but
      // a script focus() on a fresh page counts as :focus-visible and rings
      // the pill. Focus it quietly: Tab still continues from here, and the
      // ring returns on the next control the keyboard reaches.
      if (pill) focusQuietly(pill, {})
      else textareaRef.current?.focus()
    },
    setValue: (text: string) => {
      // A restored message's design feedback blocks come back as chips.
      const split = splitDesignFeedback(text)
      setValue(split.text)
      setDesignFeedback(split.blocks)
      resetDraftState()
      // Recalculate height after injecting text programmatically — see
      // ``resizeAfterLayout`` for why this must wait two frames.
      resizeAfterLayout()
    },
    appendValue: (text: string, options?: { paragraph?: boolean; mentions?: readonly string[] }) => {
      const split = splitDesignFeedback(text)
      if (split.blocks.length > 0) setDesignFeedback((prev) => [...prev, ...split.blocks])
      const added = split.text
      if (added) {
        setValue((prev) => {
          if (options?.paragraph) return prev.trim() ? `${prev.trimEnd()}\n\n${added}` : added
          const spacer = prev && !/\s$/.test(prev) ? ' ' : ''
          return `${prev}${spacer}${added}`
        })
      }
      const addedMentions = options?.mentions
      if (addedMentions && addedMentions.length > 0) {
        // Tokens not present in the text are pruned by the sync effect.
        setMentions((prev) => {
          const next = [...prev, ...addedMentions.filter((path) => path && !prev.includes(path))]
          return next.length !== prev.length ? next : prev
        })
      }
      resetDraftState()
      resizeAfterLayout()
    },
    addDesignFeedback: (feedback: DesignFeedback) => {
      if (feedback.items.length === 0) return
      setDesignFeedback((prev) => [...prev, feedback])
      resetDraftState()
      resizeAfterLayout()
    },
    insertText: (text: string) => {
      const el = textareaRef.current
      setValue((prev) => {
        const start = el?.selectionStart ?? prev.length
        const end = el?.selectionEnd ?? start
        const next = prev.slice(0, start) + text + prev.slice(end)
        // Single rAF (not ``resizeAfterLayout``): this path forwards live
        // keystrokes, so the caret must land as soon as React has painted.
        requestAnimationFrame(() => {
          el?.setSelectionRange(start + text.length, start + text.length)
          resize()
        })
        return next
      })
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
      if (value.trim().length > 0 || files.length > 0 || designFeedback.length > 0) return

      setValue(snapshot.value)
      setFiles(snapshot.files)
      setMentions(snapshot.mentions)
      setDesignFeedback(snapshot.designFeedback)
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
    if (wasMinimized === minimized) return
    if (minimized) {
      // Minimizing disables the textarea, and the browser drops its focus
      // onto <body> without an event (after a send, or Esc). Keep focus in
      // the composer on the pill instead, so the next Tab, Enter or typed
      // key starts here rather than at the top of the page.
      const active = document.activeElement
      if (active === textareaRef.current || active === document.body || active === null) {
        expandButtonRef.current?.focus({ preventScroll: true })
      }
      return
    }
    // ``resizeAfterLayout``'s double-rAF lets Framer's spring reach (or get
    // very close to) the bar's final width before scrollHeight is measured.
    return resizeAfterLayout(() => textareaRef.current?.focus())
  }, [minimized, resizeAfterLayout])

  // Plain ref now — no auto-focus-on-mount magic needed since the
  // textarea never unmounts.
  const setTextareaRef = useCallback((node: HTMLTextAreaElement | null) => {
    textareaRef.current = node
  }, [])

  const submit = useCallback((delivery: SendDelivery = 'steer') => {
    if (disabled) return
    const trimmed = value.trim()
    const hasFeedback = designFeedback.length > 0
    if (trimmed.length === 0 && files.length === 0 && !hasFeedback) return
    if (isStreaming && trimmed.length === 0 && !hasFeedback) return

    // Snapshot everything the clear below is about to throw away, so a
    // failed send can hand it back (see ``restoreLastSubmission``).
    lastSubmissionRef.current = { value: trimmed, files, mentions, designFeedback }

    // Design feedback is written after the typed text (so slash commands
    // still lead), and its workspace sources become mentions.
    const message = composeWithDesignFeedback(trimmed, designFeedback)
    const allMentions = [...new Set([...mentions, ...designFeedback.flatMap(designFeedbackMentions)])]

    onSubmit(
      message,
      files.length > 0 ? files : undefined,
      allMentions.length > 0 ? allMentions : undefined,
      delivery,
    )
    setLocalHistory((prev) =>
      prev[0] === message ? prev : [message, ...prev].slice(0, 100),
    )
    setValue('')
    setFiles([])
    setMentions([])
    setDesignFeedback([])
    resetDraftState()
    setMenuIndex(0)

    // Reset the visible height synchronously — see ``resetHeightNow`` for
    // why this can't wait for the next animation frame.
    resetHeightNow()
  }, [disabled, value, files, isStreaming, onSubmit, mentions, designFeedback, resetDraftState, resetHeightNow, setFiles, setMenuIndex])

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
  }, [extractPastedFiles, addAllowedFiles])

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
    if (handlePickerMenuKeyDown(e)) return
    if (handleHistoryKeyDown(e)) return

    if (
      e.key === 'Tab' &&
      !e.repeat &&
      !e.shiftKey &&
      !e.altKey &&
      !e.ctrlKey &&
      !e.metaKey &&
      !minimized &&
      onInteractionModeChange &&
      !interactionModeDisabled
    ) {
      e.preventDefault()
      onInteractionModeChange(interactionMode === 'code' ? 'plan' : 'code')
      return
    }

    if (e.key === 'Enter' && !e.shiftKey && !isMobile) {
      e.preventDefault()
      submit(isStreaming ? deliveryForKey(e) : 'steer')
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
    setValue(nextValue)
    setHistoryIndex(-1)
    setMenuIndex(0)
    // ``selectionStart`` is already at the post-change caret position by the
    // time React fires onChange.
    const caret = e.target.selectionStart ?? nextValue.length
    const next = findActiveMention(nextValue, caret)
    if (next) onFileRefsNeeded?.()
    setMentionRange(next)
    setSnippetRange(next !== null ? null : findActiveSnippet(nextValue, caret))
    scheduleResize()
  }

  const hasText = value.trim().length > 0
  // Design feedback alone is a sendable message.
  const hasMessage = hasText || designFeedback.length > 0
  useEffect(() => {
    // Drafts include the feedback blocks, so a restored draft brings the chips back.
    onValueChange?.(designFeedback.length > 0 ? composeWithDesignFeedback(value, designFeedback) : value)
  }, [onValueChange, value, designFeedback])

  const canSend = hasMessage && !disabled
  const canStop = isStreaming && !disabled && onStop != null

  // Surface "has uncommitted content" to the parent so a minimized bar
  // can re-expand when the user attaches a file via the slim strip.
  // Edge-triggered on the boolean — not on the underlying length values —
  // so we only re-render the parent when crossing 0↔1.
  const hasContent = hasMessage || files.length > 0
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

  const feedbackChips = designFeedback.length > 0 ? (
    <DesignFeedbackStrip
      items={designFeedback}
      below={filesBelow}
      onRemove={(index) => {
        const removed = designFeedback[index]
        setDesignFeedback((prev) => prev.filter((_, i) => i !== index))
        if (removed) onDesignFeedbackRemoved?.(removed)
      }}
    />
  ) : null

  // Reusable pill button styles for the action row (attach — pencil calls
  // this `inputBarAttach`: 32×32 rounded controls, warm card fill).
  // ``active:scale-90`` gives a tactile press response on touch (``hover``
  // never fires on a finger), and ``motion-reduce`` opts out for users who
  // disable animation. The transition is transform+color only — both
  // GPU-cheap, no layout.
  const actionBtnClass =
    'flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-(--color-border) bg-(--bg-card) text-(--color-text-2) transition duration-(--motion-instant) hover:bg-(--bg-key) hover:text-(--color-text) active:scale-90 active:bg-(--bg-key) motion-reduce:transition-none motion-reduce:active:scale-100 disabled:cursor-not-allowed disabled:opacity-50 md:h-7 md:w-7'

  // Two states share one DOM tree: minimized, and expanded. Expanded always
  // puts the textarea on its own full-width row (the slot's flex-basis:100%)
  // with the action buttons wrapping onto the row below — no DOM reordering,
  // no content-dependent layout flip.
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
      className={actionBtnClass}
    >
      <Paperclip size={14} aria-hidden="true" />
    </button>
  )

  const chatEl = minimized ? (
    <button
      ref={expandButtonRef}
      type="button"
      onClick={(e) => { stopClick(e); handleExpand() }}
      aria-label="Expand input bar"
      className={actionBtnClass}
    >
      <MessageCircle size={14} aria-hidden="true" />
    </button>
  ) : null

  const effectivePlaceholder = disabled
    ? 'Waiting for response…'
    : isStreaming
      ? 'Steer or queue a follow-up…'
      : placeholder

  const activePopupId = menu?.id
  const activeOptionId = menu ? `${menu.id}-option-${activeIndex}` : undefined



  // DESIGN.md `button-send`: the one inverted surface, a full pill. Stop takes
  // the same slot and shape while a turn runs — neutral ink, not an error red.
  const sendSlotClass =
    'flex h-8 w-8 shrink-0 items-center justify-center rounded-full border transition duration-(--motion-instant) active:scale-90 motion-reduce:transition-none motion-reduce:active:scale-100 md:h-7 md:w-7'
  const sendPillClass = 'border-(--bg-send) bg-(--bg-send) text-(--color-text-on-accent) hover:opacity-90'

  // Mid-turn, Send splits: the pill steers, the chevron offers the other ways.
  const mac = isPrimaryModifierOS(os)
  const splitSend = isStreaming && hasMessage && !disabled

  const sendOrStopEl = canStop && !hasMessage ? (
    <button
      type="button"
      onClick={(e) => { stopClick(e); onStop?.() }}
      aria-label="Stop generation"
      className={cn(sendSlotClass, sendPillClass)}
    >
      <Square size={11} fill="currentColor" aria-hidden="true" />
    </button>
  ) : splitSend ? (
    <div role="group" aria-label="Send" className="flex shrink-0">
      <button
        type="button"
        onClick={(e) => { stopClick(e); submit('steer') }}
        aria-label="Steer the running turn"
        aria-keyshortcuts="Enter"
        className={cn(sendSlotClass, sendPillClass, 'rounded-r-none')}
      >
        <ArrowUp size={14} aria-hidden="true" />
      </button>
      <DeliveryMenu className={DELIVERY_TRIGGER_CLASS} mac={mac} showShortcuts={!isMobile} onPick={submit} />
    </div>
  ) : (
    <button
      type="button"
      onClick={(e) => {
        stopClick(e)
        submit()
      }}
      disabled={!canSend}
      aria-label="Send message"
      className={cn(
        sendSlotClass,
        'disabled:cursor-not-allowed disabled:opacity-50',
        canSend
          ? sendPillClass
          : 'border-(--color-border) bg-(--bg-card) text-(--color-text-2)',
      )}
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
      className={`flex w-full items-center transition-opacity duration-(--motion-fast) ${
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
        onCompositionStart={() => setIsComposing(true)}
        onCompositionEnd={() => setIsComposing(false)}
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
          if (findActiveMention(value, e.currentTarget.selectionStart ?? value.length)) onFileRefsNeeded?.()
        }}
        onBlur={() => {
          const canMinimize = value.trim().length === 0 && files.length === 0 && designFeedback.length === 0
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
        className={cn(
          'block w-full resize-none scrollbar-none overscroll-contain bg-transparent p-0 align-middle text-sm leading-relaxed break-words caret-(--color-text) placeholder-(--color-text-subtle) selection:bg-(--color-accent)/30 selection:text-(--color-text) outline-none focus:outline-none focus-visible:outline-none disabled:opacity-50',
          isComposing ? 'text-(--color-text)' : 'text-transparent',
        )}
        // Cap matches the ``resize()`` ceiling in InputComposer.autosize.ts so the
        // JS-driven height and the CSS limit stay in lockstep.
        style={{ maxHeight: `${MAX_TEXTAREA_HEIGHT}px` }}
        // Spellcheck disabled: the squiggle is painted by the browser under
        // the textarea's own glyphs, but the visible text comes from the
        // overlay mirror. Even with identical font/wrap/scroll the two
        // text-layout paths drift by 1–2px, leaving the squiggle a word
        // off. Same call Discord/Slack/ChatGPT make for the same reason.
        spellCheck={false}
        // Prompts carry code and paths: on desktop, no smart quotes, dashes
        // or autocapitalised identifiers. Phone keyboards keep theirs.
        autoCorrect={isMobile ? undefined : 'off'}
        autoCapitalize={isMobile ? undefined : 'off'}
        aria-label="Message input"
        aria-expanded={menu !== null}
        aria-controls={activePopupId}
        aria-activedescendant={activeOptionId}
      />
      </div>
    </div>
  )

  const pillClassName = `relative block rounded-lg border bg-(--color-surface) transition-[border-color,box-shadow,background-color] duration-(--motion-base) ${
    minimized
      ? 'w-fit border-(--color-border) shadow-sm hover:bg-(--bg-key)'
      : 'w-full border-(--color-border-strong) shadow-md focus-within:ring-2 focus-within:ring-(--focus-ring)/30'
  }`

  const pillInner = (
    // Click-anywhere-to-expand on bare strip whitespace. Action buttons call
    // stopClick so they don't trigger this. No ARIA role — the Send button is
    // the keyboard-accessible "Expand input bar" affordance.
    <div
      onClick={minimized ? handleExpand : undefined}
      className={`flex w-full flex-wrap items-center gap-2 ${minimized ? 'cursor-text' : ''}`}
    >
      {attachEl}
      {chatEl}
      {!minimized && onInteractionModeChange && (
        <SessionModeToggle
          mode={interactionMode}
          pending={interactionModePending}
          onChange={onInteractionModeChange}
          disabled={interactionModeDisabled}
        />
      )}
      {/* Slot snaps w-0 ↔ flex-1 in lockstep with the card's w-fit ↔ w-full.
          ``-ml-2`` absorbs the parent gap-2 when collapsed. Expanded always
          takes the full row (flex-basis:100%, order:-1) so the textarea sits
          above the action buttons. */}
      <div
        style={!minimized ? { flexBasis: '100%', order: -1 } : undefined}
        className={`min-w-0 overflow-hidden ${minimized ? 'w-0 -ml-2' : 'flex-1'}`}
      >
        {messageSlot}
      </div>
      {/* Spacer pushes Send to the right edge of the action-button row. */}
      {!minimized && <div className="flex-1" />}
      {sendOrStopEl}
    </div>
  )

  // Mobile renders a plain ``div`` — no framer-motion. The pill has no
  // animation on mobile (no ``layout``, static padding), and rendering it
  // through ``motion.div`` still made framer reconcile inline styles on every
  // minimize toggle, which flickered in the WebView. A bare div makes the
  // toggle a pure, cheap class swap. Desktop keeps the polished morph.
  //
  // Desktop deliberately omits ``layout``. ``value`` is local state, so the
  // composer re-renders on every keystroke, and a ``layout`` node is measured
  // by framer's projection pass on every render — 2 forced
  // ``getBoundingClientRect`` calls per typed character. Measured with
  // ``bun scripts/bench-motion-layout.mjs``; pinned by
  // ``InputComposer.layout-perf.test.tsx``. The padding animation below is free
  // while typing (it only retargets on the minimize toggle).
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
        {!minimized && !filesBelow && feedbackChips}

        <InputComposerSuggestions
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
        {!minimized && filesBelow && feedbackChips}

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
