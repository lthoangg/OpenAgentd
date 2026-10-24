/**
 * Achieved goals the user has moved on from. An achieved goal's chip stays
 * until the next message (or a Dismiss), then hides. Client-only and
 * persisted, so a reload does not bring the chip back.
 */
import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'

const MAX_DISMISSED = 200

interface GoalUiState {
  dismissed: string[]
  dismiss: (goalId: string) => void
  /** Show a dismissed goal's chip again (its status was asked for). */
  restore: (goalId: string) => void
}

export const useGoalUiStore = create<GoalUiState>()(
  persist(
    (set, get) => ({
      dismissed: [],
      dismiss: (goalId) => {
        if (get().dismissed.includes(goalId)) return
        set({ dismissed: [...get().dismissed, goalId].slice(-MAX_DISMISSED) })
      },
      restore: (goalId) => {
        if (!get().dismissed.includes(goalId)) return
        set({ dismissed: get().dismissed.filter((id) => id !== goalId) })
      },
    }),
    { name: 'oa.dismissed-goals.v1', storage: createJSONStorage(() => localStorage) },
  ),
)
