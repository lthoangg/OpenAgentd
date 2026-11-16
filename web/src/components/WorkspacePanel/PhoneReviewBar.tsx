/**
 * A phone's Review panel page bar: ‹ Chat, the title, and the "+" that opens
 * a view or tool in the focused pane, as the tab strip's "+" does on other
 * layouts, with the action sheet it opens.
 */
import { useState } from 'react'
import { Plus } from 'lucide-react'
import { PhoneNavBar } from '@/components/phone/PhoneNavBar'
import { Button } from '@/components/ui/button'
import type { DockOpenItem } from './DockLauncher'
import { DockOpenSheet } from './DockOpenMenu'

export function PhoneReviewBar({
  phone,
  items: phoneOpenItems,
  stripShown: phoneStripShown,
  onRequestClose,
}: {
  /** Off a phone only the (closed) sheet is mounted; the tab strip has the "+". */
  phone: boolean
  /** What the "+" opens, for the pane in focus. */
  items: DockOpenItem[]
  /** The focused pane draws a tab strip under the bar. */
  stripShown: boolean
  onRequestClose?: () => void
}) {
  // Where the phone bar's "+" menu is open, if it is.
  const [phoneOpenMenu, setPhoneOpenMenu] = useState(false)
  // A phone's navigation bar: ‹ Chat (the one way out: no × beside it), the
  // title, and the "+" that opens a view or tool, as the tab strip's does on
  // other layouts. The tab strip under it draws the hairline; an empty page
  // has none, so the bar does.
  return (
    <>
      {phone && (
        <PhoneNavBar
          className={phoneStripShown ? 'border-transparent!' : undefined}
          back={onRequestClose ? { label: 'Chat', onBack: onRequestClose } : undefined}
          title="Review panel"
          trailing={phoneOpenItems.length > 0 && (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Open in Review panel"
              aria-haspopup="dialog"
              aria-expanded={phoneOpenMenu}
              className="text-(--color-accent)!"
              onClick={() => setPhoneOpenMenu(true)}
            >
              <Plus size={20} aria-hidden="true" className="size-5" />
            </Button>
          )}
        />
      )}
      <DockOpenSheet open={phoneOpenMenu} items={phoneOpenItems} onClose={() => setPhoneOpenMenu(false)} />
    </>
  )
}
