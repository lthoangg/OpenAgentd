/**
 * QuestionCard — the interactive body of ``ask_user``.
 *
 * The lead is stopped until this form resolves, so the behaviours under test are
 * the ones that decide whether the user can answer at all: selection semantics
 * (single vs multiple), the free-text escape hatch, per-question stepping, and the exact ``answers`` shape the backend validates
 * against (index-matched to the questions, empty entry = skipped).
 */
import { describe, it, expect, afterEach, mock } from 'bun:test'
import '@testing-library/jest-dom'
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react'

mock.module('lucide-react', () => new Proxy({}, { get: () => () => null }))

import { QuestionCard } from '@/components/AskUser/QuestionCard'
import { clearQuestionDrafts } from '@/components/AskUser/draft-cache'
import { normalizeQuestions } from '@/stores/useAgentStore/sse-reducer'
import type { PendingQuestion } from '@/api/types'

afterEach(() => {
  cleanup()
  clearQuestionDrafts()
})

function question(overrides: Partial<PendingQuestion> = {}): PendingQuestion {
  return {
    id: 'q-1',
    sessionId: 's-1',
    toolCallId: 'call-1',
    questions: [
      {
        question: 'Which package manager?',
        header: 'Package manager',
        multiple: false,
        options: [
          { label: 'pnpm', description: 'Fast', recommended: true },
          { label: 'bun', description: 'Faster', recommended: false },
        ],
      },
    ],
    ...overrides,
  }
}

const TWO_QUESTIONS: PendingQuestion = question({
  questions: [
    {
      question: 'Which package manager?',
      header: 'Package manager',
      multiple: false,
      options: [
        { label: 'pnpm', description: null, recommended: true },
        { label: 'bun', description: null, recommended: false },
      ],
    },
    {
      question: 'Which checks should run?',
      header: 'Checks',
      multiple: true,
      options: [
        { label: 'lint', description: null, recommended: true },
        { label: 'test', description: null, recommended: true },
        { label: 'build', description: null, recommended: false },
      ],
    },
  ],
})

function renderCard(props: Partial<React.ComponentProps<typeof QuestionCard>> = {}) {
  const onSubmit = mock(() => {})
  const onDismiss = mock(() => {})
  const view = render(
    <QuestionCard
      question={question()}
      onSubmit={onSubmit}
      onDismiss={onDismiss}
      submitting={false}
      error={null}
      {...props}
    />,
  )
  return { onSubmit, onDismiss, ...view }
}

describe('QuestionCard', () => {
  it('renders the question text and its options', () => {
    renderCard()

    expect(screen.getByText('Which package manager?')).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: /pnpm/ })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: /bun/ })).toBeInTheDocument()
  })

  it('marks the agent’s preferred option in its accessible name', () => {
    renderCard()

    // In the name, not just a colour or a badge: the recommendation is the most
    // useful thing on the card for someone using a screen reader.
    expect(screen.getByRole('radio', { name: /pnpm.*recommended/is })).toBeInTheDocument()
    expect(screen.queryAllByRole('radio', { name: /recommended/i })).toHaveLength(1)
  })

  it('gives options and question steps a 44px touch target on coarse pointers', () => {
    renderCard({ question: TWO_QUESTIONS })

    expect(screen.getByRole('radio', { name: /pnpm/ }).closest('label')?.className).toContain('pointer-coarse:min-h-11')
    const steps = within(screen.getByRole('group', { name: 'Questions' })).getAllByRole('button')
    expect(steps).toHaveLength(2)
    for (const step of steps) expect(step.className).toContain('pointer-coarse:min-h-11')
  })

  it('replaces the selection for a single-answer question', () => {
    const { onSubmit } = renderCard()

    fireEvent.click(screen.getByRole('radio', { name: /pnpm/ }))
    fireEvent.click(screen.getByRole('radio', { name: /bun/ }))
    fireEvent.click(screen.getByRole('button', { name: /send answer|^skip$/i }))

    expect(onSubmit).toHaveBeenCalledWith([['bun']])
  })

  it('offers a single question straight to submit', () => {
    renderCard()

    expect(screen.getByRole('button', { name: /send answer|^skip$/i })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /next question/i })).toBeNull()
  })

  it('walks through the questions before offering to submit', () => {
    // With more to answer, submitting is the wrong default: it silently skips
    // the questions the user has not seen yet.
    const { onSubmit } = renderCard({ question: TWO_QUESTIONS })

    expect(screen.getByRole('button', { name: /next question/i })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /send answer|^skip$/i })).toBeNull()

    fireEvent.click(screen.getByRole('radio', { name: /pnpm/ }))
    fireEvent.click(screen.getByRole('button', { name: /next question/i }))

    expect(screen.getByText('Which checks should run?')).toBeInTheDocument()
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('submits from the last question', () => {
    const { onSubmit } = renderCard({ question: TWO_QUESTIONS })

    fireEvent.click(screen.getByRole('radio', { name: /pnpm/ }))
    fireEvent.click(screen.getByRole('button', { name: /next question/i }))
    fireEvent.click(screen.getByRole('checkbox', { name: /lint/ }))
    fireEvent.click(screen.getByRole('button', { name: /send answer|^skip$/i }))

    expect(onSubmit).toHaveBeenCalledWith([['pnpm'], ['lint']])
  })

  it('submits from the last question reached through the stepper', () => {
    // Jumping straight to the end is still a submit — the label tracks the
    // step the user is on, not how they got there.
    const { onSubmit } = renderCard({ question: TWO_QUESTIONS })

    fireEvent.click(screen.getByRole('button', { name: /Checks/ }))

    expect(screen.getByRole('button', { name: /send answer|^skip$/i })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /send answer|^skip$/i }))
    expect(onSubmit).toHaveBeenCalledWith([[], []])
  })

  it('accumulates selections for a multi-answer question', () => {
    const { onSubmit } = renderCard({ question: TWO_QUESTIONS })

    fireEvent.click(screen.getByRole('button', { name: /Checks/ }))
    fireEvent.click(screen.getByRole('checkbox', { name: /lint/ }))
    fireEvent.click(screen.getByRole('checkbox', { name: /build/ }))
    fireEvent.click(screen.getByRole('button', { name: /send answer|^skip$/i }))

    expect(onSubmit).toHaveBeenCalledWith([[], ['lint', 'build']])
  })

  it('deselects an already-checked option in a multi-answer question', () => {
    const { onSubmit } = renderCard({ question: TWO_QUESTIONS })

    fireEvent.click(screen.getByRole('button', { name: /Checks/ }))
    fireEvent.click(screen.getByRole('checkbox', { name: /lint/ }))
    fireEvent.click(screen.getByRole('checkbox', { name: /lint/ }))
    fireEvent.click(screen.getByRole('button', { name: /send answer|^skip$/i }))

    expect(onSubmit).toHaveBeenCalledWith([[], []])
  })

  it('sends free text when the user types their own answer', () => {
    const { onSubmit } = renderCard()

    fireEvent.click(screen.getByRole('radio', { name: /type your own answer/i }))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'yarn, actually' } })
    fireEvent.click(screen.getByRole('button', { name: /send answer|^skip$/i }))

    expect(onSubmit).toHaveBeenCalledWith([['yarn, actually']])
  })

  it('scrolls the free-text textarea into view when chosen', () => {
    const original = HTMLElement.prototype.scrollIntoView
    const scrollIntoViewMock = mock(() => {})
    HTMLElement.prototype.scrollIntoView = scrollIntoViewMock

    try {
      renderCard()
      fireEvent.click(screen.getByRole('radio', { name: /type your own answer/i }))

      expect(screen.getByRole('textbox')).toBeInTheDocument()
      expect(scrollIntoViewMock).toHaveBeenCalledWith({ block: 'nearest', behavior: 'smooth' })
    } finally {
      HTMLElement.prototype.scrollIntoView = original
    }
  })

  // Questions stored before free text was unconditional still say
  // ``custom: false``; the user can type an answer to those too.
  it('offers free text on every question, even one stored with custom false', () => {
    const questions = normalizeQuestions([
      { question: 'Which package manager?', header: 'Package manager', multiple: false, custom: false, options: [{ label: 'pnpm' }, { label: 'bun' }] },
      { question: 'Which checks?', header: 'Checks', multiple: true, custom: false, options: [{ label: 'lint' }, { label: 'test' }] },
    ])
    const { onSubmit } = renderCard({ question: question({ questions }) })

    fireEvent.click(screen.getByRole('radio', { name: /type your own answer/i }))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'yarn' } })
    fireEvent.click(screen.getByRole('button', { name: /next question/i }))
    fireEvent.click(screen.getByRole('checkbox', { name: /type your own answer/i }))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'typecheck' } })
    fireEvent.click(screen.getByRole('button', { name: /send answer|^skip$/i }))

    expect(onSubmit).toHaveBeenCalledWith([['yarn'], ['typecheck']])
  })

  it('skips a question whose custom answer was left blank', () => {
    const { onSubmit } = renderCard()

    fireEvent.click(screen.getByRole('radio', { name: /type your own answer/i }))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '   ' } })
    fireEvent.click(screen.getByRole('button', { name: /send answer|^skip$/i }))

    expect(onSubmit).toHaveBeenCalledWith([[]])
  })

  it('shows one step per question and no stepper for a single question', () => {
    const { unmount } = renderCard({ question: TWO_QUESTIONS })
    expect(screen.getByRole('button', { name: /Package manager/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Checks/ })).toBeInTheDocument()

    unmount()
    renderCard()
    expect(screen.queryByRole('button', { name: /Package manager/ })).toBeNull()
  })

  it('sends an empty group for every unanswered question', () => {
    // Walking to the end without choosing anything is a valid reply: the
    // backend index-matches answers to questions, so a skipped question has to
    // arrive as an empty group rather than be dropped.
    const { onSubmit } = renderCard({ question: TWO_QUESTIONS })

    fireEvent.click(screen.getByRole('button', { name: /next question/i }))
    fireEvent.click(screen.getByRole('button', { name: /send answer|^skip$/i }))

    expect(onSubmit).toHaveBeenCalledWith([[], []])
  })

  it('swaps Dismiss for Back once the user has stepped forward', () => {
    // The secondary action tracks what is actually behind the user: on step one
    // there is nothing to go back to, so "throw it away" is the only option;
    // afterwards, offering Dismiss next to Back invites losing answers already
    // given to a mis-click.
    renderCard({ question: TWO_QUESTIONS })

    expect(screen.getByRole('button', { name: /^dismiss$/i })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^back$/i })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: /next question/i }))

    expect(screen.getByRole('button', { name: /^back$/i })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^dismiss$/i })).toBeNull()
  })

  it('keeps earlier answers when stepping back', () => {
    const { onSubmit } = renderCard({ question: TWO_QUESTIONS })

    fireEvent.click(screen.getByRole('radio', { name: /pnpm/ }))
    fireEvent.click(screen.getByRole('button', { name: /next question/i }))
    fireEvent.click(screen.getByRole('checkbox', { name: /lint/ }))

    fireEvent.click(screen.getByRole('button', { name: /^back$/i }))
    expect(screen.getByText('Which package manager?')).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: /pnpm/ })).toBeChecked()

    fireEvent.click(screen.getByRole('button', { name: /next question/i }))
    fireEvent.click(screen.getByRole('button', { name: /send answer|^skip$/i }))

    expect(onSubmit).toHaveBeenCalledWith([['pnpm'], ['lint']])
  })

  it('dismisses without submitting an answer', () => {
    const { onSubmit, onDismiss } = renderCard()

    fireEvent.click(screen.getByRole('button', { name: /dismiss/i }))

    expect(onDismiss).toHaveBeenCalledTimes(1)
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('blocks a double submit while the answer is in flight', () => {
    renderCard({ submitting: true })

    expect(screen.getByRole('button', { name: /sending/i })).toBeDisabled()
  })

  it('surfaces a failed answer without discarding the selection', () => {
    renderCard({ error: 'Network unreachable' })

    expect(screen.getByRole('alert')).toHaveTextContent('Network unreachable')
  })

  it('restores the draft when the same question is rendered again', () => {
    const { unmount, onSubmit: firstSubmit } = renderCard()
    fireEvent.click(screen.getByRole('radio', { name: /bun/ }))
    expect(firstSubmit).not.toHaveBeenCalled()
    unmount()

    const { onSubmit } = renderCard()
    fireEvent.click(screen.getByRole('button', { name: /send answer|^skip$/i }))

    expect(onSubmit).toHaveBeenCalledWith([['bun']])
  })

  it('does not carry a draft across different questions', () => {
    const { unmount } = renderCard()
    fireEvent.click(screen.getByRole('radio', { name: /bun/ }))
    unmount()

    const { onSubmit } = renderCard({ question: question({ id: 'q-2' }) })
    fireEvent.click(screen.getByRole('button', { name: /send answer|^skip$/i }))

    expect(onSubmit).toHaveBeenCalledWith([[]])
  })

  it('renders a link in the question as text, never as an anchor', () => {
    const { container } = renderCard({
      question: question({
        questions: [
          {
            question: 'Sign in at [our portal](https://evil.example) first?',
            header: 'Sign in',
            multiple: false,
            options: [{ label: 'ok', description: null, recommended: false }],
          },
        ],
      }),
    })

    expect(container.querySelector('a')).toBeNull()
    expect(screen.getByText(/\[our portal\]\(https:\/\/evil\.example\)/)).toBeInTheDocument()
  })

  describe('on a touch screen', () => {
    const realMatchMedia = window.matchMedia
    afterEach(() => {
      window.matchMedia = realMatchMedia
    })
    function useTouch() {
      window.matchMedia = ((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      })) as unknown as typeof window.matchMedia
    }

    it('focuses the free-text box when the user picks it', () => {
      useTouch()
      renderCard()
      fireEvent.click(screen.getByRole('radio', { name: /Type your own answer/ }))
      expect(document.activeElement).toBe(screen.getByLabelText('Your answer'))
    })

    it('does not raise the keyboard by itself when a restored card remounts', () => {
      useTouch()
      const { unmount } = renderCard()
      fireEvent.click(screen.getByRole('radio', { name: /Type your own answer/ }))
      unmount()

      renderCard()
      expect(screen.getByLabelText('Your answer')).toBeInTheDocument()
      expect(document.activeElement).not.toBe(screen.getByLabelText('Your answer'))
    })
  })
})
