/**
 * How the Review dock sits over the chat on desktop: beside it while the
 * center region fits both, over the transcript (the composer stays usable)
 * when it is too narrow, over the whole chat when maximized. Also whether
 * the dock stays mounted after a close and whether its first mount slides
 * in, and focus handed back when it stops covering the chat.
 */
import { useRef, useState } from 'react'
import { onPanelSlideBeside, settledWidthBesidePanels } from '@/components/ResizableAside'
import { useElementWidthSelect } from '@/hooks/use-element-width'
import { useReturnFocusFromDock } from '@/hooks/use-dock-focus'
import { useTouchFirst } from '@/hooks/use-touch-first'
import { dockOverlaysChat } from '@/lib/workbench-layout'
import { useLayoutStore } from '@/stores/useLayoutStore'

const isInReviewDock = (element: Element) => element.closest('[data-review-dock]') !== null
/** Stable selector: the shell only needs to know when the split stops fitting. */
const isCenterTooNarrow = (width: number) => dockOverlaysChat(width, false)
const isCenterTooNarrowForTouch = (width: number) => dockOverlaysChat(width, false, { touch: true })

export function useDockCover({ workspace, workspacePanel, isMobile, returnFocusToComposer }: {
  workspace: string | null
  /** The dock's open view; ``null`` while it is closed. */
  workspacePanel: string | null
  isMobile: boolean
  returnFocusToComposer: () => void
}) {
  // Review dock geometry: a ratio of the center region (chat + dock), with a
  // maximized / narrow-window overlay that covers the chat instead of
  // squeezing it. The chat stays mounted underneath so its scroll position
  // and live stream survive a maximize round-trip. The dock measures the
  // center itself; the shell subscribes to one bit so a sidebar tween or a
  // window drag does not re-render this whole tree every frame.
  const centerRef = useRef<HTMLDivElement>(null)
  const touchFirst = useTouchFirst()
  const centerTooNarrow = useElementWidthSelect(
    centerRef,
    touchFirst ? isCenterTooNarrowForTouch : isCenterTooNarrow,
    settledWidthBesidePanels,
    // Decided in the commit a sidebar slide starts, as the dock's mode is.
    onPanelSlideBeside,
  )
  const dockMaximized = useLayoutStore((s) => s.dockMaximized)
  // After its first open the dock stays mounted, closed or not, so its tabs
  // and their live content (preview pages, unsent comments) survive a close.
  const dockOpen = workspacePanel !== null
  const [dockKept, setDockKept] = useState(dockOpen)
  if (dockOpen && !dockKept) setDockKept(true)
  // Closed when this view mounted: the dock's first mount is the show
  // toggle (or the agent opening a view), so it slides in like a later open.
  const [dockSlidesIn] = useState(!dockOpen)
  // Over a narrow chat the dock covers the transcript but stops above the
  // composer, so a message can be written beside the diff; maximized, it
  // covers both. Whatever it covers stays mounted, inert.
  const dockOverChat = !isMobile && Boolean(workspace) && workspacePanel !== null && (dockMaximized || centerTooNarrow)
  const chatCoveredByDock = dockOverChat && dockMaximized
  const transcriptCoveredByDock = dockOverChat && !dockMaximized
  // The dock claims focus while it covers the chat; give it back when it
  // closes or uncovers the chat so it is never left on <body>.
  useReturnFocusFromDock({
    open: workspacePanel !== null,
    covered: chatCoveredByDock,
    enabled: !isMobile,
    isInDock: isInReviewDock,
    onReturn: returnFocusToComposer,
  })

  return { centerRef, dockOpen, dockKept, dockSlidesIn, chatCoveredByDock, transcriptCoveredByDock }
}
