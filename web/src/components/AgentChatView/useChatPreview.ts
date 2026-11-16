/**
 * The chat's side of the Preview tab: a new page from the palette, a page
 * the agent opens (the ``preview`` tool card's Open button, by event, or the
 * tool itself on desktop), and design feedback moving between a Preview
 * tab's comments and the composer.
 */
import { useCallback, useEffect, type RefObject } from 'react'
import { lastPreviewUrl, previewsAvailable, type PreviewTarget } from '@/api/preview'
import type { DesignFeedback } from '@/lib/design-feedback'
import { useReturnedFeedbackStore } from '@/stores/useReturnedFeedbackStore'
import type { InputComposerHandle } from '../InputComposer'
import { previewTargetForFeedback } from '../Preview/preview-comments'
import { OPEN_PREVIEW_EVENT, isPreviewTarget } from '../Preview/preview-events'
import { usePreviewToolAutoOpen } from './usePreviewToolAutoOpen'

export function useChatPreview({ workspace, isMobile, inputRef, setWorkspacePanel, handleOpenPreview }: {
  workspace: string | null
  isMobile: boolean
  inputRef: RefObject<InputComposerHandle | null>
  setWorkspacePanel: (panel: null) => void
  handleOpenPreview: (target: PreviewTarget, options?: { focusOnly?: boolean }) => void
}) {
  const handleOpenNewPreview = useCallback(() => {
    if (!workspace) return
    handleOpenPreview({ kind: 'url', url: lastPreviewUrl(workspace) ?? 'http://localhost:5173' })
  }, [handleOpenPreview, workspace])

  const handleSendPreviewComments = useCallback((feedback: DesignFeedback) => {
    inputRef.current?.addDesignFeedback(feedback)
    // A phone shows the Review panel over the chat: go back to the message
    // box, where the comments now are.
    if (isMobile) setWorkspacePanel(null)
    inputRef.current?.focus()
  }, [inputRef, isMobile, setWorkspacePanel])

  // A feedback chip's x sends its comments back to their Preview tab's list,
  // opening that tab on desktop (it picks them up whenever it next mounts).
  const handleDesignFeedbackRemoved = useCallback((feedback: DesignFeedback) => {
    if (!workspace) return
    useReturnedFeedbackStore.getState().give({ workspace, feedback })
    const target = previewTargetForFeedback(feedback)
    if (target && !isMobile && previewsAvailable()) handleOpenPreview(target, { focusOnly: true })
  }, [handleOpenPreview, isMobile, workspace])

  // The `preview` tool card's Open button, and the agent opening a page
  // (desktop only: phones keep the chat on screen).
  useEffect(() => {
    const onOpen = (event: Event) => {
      const target = (event as CustomEvent<unknown>).detail
      if (isPreviewTarget(target)) handleOpenPreview(target)
    }
    window.addEventListener(OPEN_PREVIEW_EVENT, onOpen)
    return () => window.removeEventListener(OPEN_PREVIEW_EVENT, onOpen)
  }, [handleOpenPreview])
  usePreviewToolAutoOpen({ enabled: !isMobile && Boolean(workspace) && previewsAvailable(), onOpen: handleOpenPreview, workspace })

  return { handleOpenNewPreview, handleSendPreviewComments, handleDesignFeedbackRemoved }
}
