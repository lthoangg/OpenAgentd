/**
 * ActionSheet — a phone's long-press (or ⋯) menu: a bottom sheet with an
 * optional title, 44px action rows, and a Cancel row in its own group, as
 * iOS's action sheet. Every phone menu uses it, so they share the row
 * height, the destructive tone, and the way out.
 *
 * A row closes the sheet before it runs, so a confirm it opens is not
 * stacked under the sheet. The haptic belongs to the gesture that opened
 * it (``LongPressButton`` and friends), not to the sheet.
 */
import { Fragment } from 'react'
import type { LucideIcon } from 'lucide-react'

import { BottomSheet } from '@/components/ui/bottom-sheet'
import { MENU_SEPARATOR_CLASS } from '@/components/ui/menu-styles'
import { DURATIONS_S } from '@/lib/motion'
import { cn } from '@/lib/utils'

export interface ActionSheetItem {
  id: string
  label: string
  icon?: LucideIcon
  /** Destructive: red, and kept last by the caller. */
  danger?: boolean
  separatorBefore?: boolean
  disabled?: boolean
  /**
   * Opens another sheet: run once this one has slid away, so the two never
   * cross on screen (one leaving while the next rises).
   */
  afterClose?: boolean
  run: () => void
}

/** One 44px row: icon, label; the menu item's fill on press, never on hover. */
export const ACTION_SHEET_ROW_CLASS =
  'oa-menu-item flex min-h-(--phone-control) w-full cursor-pointer items-center gap-3 rounded-sm px-3 text-left text-sm text-(--color-text) disabled:cursor-default disabled:opacity-50'

export interface ActionSheetProps {
  open: boolean
  onClose: () => void
  /** The sheet's name and title. */
  title: string
  description?: string
  items: ActionSheetItem[]
}

export function ActionSheet({ open, onClose, title, description, items }: ActionSheetProps) {
  return (
    <BottomSheet open={open} onClose={onClose} label={title}>
      <div data-action-sheet="" className="flex flex-col gap-2 px-2 pb-2">
        <div className="rounded-md bg-(--bg-card)">
          <div className="px-3 pt-1 pb-2">
            <p className="text-sm font-semibold text-(--color-text) [overflow-wrap:anywhere]">{title}</p>
            {description && <p className="mt-0.5 text-xs text-(--color-text-muted)">{description}</p>}
          </div>
          <div className="flex flex-col p-1 pt-0">
            {items.map(({ id, label, icon: Icon, danger, separatorBefore, disabled, afterClose, run }) => (
              <Fragment key={id}>
                {separatorBefore && <div className={MENU_SEPARATOR_CLASS} role="separator" />}
                <button
                  type="button"
                  disabled={disabled}
                  data-action-sheet-item={id}
                  className={cn(ACTION_SHEET_ROW_CLASS, danger && 'oa-menu-item-danger text-(--color-error)')}
                  onClick={() => {
                    onClose()
                    if (afterClose) window.setTimeout(run, DURATIONS_S.base * 1000)
                    else run()
                  }}
                >
                  {Icon && <Icon size={16} aria-hidden="true" className="shrink-0" />}
                  <span className="min-w-0 flex-1 truncate">{label}</span>
                </button>
              </Fragment>
            ))}
          </div>
        </div>
        <button
          type="button"
          data-action-sheet-cancel=""
          onClick={onClose}
          className="oa-menu-item flex min-h-(--phone-control) w-full items-center justify-center rounded-md bg-(--bg-card) text-sm font-semibold text-(--color-text)"
        >
          Cancel
        </button>
      </div>
    </BottomSheet>
  )
}
