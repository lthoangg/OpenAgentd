/**
 * Send, and Stop while a turn runs: the one inverted pill in the composer.
 * Mid-turn with a draft it splits into Steer and a chevron of the other ways
 * to send (deliveries.ts); a phone keeps one pill and offers them on a long
 * press instead.
 */
import { useState, useRef } from 'react'
import { ArrowUp, Loader2, Square } from 'lucide-react'
import { useHasSwapped } from '@/components/ui/swap'
import { ActionSheet } from '@/components/ui/action-sheet'
import { usePlatform } from '@/hooks/use-platform'
import { useLongPress } from '@/hooks/use-long-press'
import { mediumHapticFeedback, softHapticFeedback } from '@/lib/haptics'
import { cn } from '@/lib/utils'
import { DELIVERIES, type SendDelivery } from './deliveries'
import { DeliveryMenu } from './deliveryMenu'
import type { KeepKeyboardHandlers } from './keepKeyboard'

/** The chevron half of the split Send pill. */
const DELIVERY_TRIGGER_CLASS =
  // Same height as the Steer half on every pointer: the Dropdown's own
  // touch minimum (36px) would otherwise leave it taller than a 32px pill.
  // ``relative``: it paints over the Steer half's grown touch area, so a tap
  // on the chevron opens the chevron.
  'relative flex h-8 min-h-0 w-5 shrink-0 items-center justify-center gap-0 rounded-l-none rounded-r-full border-0 border-l border-l-(--color-text-on-accent)/20 bg-(--bg-send) px-0 py-0 text-(--color-text-on-accent) hover:bg-(--bg-send) hover:opacity-90 hover:shadow-none active:bg-(--bg-send) pointer-coarse:min-h-0 md:h-7 pointer-coarse:h-9 [&>span]:hidden [&_svg]:text-(--color-text-on-accent)'

export function SendButton({
  hasMessage,
  isStreaming,
  disabled,
  sendBlockedReason,
  onStop,
  submit,
  keepKeyboard,
  refocusAfterTap,
  isMobile,
  isPhone,
}: {
  /** The draft has text or design feedback to send. */
  hasMessage: boolean
  isStreaming: boolean
  disabled?: boolean
  sendBlockedReason: string | null
  onStop?: () => void
  submit: (delivery?: SendDelivery) => void
  keepKeyboard: KeepKeyboardHandlers
  refocusAfterTap: () => void
  isMobile: boolean
  isPhone: boolean
}) {
  const { os } = usePlatform()
  const canSend = hasMessage && !disabled && !sendBlockedReason
  const canStop = isStreaming && !disabled && onStop != null
  const stopClick = (e: React.MouseEvent) => e.stopPropagation()

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
  const splitSend = isStreaming && hasMessage && !disabled && !sendBlockedReason
  // A phone keeps one pill: a tap steers, a long press opens the ways to
  // send as an action sheet (the gesture's own medium haptic). The release
  // after a long press must not also steer.
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

  return canStop && !hasMessage ? (
    <button
      type="button"
      {...keepKeyboard}
      onClick={(e) => { stopClick(e); mediumHapticFeedback(); onStop?.(); refocusAfterTap() }}
      aria-label="Stop generation"
      className={cn(sendSlotClass, sendSize, sendPillClass)}
    >
      <Square size={12} fill="currentColor" aria-hidden="true" className={iconIn} />
    </button>
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
        items={DELIVERIES.map(({ id, label, hint }) => ({ id, label, hint, danger: id === 'interrupt', run: () => submit(id) }))}
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
      <DeliveryMenu className={DELIVERY_TRIGGER_CLASS} os={os} showShortcuts={!isMobile} onPick={submit} />
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
}
