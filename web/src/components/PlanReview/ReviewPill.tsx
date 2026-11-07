/**
 * The plan review's text boxes in the chat composer's shape: one framed field
 * (a single hairline, a step along the border ramp on focus, no blue ring),
 * a borderless text box that grows to six lines, and its actions in a deck
 * row inside the frame (DESIGN.md → Composer and run deck). On a phone the
 * box takes the composer's keyboard swipe: up raises the keyboard for its
 * text box, down puts it away.
 */
import { useLayoutEffect, useRef, type ComponentProps, type ReactNode, type RefObject } from 'react'
import { useComposerKeyboardSwipe } from '@/hooks/use-composer-keyboard-swipe'
import { useIsMobile } from '@/hooks/use-mobile'
import { cn } from '@/lib/utils'

export const REVIEW_PILL_CLASS =
  'relative block w-full rounded-lg border border-(--color-border) bg-(--color-surface) p-2 transition-[border-color] duration-(--motion-base) focus-within:border-(--color-border-strong)'

/** Deck buttons on a phone: the run deck's 36px step and 13px labels, a 44px touch area. */
export const REVIEW_DECK_BUTTON_CLASS = 'touch-hit relative phone:text-subhead'

export function ReviewPill({ className, children, ...props }: Omit<ComponentProps<'div'>, 'ref'>) {
  const ref = useRef<HTMLDivElement>(null)
  const mobile = useIsMobile()
  useComposerKeyboardSwipe(ref, {
    enabled: mobile,
    // No scroll: the box is docked on screen, and iOS scrolling the page to
    // it as the keyboard rises shoved the whole shell (header, tabs) up.
    focus: () => ref.current?.querySelector('textarea')?.focus({ preventScroll: true }),
  })
  return (
    <div {...props} ref={ref} className={cn(REVIEW_PILL_CLASS, className)}>
      {children}
    </div>
  )
}

/** The deck row under the text: actions on one line, never wider than the frame. */
export function ReviewDeck({ className, children }: { className?: string; children: ReactNode }) {
  return <div data-review-deck="" className={cn('mt-2 flex w-full min-w-0 items-center gap-1', className)}>{children}</div>
}

/**
 * Borderless, one line at rest, growing with its text to six lines. Sized
 * from its content in script too, since WebKit has no ``field-sizing``.
 */
export function ReviewTextarea({
  ref,
  value,
  className,
  ...props
}: Omit<ComponentProps<'textarea'>, 'ref' | 'value'> & { ref?: RefObject<HTMLTextAreaElement | null>; value: string }) {
  const own = useRef<HTMLTextAreaElement>(null)
  const node = ref ?? own
  useLayoutEffect(() => {
    const el = node.current
    if (!el) return
    el.style.height = 'auto'
    if (el.scrollHeight > 0) el.style.height = `${el.scrollHeight}px`
  }, [node, value])
  return (
    <textarea
      {...props}
      ref={node}
      value={value}
      rows={1}
      className={cn(
        'block max-h-[6lh] w-full resize-none overscroll-contain bg-transparent p-0 text-sm leading-relaxed text-(--color-text) caret-(--color-text) outline-none placeholder:text-(--color-text-muted) focus:outline-none focus-visible:outline-none disabled:opacity-50 phone:text-xs',
        className,
      )}
    />
  )
}
