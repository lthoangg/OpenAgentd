/**
 * SidebarItem — sidebar nav row with icon, label, and optional keyboard hint.
 *
 * Pencil component `F3DZn` (SidebarItem) covers the nav rows in
 * `Urcca` (Sidebar/Expanded). 40h, padding [10,12], gap 10, radius-md.
 *
 * Two render modes:
 *   - expanded: [icon] [label .....] [kbd?]
 *   - collapsed: [icon] (centered, 40×40 square, no label, no kbd)
 *
 * Active / hover styling matches paper-token nav: hover bumps weight from
 * 500→600 via `interactive-weight`, active uses `--bg-key` fill.
 */
import { motion, AnimatePresence } from 'framer-motion'
import { cn } from '@/lib/utils'
import { getPlatform } from '@/hooks/use-platform'
import { formatShortcut } from '@/lib/keyboard-shortcut'
import { memo, type ComponentType, type MouseEventHandler, type ReactNode } from 'react'

/**
 * Convert the shorthand ``"^N"`` (caret = primary modifier) into the
 * platform-appropriate label — ``"⌘N"`` on macOS, ``"Ctrl+N"`` elsewhere.
 * Anything else is rendered as-is.
 */
function renderKbd(kbd: string): string {
  if (kbd.startsWith('^')) return formatShortcut(kbd.slice(1), getPlatform().os)
  return kbd
}

export interface SidebarItemProps {
  /** Lucide icon component (or any component accepting `size` prop). */
  Icon: ComponentType<{ size?: number; className?: string }>
  label: string
  /** Keyboard hint text shown on the right of the row when expanded. */
  kbd?: string
  active?: boolean
  collapsed?: boolean
  onClick?: MouseEventHandler<HTMLButtonElement>
  title?: string
  /** Optional override for the right-side slot when expanded. */
  rightSlot?: ReactNode
  className?: string
}

export const SidebarItem = memo(function SidebarItem({
  Icon,
  label,
  kbd,
  active = false,
  collapsed = false,
  onClick,
  title,
  rightSlot,
  className,
}: SidebarItemProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title ?? (kbd ? `${label} (${renderKbd(kbd)})` : label)}
      aria-current={active ? 'page' : undefined}
      className={cn(
        'interactive-weight flex w-full items-center gap-2.5 rounded-lg text-sm transition-colors',
        collapsed ? 'h-10 w-10 justify-center px-0 py-0' : 'px-3 py-2',
        active
          ? 'bg-(--bg-key) text-(--color-text) font-medium'
          : 'text-(--color-text-2) hover:bg-(--bg-key) hover:text-(--color-text)',
        className,
      )}
    >
      <Icon size={16} className="shrink-0" />
      <AnimatePresence initial={false}>
        {!collapsed && (
          <motion.span
            key="label"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.12 }}
            className="flex-1 truncate text-left whitespace-nowrap"
          >
            {label}
          </motion.span>
        )}
      </AnimatePresence>
      {!collapsed &&
        (rightSlot !== undefined ? (
          rightSlot
        ) : kbd ? (
          <kbd className="shrink-0 rounded border border-(--color-border) bg-(--bg-page) px-1 py-0.5 font-mono text-xs text-(--color-text-subtle)">
            {renderKbd(kbd)}
          </kbd>
        ) : null)}
    </button>
  )
})
