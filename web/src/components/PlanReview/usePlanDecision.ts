/**
 * The decision on an open plan review: the Plan tab's Approve and Keep going.
 * Changes are not an answer here: the tab's Reply in chat moves the comments
 * to the chat composer, and the message the user sends closes the review.
 *
 * "Keep going until done" starts a goal that runs the plan turn after turn.
 * Whenever it is on, the approve label says so and how many turns
 * (``Approve and keep going (10 turns)``): a multi-turn run is never behind
 * a bare "Approve". The tick and the turns last for the review's lifetime
 * (the Plan tab may unmount and come back), starting from Settings → Sessions.
 */
import { create } from 'zustand'

import type { PendingQuestion } from '@/api/question-types'
import { useGoalSettingsQuery } from '@/queries/useGoalSettingsQuery'
import { useQuestionResolver } from '../AskUser/useQuestionResolver'

export const APPROVE = 'Approve'

/** Matches ``appv3_core::runtime_settings::MAX_GOAL_MAX_TURNS``. */
export const MAX_GOAL_TURNS = 1000
/** Until the goal settings load (``DEFAULT_GOAL_MAX_TURNS``). */
export const DEFAULT_GOAL_TURNS = 50

/** Why the turns typed for Keep going cannot be sent, if they cannot. */
export function turnsError(text: string): string | null {
  const n = Number(text)
  return Number.isInteger(n) && n >= 1 && n <= MAX_GOAL_TURNS ? null : `Turns: a whole number from 1 to ${MAX_GOAL_TURNS}`
}

/** The approve button's words, with the real turn count while Keep going is on. */
export function approveLabel(keepGoing: boolean, turnsText: string): string {
  if (!keepGoing) return APPROVE
  if (turnsError(turnsText)) return `${APPROVE} and keep going`
  const turns = Number(turnsText)
  return `${APPROVE} and keep going (${turns} ${turns === 1 ? 'turn' : 'turns'})`
}

interface Choice {
  reviewId: string | null
  keepGoing: boolean | null
  turns: string | null
}

const NO_CHOICE: Choice = { reviewId: null, keepGoing: null, turns: null }

/** What the reader changed for the open review; Settings decide the rest. */
const useChoice = create<Choice>(() => NO_CHOICE)

/** Test seam. */
export function resetPlanDecisionChoice(): void {
  useChoice.setState(NO_CHOICE)
}

export function usePlanDecision({
  review,
  doneWhen,
}: {
  review: PendingQuestion | null
  /** The plan's Done when; Keep going needs one to check against. */
  doneWhen: string | null | undefined
}) {
  const reviewId = review?.id ?? null
  const resolver = useQuestionResolver(review)
  const { data: goalSettings } = useGoalSettingsQuery()
  const stored = useChoice()
  const mine = stored.reviewId === reviewId ? stored : NO_CHOICE

  const defaultTurns = goalSettings?.max_turns ?? DEFAULT_GOAL_TURNS
  const canKeepGoing = Boolean(doneWhen?.trim())
  const keepGoing = canKeepGoing && (mine.keepGoing ?? goalSettings?.keep_going_default ?? false)
  const turnsText = mine.turns ?? String(defaultTurns)
  const turnsProblem = keepGoing ? turnsError(turnsText) : null

  const choose = (patch: Partial<Pick<Choice, 'keepGoing' | 'turns'>>) =>
    useChoice.setState((prev) => ({
      reviewId,
      keepGoing: prev.reviewId === reviewId ? prev.keepGoing : null,
      turns: prev.reviewId === reviewId ? prev.turns : null,
      ...patch,
    }))

  return {
    submitting: resolver.submitting,
    error: resolver.error,
    canKeepGoing,
    keepGoing,
    /** Turns a goal starts with when the reader changes nothing (Settings → Sessions). */
    defaultTurns,
    setKeepGoing: (next: boolean) => choose({ keepGoing: next }),
    turnsText,
    setTurnsText: (next: string) => choose({ turns: next }),
    turnsProblem,
    approveLabel: approveLabel(keepGoing, turnsText),
    approve: () => {
      if (!keepGoing) {
        resolver.answer([[APPROVE]])
        return
      }
      const maxTurns = Number(turnsText)
      resolver.answer([[APPROVE]], { keepGoing: maxTurns === defaultTurns ? {} : { maxTurns } })
    },
    keepGoingHint: canKeepGoing
      ? "The goal is the plan's Done when. A check confirms it before the goal ends."
      : 'Add a Done when to the plan to keep going',
  }
}

export type PlanDecision = ReturnType<typeof usePlanDecision>
