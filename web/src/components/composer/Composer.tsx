/**
 * Composer — the message box, docked to the bottom of the chat column.
 *
 * Always open, never dragged: the run deck under the text shows how the next
 * message runs, so it has to stay in view. Above it sits the tray: the
 * jump-to-latest chip, side questions and the undo notice. The tray is inside
 * the measured, docked element, so the transcript always ends above its last
 * row. Messages waiting for the agent are not here: they sit at the bottom of
 * the transcript, faded, under the turn they wait behind. The column is
 * 768px at most, the transcript's prose width, so text and box line up.
 *
 * ``placement="inline"`` is the new-session screen's centered composer. Its
 * first message hands off to the docked composer with a short glide from
 * where it sat (skipped under reduced motion).
 */
import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, type ReactNode } from 'react'

import {
  InputComposer,
  type FileRef,
  type InputComposerHandle,
  type SendDelivery,
  type SlashCommand,
  type SnippetCommand,
} from '../InputComposer'
import { JumpToLatestChip } from '../JumpToLatestChip'
import { RevertNotice } from '../RevertNotice'
import type { ComposerActions } from './PlusMenu'
import { useIsMobile } from '@/hooks/use-mobile'
import { useReducedMotion } from '@/hooks/useReducedMotion'
import { DURATIONS_S, EASINGS } from '@/lib/motion'
import type { AgentCapabilities, SessionInteractionMode } from '@/api/types'
import type { DesignFeedback } from '@/lib/design-feedback'

/** Where the centered composer sat when the first message was sent. */
export interface ComposerHandoff {
  rect: { left: number; top: number; width: number; height: number }
  /** Its textarea had focus: the docked composer takes it back. */
  focused: boolean
}

export interface ComposerProps {
  onSubmit: (message: string, files?: File[], mentions?: string[], delivery?: SendDelivery) => void
  onStop?: () => void
  onSlashCommand?: (id: string) => void
  onSnippetCommand?: (id: string) => Promise<string | null> | string | null
  slashCommands?: SlashCommand[]
  snippetCommands?: SnippetCommand[]
  fileRefs?: FileRef[]
  onFileRefsNeeded?: () => void
  isStreaming?: boolean
  disabled?: boolean
  placeholder?: string
  autoFocus?: boolean
  capabilities?: AgentCapabilities
  interactionMode?: SessionInteractionMode
  interactionModePending?: boolean
  onInteractionModeChange?: (mode: SessionInteractionMode) => void
  interactionModeDisabled?: boolean
  revertedCount?: number
  revertedMessages?: Array<{ role: string; content: string }>
  onRedo?: () => void
  onRedoAll?: () => void
  historyPrompts?: string[]
  onHistoryRecall?: (prompt: string | null) => void
  onDesignFeedbackRemoved?: (feedback: DesignFeedback) => void
  onValueChange?: (value: string) => void
  /** The run deck's "+" control. */
  renderPlus?: (actions: ComposerActions) => ReactNode
  /** Run deck controls after Code/Plan, and before Send. */
  deck?: ReactNode
  deckEnd?: ReactNode
  /** In the tray above the box: the side-question panel or its chip. */
  aboveComposer?: ReactNode
  placement?: 'docked' | 'inline'
  /** Inline only: reports where the composer sat, just before each submit. */
  onHandoffCapture?: (snapshot: ComposerHandoff) => void
  /** Docked only, read once at mount: glide in from the new-session composer. */
  enterFrom?: ComposerHandoff | null
}

/** The glide's curve: DESIGN.md ``slow`` (route changes) on the entrance ease-out. */
const GLIDE_EASING = `cubic-bezier(${EASINGS.out.join(', ')})`

export const Composer = memo(forwardRef<InputComposerHandle, ComposerProps>(function Composer({
  aboveComposer,
  placement = 'docked',
  onHandoffCapture,
  enterFrom = null,
  ...inputProps
}, ref) {
  const isMobile = useIsMobile()
  const reducedMotion = useReducedMotion()
  const rootRef = useRef<HTMLDivElement>(null)
  const innerRef = useRef<InputComposerHandle | null>(null)
  useImperativeHandle(ref, () => ({
    focus: (options) => innerRef.current?.focus(options),
    setValue: (text) => innerRef.current?.setValue(text),
    appendValue: (text, options) => innerRef.current?.appendValue(text, options),
    addDesignFeedback: (feedback) => innerRef.current?.addDesignFeedback(feedback),
    insertText: (text) => innerRef.current?.insertText(text),
    setFiles: (files) => innerRef.current?.setFiles(files),
    addFiles: (files) => innerRef.current?.addFiles(files),
    restoreLastSubmission: () => innerRef.current?.restoreLastSubmission(),
  }), [])

  const onSubmitRef = useRef(inputProps.onSubmit)
  useEffect(() => { onSubmitRef.current = inputProps.onSubmit })
  const onHandoffCaptureRef = useRef(onHandoffCapture)
  useEffect(() => { onHandoffCaptureRef.current = onHandoffCapture })
  // Inline: measure before the message goes out, because the send ends the
  // draft and unmounts this composer in the same render.
  const handleSubmit = useCallback((message: string, files?: File[], mentions?: string[], delivery?: SendDelivery) => {
    const node = rootRef.current
    const capture = onHandoffCaptureRef.current
    if (node && capture) {
      const r = node.getBoundingClientRect()
      capture({
        rect: { left: r.left, top: r.top, width: r.width, height: r.height },
        focused: document.activeElement instanceof Node && node.contains(document.activeElement),
      })
    }
    onSubmitRef.current(message, files, mentions, delivery)
  }, [])

  // The hand-off: start where the centered composer was and settle here.
  // Measured before the first paint, so no frame shows the box landed early.
  // Read once at mount: a later prop never moves a box already on screen.
  const mountRef = useRef({ from: enterFrom, docked: placement === 'docked', still: reducedMotion || isMobile })
  useLayoutEffect(() => {
    const { from, docked, still } = mountRef.current
    const node = rootRef.current
    if (!from || !node || !docked) return
    if (from.focused) innerRef.current?.focus({ expand: false })
    if (still || typeof node.animate !== 'function') return
    const to = node.getBoundingClientRect()
    if (to.width <= 0) return
    const dx = Math.round(from.rect.left + from.rect.width / 2 - (to.left + to.width / 2))
    const dy = Math.round(from.rect.top + from.rect.height - to.bottom)
    node.animate(
      [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'translate(0, 0)' }],
      { duration: DURATIONS_S.slow * 1000, easing: GLIDE_EASING },
    )
  }, [])

  // Paste anywhere that is not a text field goes into the message, so a
  // screenshot or a log can be dropped in without clicking the box first.
  useEffect(() => {
    if (isMobile || placement !== 'docked') return
    const onPaste = (e: ClipboardEvent) => {
      const target = e.target as HTMLElement | null
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target?.isContentEditable ||
        target?.closest?.('[role="dialog"], [data-review-dock]')
      ) return
      const cd = e.clipboardData
      if (!cd) return
      const files = Array.from(cd.items).filter((item) => item.kind === 'file').map((item) => item.getAsFile()).filter((f): f is File => f !== null)
      const text = files.length > 0 ? '' : cd.getData('text/plain')
      if (files.length === 0 && !text) return
      e.preventDefault()
      if (files.length > 0) innerRef.current?.addFiles(files)
      else innerRef.current?.appendValue(text)
      innerRef.current?.focus()
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [isMobile, placement])

  // Publish the docked composer's height on the workbench center as
  // ``--composer-h``: a Review panel overlaying a narrow chat stops there.
  const dockedRef = useRef<HTMLDivElement>(null)
  const docked = !(placement === 'inline' && !isMobile)
  useLayoutEffect(() => {
    const node = dockedRef.current
    const center = node?.closest<HTMLElement>('[data-workbench-center]')
    if (!node || !center || !docked) return
    // Only on a real change: every element in the center (the transcript)
    // inherits it, and a width-only resize (a panel sliding) changes nothing.
    const publish = () => {
      const height = `${Math.round(node.getBoundingClientRect().height)}px`
      if (center.style.getPropertyValue('--composer-h') !== height) center.style.setProperty('--composer-h', height)
    }
    publish()
    if (typeof ResizeObserver === 'undefined') return () => center.style.removeProperty('--composer-h')
    const observer = new ResizeObserver(publish)
    observer.observe(node)
    return () => {
      observer.disconnect()
      center.style.removeProperty('--composer-h')
    }
  }, [docked])

  const tray = (
    <>
      <JumpToLatestChip />
      {aboveComposer}
      <RevertNotice count={inputProps.revertedCount ?? 0} messages={inputProps.revertedMessages ?? []} onRedo={inputProps.onRedo} onRedoAll={inputProps.onRedoAll} />
    </>
  )

  const composer = (
    <InputComposer
      ref={innerRef}
      floating
      filesBelow={placement === 'inline' && !isMobile}
      suggestionsBelow={placement === 'inline' && !isMobile}
      {...inputProps}
      onSubmit={handleSubmit}
    />
  )

  if (placement === 'inline' && !isMobile) {
    return (
      <div ref={rootRef} data-testid="inline-inputbar-container" data-focus-region="composer" className="relative mx-auto w-full max-w-[640px]">
        {aboveComposer}
        {composer}
      </div>
    )
  }

  return (
    // In the column's flow, so the transcript ends where the box begins and
    // nothing is ever hidden under it. Phones clear the home indicator; the
    // shell itself rides up with the soft keyboard (``useMobileViewportGuards``).
    <div
      ref={dockedRef}
      data-testid="docked-composer"
      data-focus-region="composer"
      className={isMobile ? 'relative shrink-0 bg-(--bg-page) px-2 pb-safe pt-1.5' : 'relative shrink-0 bg-(--bg-page) px-3 pb-3 pt-1 sm:px-4'}
    >
      <div ref={rootRef} className="relative mx-auto w-full max-w-3xl">
        {tray}
        {composer}
      </div>
    </div>
  )
}))
