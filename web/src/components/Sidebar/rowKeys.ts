/**
 * The sidebar's arrow keys, as a native source list has them: Up/Down/Home/
 * End walk the visible rows (sessions and workspace headers) and Left on a
 * session climbs to its workspace. Tab still stops on every row and action.
 */
import type { KeyboardEvent } from 'react'

/** Rows that Up/Down/Home/End move between: sessions and workspace headers. */
const SIDEBAR_ROW = '[data-sidebar-session], [data-sidebar-workspace]'

/** The sidebar column's ``onKeyDown``. */
export function walkSidebarRows(event: KeyboardEvent<HTMLElement>) {
  if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
  const target = event.target as HTMLElement
  // Up/Down/Home/End walk the visible rows like a native source list;
  // Tab still stops on every row and action (DESIGN.md → Keyboard
  // focus model). Only from a row, so fields and menus keep their keys.
  if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key) && target.matches(SIDEBAR_ROW)) {
    const rows = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(SIDEBAR_ROW))
      .filter((el) => !el.closest('[inert], [hidden]'))
    const index = rows.indexOf(target)
    const next = event.key === 'Home' ? rows[0]
      : event.key === 'End' ? rows[rows.length - 1]
      : rows[index + (event.key === 'ArrowDown' ? 1 : -1)]
    event.preventDefault()
    next?.focus()
    return
  }
  // Left on a session row climbs to its workspace, like a tree.
  if (event.key !== 'ArrowLeft') return
  if (!target.closest('[data-sidebar-session]')) return
  const header = target.closest('[data-sidebar-workspace-group]')?.querySelector<HTMLElement>('[data-sidebar-workspace]')
  if (!header) return
  event.preventDefault()
  header.focus()
}
