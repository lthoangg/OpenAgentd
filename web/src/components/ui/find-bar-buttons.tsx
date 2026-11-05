/**
 * The step and close buttons of a find bar (find in session, find in the
 * terminal): Previous, Next, then the one ×. Shared so the two bars cannot
 * drift. 28px, the height of the bar's input; touch gets `Button`'s floor.
 */
import { ChevronDown, ChevronUp } from 'lucide-react'

import { Button, type ButtonProps } from '@/components/ui/button'
import { CloseButton } from '@/components/ui/close-button'

/** A ghost icon button sized for a find bar (also the terminal bar's Match case). */
export function FindBarButton(props: Omit<ButtonProps, 'variant' | 'size'>) {
  return <Button type="button" variant="ghost" size="icon-dense" {...props} />
}

export function FindBarButtons({ onPrevious, onNext, onClose, stepDisabled }: {
  onPrevious: () => void
  onNext: () => void
  onClose: () => void
  /** Nothing to step through (no query, or no match). */
  stepDisabled: boolean
}) {
  return (
    <>
      <FindBarButton onClick={onPrevious} disabled={stepDisabled} aria-label="Previous match (Shift+Enter)">
        <ChevronUp size={14} aria-hidden="true" />
      </FindBarButton>
      <FindBarButton onClick={onNext} disabled={stepDisabled} aria-label="Next match (Enter)">
        <ChevronDown size={14} aria-hidden="true" />
      </FindBarButton>
      <CloseButton size="icon-dense" label="Close find" onClick={onClose} />
    </>
  )
}
