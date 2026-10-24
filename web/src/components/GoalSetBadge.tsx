/** The pill on a prompt that set a `/goal`: its text is the objective. */
import { Target } from 'lucide-react'

export function GoalSetBadge() {
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full bg-(--accent-blue-soft) px-2 py-0.5 text-[11px] font-medium text-(--accent-blue-text)"
      title="The agent keeps working until a check confirms this is done"
      data-goal-objective
    >
      <Target size={11} aria-hidden="true" />
      Goal set
    </span>
  )
}
