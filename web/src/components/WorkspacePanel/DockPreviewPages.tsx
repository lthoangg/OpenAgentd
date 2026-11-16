/**
 * Preview tabs' pages. Each stays mounted while its tab is open, so the page
 * and its unsent comments survive tab switches and moves between panes: one
 * layer over the panes, each page placed over its pane's body, in a fixed
 * order (a moved iframe reloads). A preview listener can serve several tabs
 * (file previews of one workspace), so it closes with the last one.
 */
// Not compiled, as when this code was part of WorkspacePanel, which the React
// Compiler skipped; compiling it is a change of its own to verify.
'use no memo'
import { useCallback, useEffect, useRef } from 'react'
import { closePreview, type PreviewTarget } from '@/api/preview'
import type { DesignFeedback } from '@/lib/design-feedback'
import { lazySurface } from '@/lib/lazy-surface'
import { cn } from '@/lib/utils'
import { usePreviewKeepAliveStore } from '@/stores/usePreviewKeepAliveStore'
import type { PaneBox, PaneId } from './dock-panes'
import type { DockTab } from './dock-tabs'
import { paneStyle } from './usePaneLayout'

// Kept out of the startup bundle; prefetched while the app is idle.
const PreviewTabView = lazySurface(() => import('../Preview/PreviewTabView'), 'PreviewTabView')

/** The preview listener behind each preview tab, closed when its last tab closes. */
export function usePreviewListeners() {
  const previewIdsRef = useRef(new Map<string, string>())
  const handlePreviewId = useCallback((tabId: string, previewId: string) => {
    previewIdsRef.current.set(tabId, previewId)
  }, [])
  const handleTabClosed = useCallback((tab: DockTab) => {
    if (tab.type !== 'preview') return
    const ids = previewIdsRef.current
    const previewId = ids.get(tab.id)
    ids.delete(tab.id)
    if (previewId && ![...ids.values()].includes(previewId)) {
      // The listener is going away: no hidden copy may reopen it.
      usePreviewKeepAliveStore.getState().forgetPreviewId(previewId)
      void closePreview(previewId).catch(() => {})
    }
  }, [])
  return { handlePreviewId, handleTabClosed }
}

export function DockPreviewPages({
  workspace,
  open,
  mobile,
  paneIds,
  strips,
  boxes,
  activeTabs,
  focusPane,
  onPreviewId: handlePreviewId,
  onSendComments: onSendPreviewComments,
  onOpenTarget: openPreviewTarget,
  onRequestClose: closeTab,
}: {
  workspace: string
  open: boolean
  mobile: boolean
  /** Panes in the order they were made. */
  paneIds: PaneId[]
  strips: Record<PaneId, DockTab[]>
  /** Where each pane on screen sits. */
  boxes: Map<PaneId, PaneBox>
  activeTabs: Record<PaneId, DockTab | undefined>
  focusPane: (pane: PaneId) => void
  onPreviewId: (tabId: string, previewId: string) => void
  onSendComments?: (feedback: DesignFeedback) => void
  onOpenTarget: (target: PreviewTarget) => void
  onRequestClose: (tabId: string) => void
}) {
  const previewTabs = paneIds
    .flatMap((pane) => (strips[pane] ?? [])
      .filter((tab): tab is Extract<DockTab, { type: 'preview' }> => tab.type === 'preview')
      .map((tab) => ({ tab, pane })))
    .sort((a, b) => (a.tab.id < b.tab.id ? -1 : a.tab.id > b.tab.id ? 1 : 0))

  // A click in a page goes to its frame, so no pointer event reaches the
  // pane: the window's blur, with the frame focused, says where focus went.
  useEffect(() => {
    if (mobile) return
    let timer = 0
    const onBlur = () => {
      window.clearTimeout(timer)
      // After the blur: the frame is the active element by then everywhere.
      timer = window.setTimeout(() => {
        const frame = document.activeElement
        if (!(frame instanceof HTMLIFrameElement)) return
        const pane = frame.closest('[data-dock-preview-pane]')?.getAttribute('data-dock-preview-pane')
        if (pane) focusPane(pane)
      }, 0)
    }
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('blur', onBlur)
      window.clearTimeout(timer)
    }
  }, [mobile, focusPane])

  return (
    <>
      {previewTabs.map(({ tab, pane }) => {
        const box = boxes.get(pane)
        const showing = box !== undefined && activeTabs[pane]?.id === tab.id
        return (
          <div
            key={tab.id}
            data-dock-preview={tab.id}
            data-dock-preview-pane={pane}
            className={cn('absolute', !showing && 'hidden')}
            style={box ? paneStyle(box, 'var(--spacing-tab-bar)') : undefined}
            onFocusCapture={() => focusPane(pane)}
            onPointerDownCapture={() => focusPane(pane)}
          >
            <PreviewTabView
              workspace={workspace}
              tabId={tab.id}
              target={tab.target}
              navKey={tab.navKey}
              onPreviewId={handlePreviewId}
              onSendComments={onSendPreviewComments}
              onOpenTarget={openPreviewTarget}
              active={open && showing}
              onRequestClose={closeTab}
            />
          </div>
        )
      })}
    </>
  )
}
