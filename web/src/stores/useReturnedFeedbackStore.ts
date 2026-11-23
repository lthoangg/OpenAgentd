/**
 * Design feedback taken back out of the composer (its chip's x), waiting for
 * the Browser tab it came from to put the comments back in its list.
 *
 * A store rather than a callback because that tab may not be open yet: it
 * picks up its feedback when it mounts. Lost on reload, like the comments.
 */
import { create } from 'zustand'
import type { DesignFeedback } from '@/lib/design-feedback'

export interface ReturnedFeedback {
  workspace: string
  feedback: DesignFeedback
}

interface ReturnedFeedbackState {
  items: ReturnedFeedback[]
  give: (item: ReturnedFeedback) => void
  /** Removes and returns the items ``match`` accepts. */
  take: (match: (item: ReturnedFeedback) => boolean) => ReturnedFeedback[]
}

export const useReturnedFeedbackStore = create<ReturnedFeedbackState>((set, get) => ({
  items: [],
  give: (item) => set((state) => ({ items: [...state.items, item] })),
  take: (match) => {
    const taken = get().items.filter(match)
    if (taken.length > 0) set((state) => ({ items: state.items.filter((item) => !taken.includes(item)) }))
    return taken
  },
}))
