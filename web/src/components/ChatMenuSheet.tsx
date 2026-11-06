/**
 * The touch form of a transcript surface's menu: the same items as a bottom
 * sheet. Its own module, loaded when the first long press asks for it
 * (``ChatContextMenu``), so every code block and message in the transcript
 * does not carry the sheet and its motion code with it.
 */
import { BottomSheet } from '@/components/ui/bottom-sheet'
import { MENU_ITEM_CLASS } from '@/components/ui/menu-styles'
import { cn } from '@/lib/utils'

export interface ChatMenuSheetItem {
  label: string
  run: () => void
}

interface ChatMenuSheetProps {
  open: boolean
  label: string
  items: ChatMenuSheetItem[]
  onClose: () => void
}

export default function ChatMenuSheet({ open, label, items, onClose }: ChatMenuSheetProps) {
  return (
    <BottomSheet open={open} onClose={onClose} label={label}>
      <div className="flex flex-col px-2 pb-3">
        {items.map((item) => (
          <button
            key={item.label}
            type="button"
            className={cn(MENU_ITEM_CLASS, 'min-h-(--phone-control) text-sm')}
            onClick={() => {
              onClose()
              item.run()
            }}
          >
            {item.label}
          </button>
        ))}
      </div>
    </BottomSheet>
  )
}
