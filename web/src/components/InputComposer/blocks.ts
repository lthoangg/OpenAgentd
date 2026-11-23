/**
 * The blocks a message carries besides its typed text: design feedback from
 * a Browser tab and comments from the Plan tab. The composer holds them as
 * chips and writes them after the text on send; text set from outside
 * (restores, history, Edit and resend) has them turned back into chips.
 */
import { composeWithDesignFeedback, designFeedbackPlainText, splitDesignFeedback, type DesignFeedback } from '@/lib/design-feedback'
import { composeWithPlanComments, planCommentsPlainText, splitPlanComments, type PlanCommentsBlock } from '../PlanReview/plan-comments-block'

export interface SplitMessage {
  text: string
  designFeedback: DesignFeedback[]
  planComments: PlanCommentsBlock | null
}

export function splitMessageBlocks(raw: string): SplitMessage {
  const plan = splitPlanComments(raw)
  const design = splitDesignFeedback(plan.text)
  return { text: design.text, designFeedback: design.blocks, planComments: plan.block }
}

/** The typed text, then the design feedback, then the plan comments. */
export function composeMessageBlocks(text: string, designFeedback: readonly DesignFeedback[], planComments: PlanCommentsBlock | null): string {
  return composeWithPlanComments(composeWithDesignFeedback(text, designFeedback), planComments)
}

/** ``message`` for plain-text surfaces (the queue, the undo notice): each block becomes a one-line summary. */
export function messagePlainText(message: string): string {
  return designFeedbackPlainText(planCommentsPlainText(message))
}
