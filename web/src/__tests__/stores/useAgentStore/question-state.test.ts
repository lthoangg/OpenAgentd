/**
 * The question card machine (``stores/useAgentStore/question-state.ts``):
 * its table, and the one resolve move every closing path shares.
 */
import { describe, it, expect } from "bun:test"
import type { PendingQuestion } from "@/api/question-types"
import {
  NO_QUESTION,
  applyQuestionResolution,
  openQuestion,
  questionCardOf,
  questionMachine,
  type QuestionCard,
} from "@/stores/useAgentStore/question-state"
import type { CacheInvalidation, ResolvedQuestion } from "@/stores/useAgentStore/types"

const q = (id: string, kind?: PendingQuestion["kind"]): PendingQuestion => ({
  id,
  sessionId: "s",
  toolCallId: `call-${id}`,
  questions: [{ question: "Which?", header: "Pick", multiple: false, options: [] }],
  ...(kind ? { kind } : {}),
})

function draftWith(card: QuestionCard) {
  return {
    questionCard: card,
    resolvedQuestions: {} as Record<string, ResolvedQuestion>,
    sessionId: "s",
    cacheInvalidations: [] as CacheInvalidation[],
  }
}

describe("question card machine", () => {
  it("lists exactly these moves", () => {
    expect(questionMachine.moves()).toEqual([
      ["none", "ask"],
      ["none", "resolve"],
      ["none", "restore"],
      ["none", "reset"],
      ["open", "ask"],
      ["open", "resolve"],
      ["open", "restore"],
      ["open", "reset"],
    ])
  })

  it("replaces an open question with a newer one instead of stacking cards", () => {
    const next = questionMachine.transition(questionCardOf(q("a")), { type: "ask", question: q("b") })
    expect(openQuestion({ questionCard: next })?.id).toBe("b")
  })

  it("ignores a resolve for a question the card no longer shows", () => {
    const card = questionCardOf(q("b"))
    expect(questionMachine.transition(card, { type: "resolve", id: "a" })).toBe(card)
  })

  it("restores whatever a history page holds, open or not", () => {
    expect(questionMachine.transition(questionCardOf(q("a")), { type: "restore", question: null })).toEqual(NO_QUESTION)
    expect(openQuestion({ questionCard: questionMachine.transition(NO_QUESTION, { type: "restore", question: q("c") }) })?.id).toBe("c")
  })
})

describe("applyQuestionResolution", () => {
  it("records the first resolution and lets the second of the reply/broadcast race change nothing", () => {
    const draft = draftWith(questionCardOf(q("a")))
    applyQuestionResolution(draft, "a", [["A"]], null)
    applyQuestionResolution(draft, "a", null, "dismissed")
    expect(draft.questionCard).toEqual(NO_QUESTION)
    expect(draft.resolvedQuestions["call-a"]).toMatchObject({ answers: [["A"]], reason: null })
  })

  it("closes whatever is open when no id is named (a new send supersedes it)", () => {
    const draft = draftWith(questionCardOf(q("a")))
    applyQuestionResolution(draft, null, null, "superseded")
    expect(draft.resolvedQuestions["call-a"]?.reason).toBe("superseded")
  })

  it("refreshes the plan when a plan review closes", () => {
    const draft = draftWith(questionCardOf(q("r", "plan_review")))
    applyQuestionResolution(draft, "r", [["Approve"]], null)
    expect(draft.cacheInvalidations).toEqual([{ kind: "plan", sessionId: "s" }])
  })
})
