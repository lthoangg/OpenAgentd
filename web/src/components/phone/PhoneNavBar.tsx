/**
 * PhoneNavBar — a pushed screen's bar on a phone: ‹ and the parent's name
 * on the left, the title, the screen's actions on the right. The app
 * header's height (44px) under the safe area, a semibold ``text-base`` title.
 *
 * iOS centres the title: both sides grow from nothing by the same share
 * (``flex-1``) but never below their own content, and the title, which may
 * shrink, truncates first; so a long title never runs under ‹ Sessions or
 * the actions, and a short one sits in the middle. Android puts a ← with no
 * label and the title beside it, left-aligned, as Material's top app bar
 * does. The back control is a bare glyph whose accessible name says where it goes.
 *
 * Back is in the accent (iOS's tint), regular weight, its chevron 20px as the
 * phone header's icons are (DESIGN.md → Rulebook 4).
 */
import { ArrowLeft, ChevronLeft } from 'lucide-react'
import type { ReactNode } from 'react'

import { Button } from '@/components/ui/button'
import { usePlatform } from '@/hooks/use-platform'
import { cn } from '@/lib/utils'

export interface PhoneNavBarProps {
  title: ReactNode
  /** A second line under the title (a session's workspace). */
  subtitle?: ReactNode
  /** Back to the parent screen, named by its title ("Sessions"). */
  back?: { label: string; onBack: () => void }
  /** Shown where back would be, on a root screen. */
  leading?: ReactNode
  trailing?: ReactNode
  /**
   * When the bottom hairline shows: ``always``, or ``scrolled`` (only once
   * the chat's transcript scrolls under the bar, as an iOS bar does).
   */
  separator?: 'always' | 'scrolled'
  /** ``start`` left-aligns the title on iOS too (the chat bar). */
  titleAlign?: 'center' | 'start'
  className?: string
}

/**
 * A bare tint, no fill: iOS dims a pressed bar button instead. Drawn at the
 * phone's control step; ``touch-hit`` keeps a 44px target.
 */
const BACK_CLASS = 'relative touch-hit h-(--phone-control) min-w-(--phone-control) bg-transparent! font-normal text-(--color-accent)! active:opacity-50'

/**
 * A bare ‹ (iOS) or ← (Android), named for the parent: the back control of
 * a pushed screen's bar, and of the Sessions screen's bar (‹ Servers).
 */
export function PhoneBackButton({ label, onBack }: { label: string; onBack: () => void }) {
  const android = usePlatform().os === 'android'
  return (
    <Button
      type="button"
      variant="ghost"
      size="trigger"
      onClick={onBack}
      aria-label={`Back to ${label}`}
      data-phone-back=""
      // A bare glyph on both (user request): the bar stays clear for the
      // title; the button's name still says where it goes.
      className={cn(BACK_CLASS, android ? 'px-0' : 'justify-start pl-0')}
    >
      {android ? (
        <ArrowLeft size={20} aria-hidden="true" className="size-5" />
      ) : (
        <ChevronLeft size={20} strokeWidth={2.25} aria-hidden="true" className="-ml-1 size-5" />
      )}
    </Button>
  )
}

export function PhoneNavBar({ title, subtitle, back, leading, trailing, separator = 'always', titleAlign = 'center', className }: PhoneNavBarProps) {
  const android = usePlatform().os === 'android'
  const start = android || titleAlign === 'start'

  const titleBlock = (
    <div data-phone-nav-title="" className={cn('min-w-0', start ? 'flex-1 text-left' : 'shrink text-center')}>
      {/* With a second line, both sit tight as an iOS two-line title: the
          pair centres in the bar instead of crowding its edges. */}
      <h1 className={cn('truncate text-base font-semibold text-(--color-text)', subtitle != null && 'leading-tight')}>{title}</h1>
      {subtitle != null && <div className="truncate text-meta leading-tight text-(--color-text-muted)">{subtitle}</div>}
    </div>
  )

  const backButton = back && <PhoneBackButton label={back.label} onBack={back.onBack} />

  return (
    <header
      data-phone-nav-bar=""
      className={cn(
        'mobile-safe-header shrink-0 select-none border-b bg-(--bg-page) px-2',
        separator === 'always'
          ? 'border-(--color-border)'
          : 'border-transparent transition-colors duration-(--motion-fast) in-data-[transcript-scrolled]:border-(--color-border)',
        android
          ? 'flex items-center gap-2'
          : 'flex items-center gap-1',
        className,
      )}
    >
      {start ? (
        <>
          {backButton ?? leading}
          {titleBlock}
          {trailing && <div className="flex shrink-0 items-center">{trailing}</div>}
        </>
      ) : (
        <>
          <div className="flex flex-1 items-center justify-start">{backButton ?? leading}</div>
          {titleBlock}
          <div className="flex flex-1 items-center justify-end">{trailing}</div>
        </>
      )}
    </header>
  )
}
