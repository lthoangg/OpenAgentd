/**
 * QuestionDock — where ``ask_user_question`` reaches the user.
 *
 * The lead is suspended until this resolves, so the dock takes over the spot the
 * composer normally occupies rather than floating over the transcript: the one
 * thing the user can usefully do is answer or dismiss.
 *
 * Desktop gets an anchored panel; mobile gets a bottom sheet, which is the only
 * treatment that survives the soft keyboard opening under a free-text answer.
 * Neither can be closed by a gesture — a stray backdrop tap must not silently
 * strand a stopped agent, so ``Dismiss`` is the explicit exit.
 */
import { useState } from 'react'
import { MessageCircleQuestion } from 'lucide-react'

import { answerQuestion, dismissQuestion } from '@/api/client'
import { Sheet, SheetContent } from '@/components/ui/sheet'
import { useIsMobile } from '@/hooks/use-mobile'
import { useTeamStore } from '@/stores/useTeamStore'
import { useToastStore } from '@/stores/useToastStore'
import { QuestionCard } from './QuestionCard'
import { forgetQuestionDraft } from './draft-cache'

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message ? cause.message : fallback
}

export function QuestionDock() {
  const pendingQuestion = useTeamStore((state) => state.pendingQuestion)
  const sessionId = useTeamStore((state) => state.sessionId)
  const clearPendingQuestion = useTeamStore((state) => state.clearPendingQuestion)
  const isMobile = useIsMobile()
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // A question belongs to one session. The store only ever holds one, but the
  // guard keeps a question from a session the user has navigated away from off
  // the screen it does not belong to.
  if (!pendingQuestion || !sessionId || pendingQuestion.sessionId !== sessionId) return null

  const questionId = pendingQuestion.id

  const resolve = async (
    action: () => Promise<{ resumed: boolean }>,
    failure: string,
    // Only an answer is supposed to restart the turn; a dismissal reports
    // ``resumed: false`` by design, and warning about that would turn the
    // ordinary "not now" into an error.
    expectResume: boolean,
  ) => {
    if (submitting) return
    setSubmitting(true)
    setError(null)
    try {
      const result = await action()
      forgetQuestionDraft(questionId)
      // The resolution also arrives over SSE, but closing here too means the
      // card still goes away when this client's stream is mid-reconnect.
      clearPendingQuestion(questionId)
      if (expectResume && !result.resumed) {
        useToastStore.getState().push({
          tone: 'error',
          title: 'Answer saved, but the agent did not restart',
          description: 'Send a message to continue the turn.',
        })
      }
    } catch (cause) {
      // Keep the card and the draft: the selection is still valid and the user
      // should be able to retry without re-picking anything.
      setError(errorMessage(cause, failure))
    } finally {
      setSubmitting(false)
    }
  }

  const card = (
    <QuestionCard
      key={questionId}
      question={pendingQuestion}
      submitting={submitting}
      error={error}
      onSubmit={(answers) =>
        void resolve(
          () => answerQuestion(sessionId, questionId, answers),
          'Could not send the answer.',
          true,
        )
      }
      onDismiss={() =>
        void resolve(
          () => dismissQuestion(sessionId, questionId),
          'Could not dismiss the question.',
          false,
        )
      }
    />
  )

  if (isMobile) {
    return (
      <Sheet open>
        <SheetContent
          side="bottom"
          showCloseButton={false}
          aria-label="The agent needs your input"
          className="max-h-[85vh] pb-safe"
        >
          <DockHeading />
          {card}
        </SheetContent>
      </Sheet>
    )
  }

  return (
    // Same anchor as the docked composer it stands in for (see
    // ``FloatingInputBar``), one layer above so a composer left mid-drag cannot
    // cover it. ``pointer-events-none`` on the wrapper, events on the panel —
    // the wrapper is a full-width box over the transcript and would otherwise
    // swallow clicks either side of the panel.
    <div className="pointer-events-none absolute inset-x-0 bottom-4 z-30 mx-auto w-full max-w-xl px-4">
      <section
        aria-label="The agent needs your input"
        className="pointer-events-auto flex max-h-[60vh] min-h-0 flex-col overflow-hidden rounded-xl border border-(--color-border-strong) bg-(--bg-card) shadow-xl"
      >
        <DockHeading />
        {card}
      </section>
    </div>
  )
}

function DockHeading() {
  return (
    <div className="flex shrink-0 items-center gap-1.5 px-3 pt-3 text-[11px] font-medium tracking-wide text-(--color-text-muted) uppercase">
      <MessageCircleQuestion size={12} />
      Needs your input
    </div>
  )
}
