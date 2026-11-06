/**
 * DockTabCloseButton — the × inside a dock tab (file, diff, terminal…).
 *
 * The app's one ``CloseButton`` at its row size (24px, 36px on touch), named
 * "Close <tab>". Its tooltip names the key only on the open tab, the one ⌘W
 * closes: "Close tab (⌘W)"; on the others it says "Close tab".
 */
import type { MouseEventHandler } from 'react'
import { CloseButton } from '@/components/ui/close-button'
import type { OS } from '@/hooks/use-platform'
import { APP_SHORTCUTS, shortcutLabel } from '@/lib/app-shortcuts'
import { DOCK_TAB_CLOSE_CLASS } from './dock-tab-styles'

export function DockTabCloseButton({ title, active, os, onClick }: {
  /** The tab's name, for the accessible name "Close <title>". */
  title: string
  /** The open tab of its pane: the one ⌘W closes. */
  active: boolean
  os: OS
  onClick: MouseEventHandler<HTMLButtonElement>
}) {
  return (
    <CloseButton
      size="icon-xs"
      label={`Close ${title}`}
      tooltip={active ? `Close tab (${shortcutLabel(APP_SHORTCUTS.closeTab, os)})` : 'Close tab'}
      data-dock-tab-close=""
      className={DOCK_TAB_CLOSE_CLASS}
      onClick={onClick}
    />
  )
}
