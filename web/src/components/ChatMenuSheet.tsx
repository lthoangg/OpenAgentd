/**
 * The touch form of a transcript surface's menu: the same items as a phone
 * action sheet. Its own module, loaded when the first long press asks for it
 * (``ChatContextMenu``), so every code block and message in the transcript
 * does not carry the sheet and its motion code with it.
 */
import type { LucideIcon } from 'lucide-react'

import { ActionSheet } from '@/components/ui/action-sheet'

export interface ChatMenuSheetItem {
  label: string
  icon?: LucideIcon
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
    <ActionSheet
      open={open}
      onClose={onClose}
      title={label}
      items={items.map((item) => ({ id: item.label, label: item.label, icon: item.icon, run: item.run }))}
    />
  )
}
