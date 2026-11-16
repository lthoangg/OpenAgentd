/**
 * The count on the jump-to-latest chip: the blocks that arrived since the
 * reader scrolled away from the live end.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ContentBlock } from '@/api/types'
import { useTranscriptFollowStore } from '@/stores/useTranscriptFollowStore'
import { countBlocksAfter } from '@/utils/blocks'

/**
 * One chip, with the count: on the composer when it is up (the store carries
 * the state to it), else in the transcript's own corner, which reads the
 * returned count. Counted from the newest block when the reader scrolled
 * away, so earlier messages loading in above never read as new.
 */
export function useUnseenCount({ blocks, liveTail, showScrollBtn, readerTranscript, inComposer }: {
  blocks: ContentBlock[]
  liveTail: ContentBlock[]
  /** The reader has scrolled away from the live end. */
  showScrollBtn: boolean
  readerTranscript: boolean
  /** The composer carries the chip: publish the count to the store instead. */
  inComposer: boolean
}): number | null {
  const followAnchorRef = useRef<string | null>(null)
  const unseenRef = useRef<number | null>(null)
  const [inlineUnseen, setInlineUnseen] = useState<number | null>(null)
  const publishUnseen = useCallback((unseen: number | null) => {
    unseenRef.current = unseen
    if (!inComposer) {
      setInlineUnseen(unseen)
      return
    }
    if (useTranscriptFollowStore.getState().unseen !== unseen) useTranscriptFollowStore.setState({ unseen })
  }, [inComposer])
  useEffect(() => {
    if (!showScrollBtn) {
      followAnchorRef.current = null
      publishUnseen(null)
      return
    }
    // Reader mode folds everything, so a count of blocks says nothing: show the
    // bare chip. Dropping the anchor makes a switch back to detailed count
    // afresh from that moment.
    if (readerTranscript) {
      followAnchorRef.current = null
      publishUnseen(0)
      return
    }
    followAnchorRef.current ??= (liveTail[liveTail.length - 1] ?? blocks[blocks.length - 1])?.id ?? ''
    const counted = countBlocksAfter(blocks, followAnchorRef.current, liveTail)
    // A reconcile can swap the anchor's id; keep the last count then.
    publishUnseen(counted ?? unseenRef.current ?? 0)
  }, [blocks, liveTail, publishUnseen, readerTranscript, showScrollBtn])

  return inlineUnseen
}
