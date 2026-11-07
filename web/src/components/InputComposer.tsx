import { useRef, useState, useCallback, useImperativeHandle, forwardRef, useEffect, useMemo, type ReactNode } from 'react'
import { ArrowUp, Loader2, Paperclip, Square } from 'lucide-react'
import { FilePreviewStrip } from './FilePreviewStrip'
import { Collapsible } from '@/components/ui/collapsible'
import { useHasSwapped } from '@/components/ui/swap'
import { DesignFeedbackStrip } from './DesignFeedbackViews'
import { findActiveMention, getExplicitMentionRanges, type FileRef } from './InputComposer.mentions'
import { COMPOSER_TEXT_CLASS, MentionOverlay } from './InputComposer.overlay'
import { findActiveSnippet } from './InputComposer.helpers'
import { InputComposerSuggestions } from './InputComposer.suggestions'
import { useInputComposerSuggestionEngine } from './InputComposer.suggestionEngine'
import { composerMaxHeight, useComposerScrollThumb, useTextareaAutosize } from './InputComposer.autosize'
import type { AppShortcutName } from '@/lib/app-shortcuts'
import type { AgentCapabilities, SessionInteractionMode } from '@/api/types'
import { buildAcceptString } from './InputComposer.files'
import { useInputComposerAttachments } from './InputComposer.attachments'
import { DeliveryMenu } from './InputComposer.deliveryMenu'
import { cn } from '@/lib/utils'
import { composeWithDesignFeedback, designFeedbackMentions, splitDesignFeedback, type DesignFeedback } from '@/lib/design-feedback'
import { buildHistoryEntries } from './InputComposer.menus'
import { useIsMobile } from '@/hooks/use-mobile'
import { usePlatform } from '@/hooks/use-platform'
import { isPrimaryModifierOS } from '@/lib/keyboard-shortcut'
import { focusQuietly } from '@/lib/focus/quiet'
import { mediumHapticFeedback, selectionHapticFeedback, softHapticFeedback } from '@/lib/haptics'
import { useIsPhone } from '@/hooks/use-is-phone'
import { useLongPress } from '@/hooks/use-long-press'
import { ActionSheet } from '@/components/ui/action-sheet'
import { SessionModeToggle } from './SessionModeToggle'
import type { ComposerActions } from './composer/PlusMenu'
import { canPickNatively, pickNatively } from '@/lib/native-pick'
import { useShortcut } from '@/lib/keyboard/hooks'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

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
  /** The app shortcut that does the same, shown beside the command on desktop. */
  shortcut?: AppShortcutName
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
  // Same height as the Steer half on every pointer: the Dropdown's own
  // touch minimum (36px) would otherwise leave it taller than a 32px pill.
  // ``relative``: it paints over the Steer half's grown touch area, so a tap
  // on the chevron opens the chevron.
  'relative flex h-8 min-h-0 w-5 shrink-0 items-center justify-center gap-0 rounded-l-none rounded-r-full border-0 border-l border-l-(--color-text-on-accent)/20 bg-(--bg-send) px-0 py-0 text-(--color-text-on-accent) hover:bg-(--bg-send) hover:opacity-90 hover:shadow-none active:bg-(--bg-send) pointer-coarse:min-h-0 md:h-7 pointer-coarse:h-9 [&>span]:hidden [&_svg]:text-(--color-text-on-accent)'

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
  /**
   * Why a message cannot go out now (the server does not answer). Send is
   * disabled with this as its description and Enter sends nothing, but the
   * box stays editable and keeps the draft.
   */
  sendBlockedReason?: string | null
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
   * top border, no background row chrome). The parent (``Composer``)
   * provides the placement around it.
   */
  floating?: boolean
  /**
   * When true, file previews render below the input container instead of
   * above it: the new-session screen's centered composer.
   */
  filesBelow?: boolean
  suggestionsBelow?: boolean
  /**
   * The run deck's "+" control, given what it may do to the draft. Without
   * it the row shows a plain Attach button.
   */
  renderPlus?: (actions: ComposerActions) => ReactNode
  /** Run deck controls after the mode toggle (the run chip, the MCP chip). */
  deck?: ReactNode
  /** Run deck controls just before Send (the context ring). */
  deckEnd?: ReactNode
  /** Forwarded to the textarea. */
  onFocus?: () => void
  /**
   * Fired when the textarea blurs. ``empty`` is ``false`` while the input
   * holds uncommitted content (text, attachments or design feedback).
   */
  onBlur?: (empty: boolean) => void
  /**
   * Called whenever uncommitted content (text or attachments) appears or
   * disappears.
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
   * ``expand: false`` hands focus back quietly (no focus ring): a page load
   * or a closing panel, not the user steering to the composer.
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
  sendBlockedReason = null,
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
  renderPlus,
  deck,
  deckEnd,
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
  const isMobile = useIsMobile()
  const { os } = usePlatform()

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
  // Desktop only: a phone's box keeps its own scroll indicator.
  const scrollThumb = useComposerScrollThumb(textareaRef, !isMobile, value)

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
    minimized: false,
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
      const el = textareaRef.current
      if (!el) return
      // Handing focus back (page load, panel close) isn't keyboard-steered,
      // but a script focus() on a fresh page counts as :focus-visible. Focus
      // quietly then: Tab still continues from here.
      if (options?.expand === false) focusQuietly(el, {})
      // No scroll: the docked composer is on screen, and iOS scrolling the
      // page to it as the keyboard rises shoved the whole shell up.
      else el.focus({ preventScroll: true })
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

  const setTextareaRef = useCallback((node: HTMLTextAreaElement | null) => {
    textareaRef.current = node
  }, [])

  const submit = useCallback((delivery: SendDelivery = 'steer') => {
    if (disabled || sendBlockedReason) return
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
  }, [disabled, sendBlockedReason, value, files, isStreaming, onSubmit, mentions, designFeedback, resetDraftState, resetHeightNow, setFiles, setMenuIndex])

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
      onInteractionModeChange &&
      !interactionModeDisabled
    ) {
      e.preventDefault()
      selectionHapticFeedback()
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

  const canSend = hasMessage && !disabled && !sendBlockedReason
  const canStop = isStreaming && !disabled && onStop != null

  // Surface "has uncommitted content" to the parent so a minimized bar
  // can re-expand when the user attaches a file via the slim strip.
  // Edge-triggered on the boolean — not on the underlying length values —
  // so we only re-render the parent when crossing 0↔1.
  const hasContent = hasMessage || files.length > 0

  // Desktop: Esc in an empty composer stops the run, as in agent CLIs
  // (desktop mockup 5.1). A region key (lib/keyboard/dispatcher): an open
  // menu, popover or dialog takes Escape first, and the picker's own Escape
  // is handled on the textarea before this. A draft keeps Esc harmless.
  useShortcut({ key: 'Escape' }, () => {
    if (hasContent) return false
    onStop?.()
  }, { enabled: !isMobile && canStop, within: () => textareaRef.current })
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
  // The strip folds open (ui/collapsible) as the first file lands, instead of
  // pushing the composer, and the transcript above it, up in one frame.
  const filePreviews = (
    <Collapsible open={files.length > 0}>
      {files.length > 0 && (
        <FilePreviewStrip
          files={files}
          blobUrls={blobUrls}
          onRemove={removeFile}
          filesBelow={filesBelow}
        />
      )}
    </Collapsible>
  )

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

  // Icon controls on the action row are borderless (DESIGN.md → Buttons):
  // ghost at rest, keycap fill on hover. The run deck's steps, as Send: 28px
  // on desktop, 32px in a narrow mouse window, 36px on touch (a phone too,
  // where the touch area grows to 44px).
  const actionBtnClass =
    'relative touch-hit flex size-8 shrink-0 items-center justify-center rounded-sm text-(--color-text-muted) transition-[color,background-color,scale] duration-(--motion-instant) hover:bg-(--bg-key) hover:text-(--color-text) active:bg-(--color-border-subtle) dark:active:bg-(--color-border) pointer-coarse:active:scale-90 motion-reduce:active:scale-100 disabled:cursor-not-allowed disabled:opacity-50 md:size-7 pointer-coarse:size-9'

  const stopClick = (e: React.MouseEvent) => e.stopPropagation()

  // Phone: tapping Send, Steer, Stop or the mode toggle must not move focus
  // out of the textarea, or iOS drops the keyboard mid-conversation. Holding
  // the press's default keeps focus where it is; ``refocusAfterTap`` catches
  // a WebView that blurs anyway, still inside the tap so the keyboard stays.
  const hadFocusOnPressRef = useRef(false)
  const keepKeyboard: {
    onPointerDown?: (e: React.PointerEvent) => void
    onMouseDown?: (e: React.MouseEvent) => void
  } = isMobile
    ? {
        onPointerDown: (e: React.PointerEvent) => {
          hadFocusOnPressRef.current = document.activeElement === textareaRef.current
          if (hadFocusOnPressRef.current) e.preventDefault()
        },
        onMouseDown: (e: React.MouseEvent) => {
          if (hadFocusOnPressRef.current) e.preventDefault()
        },
      }
    : {}
  const refocusAfterTap = () => {
    if (!isMobile || !hadFocusOnPressRef.current) return
    hadFocusOnPressRef.current = false
    if (document.activeElement !== textareaRef.current) textareaRef.current?.focus({ preventScroll: true })
  }

  // What the "+" menu may do to the draft.
  const composerActions = useMemo<ComposerActions>(() => ({
    attach: (kind) => {
      if (kind && canPickNatively()) {
        void pickNatively(kind).then((picked) => { if (picked.length > 0) addAllowedFiles(picked) }).catch(() => {})
        return
      }
      fileInputRef.current?.click()
    },
    startToken: (token) => {
      const el = textareaRef.current
      const current = el?.value ?? ''
      const start = el?.selectionStart ?? current.length
      const end = el?.selectionEnd ?? start
      // A token starts a word: put a space before it unless one is there.
      const lead = start > 0 && !/\s/.test(current[start - 1] ?? '') ? ' ' : ''
      const inserted = `${lead}${token}`
      const next = current.slice(0, start) + inserted + current.slice(end)
      const caret = start + inserted.length
      setValue(next)
      setHistoryIndex(-1)
      // Now, inside the tap (the keyboard on iOS), then again with the caret.
      el?.focus({ preventScroll: true })
      requestAnimationFrame(() => {
        el?.focus({ preventScroll: true })
        el?.setSelectionRange(caret, caret)
        const mention = findActiveMention(next, caret)
        if (mention) onFileRefsNeeded?.()
        setMentionRange(mention)
        setSnippetRange(mention ? null : findActiveSnippet(next, caret))
        resize()
      })
    },
    setDraft: (text) => {
      setValue(text)
      setDesignFeedback([])
      resetDraftState()
      // Focus now, inside the gesture that asked (iOS raises the keyboard
      // only then); the caret moves to the end once the text has laid out.
      textareaRef.current?.focus({ preventScroll: true })
      resizeAfterLayout(() => {
        const el = textareaRef.current
        el?.focus({ preventScroll: true })
        el?.setSelectionRange(text.length, text.length)
      })
    },
  }), [addAllowedFiles, fileInputRef, onFileRefsNeeded, resetDraftState, resize, resizeAfterLayout, setMentionRange, setSnippetRange])

  const plusEl = renderPlus ? renderPlus(composerActions) : (
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

  const effectivePlaceholder = disabled
    ? 'Waiting for response…'
    : isStreaming
      ? 'Steer or queue a follow-up…'
      : placeholder

  const activePopupId = menu?.id
  const activeOptionId = menu ? `${menu.id}-option-${activeIndex}` : undefined

  // DESIGN.md `button-send`: the one inverted surface, a full pill. Stop takes
  // the same slot and shape while a turn runs — neutral ink, not an error red.
  // Idle with nothing to send it is a keycap, borderless like every control.
  // A press darkens it under a mouse (as a macOS control does) and gives under
  // a finger (as an iOS one does).
  // The run deck's steps: 28px on desktop, 36px on touch. A phone keeps the
  // composer compact at 36px and grows the touch area to 44px (``touch-hit``).
  const sendSlotClass =
    'relative touch-hit flex size-8 shrink-0 items-center justify-center rounded-full transition-[color,background-color,opacity,scale] duration-(--motion-instant) pointer-fine:active:opacity-80 pointer-coarse:active:scale-90 motion-reduce:active:scale-100 md:size-7 pointer-coarse:size-9'
  const sendPillClass = 'bg-(--bg-send) text-(--color-text-on-accent) hover:opacity-90'

  // Mid-turn, Send splits: the pill steers, the chevron offers the other ways.
  const mac = isPrimaryModifierOS(os)
  const splitSend = isStreaming && hasMessage && !disabled && !sendBlockedReason
  // A phone keeps one pill: a tap steers, a long press opens the ways to
  // send as an action sheet (the gesture's own medium haptic). The release
  // after a long press must not also steer.
  const isPhone = useIsPhone()
  // A phone's filled circle read larger than the deck's 36px controls beside
  // it (user request): it is drawn at 32px, its touch area still 44px.
  const sendSize = isPhone ? 'size-8!' : undefined
  const [deliverySheetOpen, setDeliverySheetOpen] = useState(false)
  const longPressedRef = useRef(false)
  const sendLongPress = useLongPress(isPhone && splitSend, () => {
    longPressedRef.current = true
    mediumHapticFeedback()
    setDeliverySheetOpen(true)
  })

  // Send ↔ Stop: the new icon springs up in the slot (not on first render).
  const sendState = canStop && !hasMessage ? 'stop' : splitSend ? 'steer' : disabled ? 'busy' : 'send'
  const iconIn = useHasSwapped(sendState) ? 'oa-icon-in' : undefined

  const stopButton = (
    <button
      type="button"
      {...keepKeyboard}
      onClick={(e) => { stopClick(e); mediumHapticFeedback(); onStop?.(); refocusAfterTap() }}
      aria-label="Stop generation"
      // Esc stops from an empty composer on desktop (see the shortcut above).
      aria-keyshortcuts={isMobile ? undefined : 'Escape'}
      className={cn(sendSlotClass, sendSize, sendPillClass)}
    >
      <Square size={12} fill="currentColor" aria-hidden="true" className={iconIn} />
    </button>
  )

  const sendOrStopEl = canStop && !hasMessage ? (
    isMobile ? stopButton : (
      <Tooltip>
        <TooltipTrigger render={stopButton} />
        <TooltipContent>Stop (Esc)</TooltipContent>
      </Tooltip>
    )
  ) : splitSend && isPhone ? (
    <>
      <button
        type="button"
        onPointerDown={(e) => { keepKeyboard.onPointerDown?.(e); sendLongPress.onPointerDown(e) }}
        onMouseDown={keepKeyboard.onMouseDown}
        onPointerMove={sendLongPress.onPointerMove}
        onPointerUp={sendLongPress.onPointerUp}
        onPointerCancel={sendLongPress.onPointerCancel}
        onPointerLeave={sendLongPress.onPointerLeave}
        onContextMenu={sendLongPress.onContextMenu}
        onClick={(e) => {
          stopClick(e)
          if (longPressedRef.current) {
            longPressedRef.current = false
            return
          }
          softHapticFeedback()
          submit('steer')
          refocusAfterTap()
        }}
        aria-label="Steer the running turn. Hold for more ways to send"
        className={cn(sendSlotClass, sendSize, sendPillClass, '[-webkit-touch-callout:none]')}
      >
        <ArrowUp size={14} aria-hidden="true" className={iconIn} />
      </button>
      <ActionSheet
        open={deliverySheetOpen}
        onClose={() => setDeliverySheetOpen(false)}
        title="Agent is running. How should this message be sent?"
        items={[
          { id: 'steer', label: 'Steer now', run: () => submit('steer') },
          { id: 'after-turn', label: 'Send after this turn finishes', run: () => submit('after-turn') },
          { id: 'interrupt', label: 'Stop and send', danger: true, run: () => submit('interrupt') },
        ]}
      />
    </>
  ) : splitSend ? (
    <div role="group" aria-label="Send" className="flex shrink-0 items-center">
      <button
        type="button"
        {...keepKeyboard}
        onClick={(e) => { stopClick(e); softHapticFeedback(); submit('steer'); refocusAfterTap() }}
        aria-label="Steer the running turn"
        aria-keyshortcuts="Enter"
        className={cn(sendSlotClass, sendPillClass, 'rounded-r-none')}
      >
        <ArrowUp size={14} aria-hidden="true" className={iconIn} />
      </button>
      <DeliveryMenu className={DELIVERY_TRIGGER_CLASS} mac={mac} showShortcuts={!isMobile} onPick={submit} />
    </div>
  ) : (
    <button
      type="button"
      {...keepKeyboard}
      onClick={(e) => {
        stopClick(e)
        if (canSend) softHapticFeedback()
        submit()
        refocusAfterTap()
      }}
      disabled={!canSend}
      aria-label="Send message"
      aria-description={sendBlockedReason ?? undefined}
      className={cn(
        sendSlotClass,
        sendSize,
        'disabled:cursor-not-allowed',
        canSend
          ? sendPillClass
          : 'bg-(--bg-key) text-(--color-text-muted)',
      )}
    >
      {disabled ? (
        <Loader2 size={14} className="animate-spin" aria-hidden="true" />
      ) : (
        <ArrowUp size={14} aria-hidden="true" className={iconIn} />
      )}
    </button>
  )

  const messageSlot = (
    <div className="flex w-full items-center">
      {/* Position context for the chip overlay. ``relative`` + ``w-full``
          keep the overlay's bounding box equal to the textarea's, so
          chips line up pixel-for-pixel with the text glyphs above them. */}
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
          const empty = value.trim().length === 0 && files.length === 0 && designFeedback.length === 0
          onBlur?.(empty)
          // Close all pickers on blur — clicks on their items use
          // ``onMouseDown`` with ``preventDefault`` so they fire before the
          // textarea blurs and the menu still gets to commit its choice.
          setMentionRange(null)
          setSnippetRange(null)
        }}
        disabled={disabled}
        placeholder={effectivePlaceholder}
        rows={1}
        autoFocus={autoFocus}
        // ``p-0`` zeroes WebKit's asymmetric default textarea padding (WKWebView
        // in the macOS Tauri shell ships ~2px top + ~1px bottom that bias the
        // single-line baseline upward). ``align-middle`` keeps the textarea's
        // bounding box centred in its row.
        //
        // ``text-transparent`` + ``caret-color`` hides the textarea's own
        // glyphs so the syntax-highlight overlay (``MentionOverlay``) is
        // the one painting visible text. The caret stays visible. The
        // placeholder is exempt from ``text-transparent`` — it's owned by
        // ``::placeholder`` and ``placeholder-(--color-text-muted)``
        // keeps it readable.
        // ``scrollbar-none`` hides the textarea's own scrollbar. Without it,
        // the textarea grows a ~15px-wide vertical scrollbar once content
        // exceeds ``maxHeight``, which narrows its inner text-width and makes
        // it wrap a few characters earlier than the overlay mirror (which
        // has no scrollbar), and the spellcheck squiggle drifts off its word.
        className={cn(
          'block w-full resize-none scrollbar-none overscroll-contain bg-transparent p-0 align-middle break-words caret-(--color-text) placeholder-(--color-text-muted) selection:bg-(--color-accent)/30 selection:text-(--color-text) outline-none focus:outline-none focus-visible:outline-none disabled:opacity-50',
          // Shared with the mirror, so the caret stays on the painted text.
          COMPOSER_TEXT_CLASS,
          isComposing ? 'text-(--color-text)' : 'text-transparent',
        )}
        // Cap matches the ``resize()`` ceiling in InputComposer.autosize.ts so the
        // JS-driven height and the CSS limit stay in lockstep.
        style={{ maxHeight: composerMaxHeight() }}
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
        // F6 lands here when it enters the composer (lib/focus-regions).
        data-region-entry=""
        aria-expanded={menu !== null}
        aria-controls={activePopupId}
        aria-activedescendant={activeOptionId}
      />
      {scrollThumb && (
        // The box's hidden scrollbar, drawn just past the text's right edge
        // so it never narrows the text (``useComposerScrollThumb``).
        <span
          aria-hidden="true"
          data-composer-scroll-thumb=""
          className="pointer-events-none absolute -right-1.5 w-[3px] rounded-full bg-(--color-border-strong)"
          style={{ top: `${Math.round(scrollThumb.top * 10_000) / 100}%`, height: `${Math.round(scrollThumb.height * 10_000) / 100}%` }}
        />
      )}
      </div>
    </div>
  )

  // The composer is an input field, so it keeps its one hairline (DESIGN.md
  // → Borders); everything inside it is borderless. ``@container`` lets the
  // run deck respond to the composer's own width (stacked chip under 520px).
  // Focus is a step along the border ramp rather than the blue input ring:
  // the composer holds focus nearly all the time, and a standing blue halo
  // on its warm border read as a stray colour. Its controls keep their own
  // focus rings.
  const pillClassName = 'oa-composer-pill @container relative block w-full rounded-lg border border-(--color-border) bg-(--color-surface) p-2 transition-[border-color] duration-(--motion-base) focus-within:border-(--color-border-strong)'

  const pill = (
    <div
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      className={pillClassName}
      data-composer-pill=""
    >
      {messageSlot}
      {/* The run deck: what to add, how it runs, and Send. */}
      <div className="mt-2 flex w-full min-w-0 items-center gap-1" data-run-deck="">
        <div
          className="contents"
          onPointerDownCapture={keepKeyboard.onPointerDown}
          onMouseDownCapture={keepKeyboard.onMouseDown}
          onClick={isMobile ? refocusAfterTap : undefined}
        >
          {plusEl}
          {onInteractionModeChange && (
            <SessionModeToggle
              mode={interactionMode}
              pending={interactionModePending}
              onChange={onInteractionModeChange}
              disabled={interactionModeDisabled}
            />
          )}
        </div>
        {deck}
        {/* A phone keeps the context ring with the run controls, away from
            Send, so a tap meant for one never lands on the other. */}
        {isPhone && deckEnd}
        <div className="min-w-0 flex-1" />
        {!isPhone && deckEnd}
        {sendOrStopEl}
      </div>
    </div>
  )

  return (
    <div className={floating ? '' : 'bg-(--bg-page) px-4 py-3'}>
      <div className={floating ? 'relative' : 'relative mx-auto max-w-3xl'}>
        {!filesBelow && filePreviews}
        {!filesBelow && feedbackChips}

        <InputComposerSuggestions
          minimized={false}
          menu={menu}
          activeIndex={activeIndex}
          optionRefs={optionRefs}
          onSelect={commit}
          suggestionsBelow={suggestionsBelow ?? filesBelow}
        />

        <div className="relative">
          {pill}
        </div>

        {filesBelow && filePreviews}
        {filesBelow && feedbackChips}

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
