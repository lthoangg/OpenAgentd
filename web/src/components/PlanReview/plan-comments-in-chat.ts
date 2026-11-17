/**
 * Plan comments waiting in the chat composer, for the Plan tab: while some
 * wait there, Approve asks for them to be sent or removed first, as it does
 * for comments still in the tab. The composer reports its chip here.
 */
import { create } from 'zustand'
import type { PlanCommentsBlock } from './plan-comments-block'

interface PlanCommentsInChat {
  block: PlanCommentsBlock | null
}

export const usePlanCommentsInChat = create<PlanCommentsInChat>(() => ({ block: null }))

export function setPlanCommentsInChat(block: PlanCommentsBlock | null): void {
  if (usePlanCommentsInChat.getState().block !== block) usePlanCommentsInChat.setState({ block })
}
