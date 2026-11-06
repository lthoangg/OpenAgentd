/**
 * A phone: the phone layout's size test (`useIsMobile`: narrow, or a
 * landscape phone) on a touch-first device. The phone gets the navigation
 * stack (Sessions → chat → Review) and Apple's sizes; a narrow mouse window
 * keeps the drawer layout, and a tablet keeps its own. CSS reads the same
 * test as the `phone:` variant (index.css).
 */
import { useIsMobile } from '@/hooks/use-mobile'
import { useTouchFirst } from '@/hooks/use-touch-first'

export function useIsPhone(): boolean {
  const mobile = useIsMobile()
  const touch = useTouchFirst()
  return mobile && touch
}
