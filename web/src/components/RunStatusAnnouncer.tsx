/**
 * RunStatusAnnouncer — one visually hidden live region that tells screen
 * readers when the open session's agent starts or finishes a turn, and when
 * it stops to ask the user something. Switching sessions stays silent: only
 * changes within the same session are news.
 */
import { useEffect, useRef, useState } from 'react'
import { useAgentStore } from '@/stores/useAgentStore'

export function RunStatusAnnouncer() {
  const sessionId = useAgentStore((s) => s.sessionId)
  const working = useAgentStore((s) => s.isAgentWorking)
  const question = useAgentStore((s) => s.pendingQuestion)
  const [message, setMessage] = useState('')
  const last = useRef({ sessionId, working, questionId: question?.id ?? null })

  useEffect(() => {
    const prev = last.current
    const questionId = question?.id ?? null
    last.current = { sessionId, working, questionId }
    if (prev.sessionId !== sessionId) return
    if (questionId && questionId !== prev.questionId) {
      const text = question?.kind === 'plan_review'
        ? 'Plan ready for review'
        : question?.questions[0]?.question ?? 'A question'
      setMessage(`Needs you: ${text}`)
      return
    }
    if (working !== prev.working) setMessage(working ? 'Agent is working' : 'Turn finished')
  }, [sessionId, working, question])

  return (
    <div role="status" aria-live="polite" aria-atomic="true" className="sr-only">
      {message}
    </div>
  )
}
