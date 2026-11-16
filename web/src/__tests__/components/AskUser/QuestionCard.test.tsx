/**
 * QuestionCard — the interactive body of ``ask_user``.
 *
 * The lead is stopped until this form resolves, so the behaviours under test are
 * the ones that decide whether the user can answer at all: selection semantics
 * (single vs multiple), the free-text escape hatch, per-question stepping, and the exact ``answers`` shape the backend validates
 * against (index-matched to the questions, empty entry = skipped).
 *
 * The footer has only Back and one primary button: Next on every question but
 * the last, Send on the last. There is no Dismiss and no Skip button; a
 * question left unanswered goes out skipped (an empty group). 1–9 pick an
 * option, and Enter takes the primary action once the current question has an
 * answer while focus is in the card and not in a text field. Options are
 * Bark-filled when chosen, keycap-filled otherwise, and nothing inside the card
 * has a border.
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

const THREE_QUESTIONS: PendingQuestion = question({
  questions: [
    ...TWO_QUESTIONS.questions,
    {
      question: 'Which registry?',
      header: 'Registry',
      multiple: false,
      options: [
        { label: 'npm', description: null, recommended: true },
        { label: 'github', description: null, recommended: false },
      ],
    },
  ],
})

function renderCard(props: Partial<React.ComponentProps<typeof QuestionCard>> = {}) {
  const onSubmit = mock(() => {})
  const view = render(
    <QuestionCard
      question={question()}
      onSubmit={onSubmit}
      submitting={false}
      error={null}
      {...props}
    />,
  )
  return { onSubmit, ...view }
}

const sendButton = () => screen.getByRole('button', { name: 'Send' })
const nextButton = () => screen.getByRole('button', { name: 'Next' })

describe('QuestionCard', () => {
  it('renders the question text and its options', () => {
    renderCard()

    expect(screen.getByText('Which package manager?')).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: /pnpm/ })).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: /bun/ })).toBeInTheDocument()
  })

  it('renders the question as full markdown, tables included', () => {
    renderCard({
      question: question({
        questions: [
          {
            question: 'Pick one:\n\n| Option | Cost |\n| --- | --- |\n| pnpm | low |\n| bun | lower |',
            header: 'Table',
            multiple: false,
            options: [{ label: 'pnpm', description: null, recommended: false }],
          },
        ],
      }),
    })

    const table = screen.getByRole('table')
    expect(within(table).getByRole('columnheader', { name: 'Cost' })).toBeInTheDocument()
    expect(within(table).getByRole('cell', { name: 'lower' })).toBeInTheDocument()
    expect(screen.getByRole('group', { name: /Pick one/ })).toBeInTheDocument()
  })

  it('wraps long unbroken text (URLs, paths) inside the card instead of clipping it', () => {
    // happy-dom has no layout, so this guards the class that lets a long URL
    // break mid-string; the card frame is overflow-hidden and would clip it.
    const url = `https://example.com/${'a'.repeat(200)}`
    const path = `/very/long/${'b'.repeat(200)}.ts`
    renderCard({
      question: question({
        questions: [
          {
            question: `Open ${url}?`,
            header: 'Link',
            multiple: false,
            options: [
              { label: `Edit \`${path}\``, description: `See ${url}#desc`, recommended: false },
            ],
          },
        ],
      }),
    })

    const wraps = (text: string | RegExp) =>
      screen.getByText(text).closest('[class*="[overflow-wrap:anywhere]"]')
    expect(wraps(/^Open/)?.id).toBe('q-1-q0')
    expect(wraps(path)).not.toBeNull()
    expect(wraps(`See ${url}#desc`)).not.toBeNull()
  })

  it('marks the agent’s preferred option in its accessible name', () => {
    renderCard()

    // In the name, not just a colour or a badge: the recommendation is the most
    // useful thing on the card for someone using a screen reader.
    expect(screen.getByRole('radio', { name: /pnpm.*recommended/is })).toBeInTheDocument()
    expect(screen.queryAllByRole('radio', { name: /recommended/i })).toHaveLength(1)
  })

  it('gives options and question steps a 36px touch target on coarse pointers', () => {
    renderCard({ question: TWO_QUESTIONS })

    expect(screen.getByRole('radio', { name: /pnpm/ }).closest('label')?.className).toContain('pointer-coarse:min-h-9')
    const steps = within(screen.getByRole('group', { name: 'Questions' })).getAllByRole('button')
    expect(steps).toHaveLength(2)
    for (const step of steps) expect(step.className).toContain('pointer-coarse:min-h-9')
  })

  it('replaces the selection for a single-answer question', () => {
    const { onSubmit } = renderCard()

    fireEvent.click(screen.getByRole('radio', { name: /pnpm/ }))
    fireEvent.click(screen.getByRole('radio', { name: /bun/ }))
    fireEvent.click(sendButton())

    expect(onSubmit).toHaveBeenCalledWith([['bun']])
  })

  it('offers a single question straight to Send, with no paging', () => {
    renderCard()

    expect(sendButton()).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^next$/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /^back$/i })).toBeNull()
  })

  it('picks and sends in one double-click, as a list dialog takes its default button', () => {
    const { onSubmit } = renderCard()

    const bun = screen.getByRole('radio', { name: /bun/ }).closest('label')!
    fireEvent.click(bun)
    fireEvent.click(bun)
    fireEvent.doubleClick(bun)

    expect(onSubmit.mock.calls).toEqual([[[['bun']]]])
  })

  it('moves to the next question on a double-click before the last one, and sends from the last', () => {
    const { onSubmit } = renderCard({ question: THREE_QUESTIONS })

    fireEvent.doubleClick(screen.getByRole('radio', { name: /bun/ }).closest('label')!)
    expect(onSubmit).not.toHaveBeenCalled()
    expect(screen.getByText('Which checks should run?')).toBeInTheDocument()

    // Several answers are allowed here: a double-click does not choose and go on.
    fireEvent.click(screen.getByRole('checkbox', { name: /lint/ }))
    fireEvent.doubleClick(screen.getByRole('checkbox', { name: /lint/ }).closest('label')!)
    expect(onSubmit).not.toHaveBeenCalled()
    expect(screen.getByText('Which checks should run?')).toBeInTheDocument()

    fireEvent.click(nextButton())
    expect(screen.getByText('Which registry?')).toBeInTheDocument()
    fireEvent.doubleClick(screen.getByRole('radio', { name: /github/ }).closest('label')!)
    expect(onSubmit).toHaveBeenCalledWith([['bun'], ['lint'], ['github']])
  })

  it('does not send twice from a double-click while the answer is in flight', () => {
    const { onSubmit } = renderCard({ submitting: true })
    fireEvent.doubleClick(screen.getByRole('radio', { name: /bun/ }).closest('label')!)
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('reads "Next" on every question but the last, and "Send" on the last', () => {
    const { onSubmit } = renderCard({ question: TWO_QUESTIONS })

    expect(nextButton()).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull()

    fireEvent.click(screen.getByRole('radio', { name: /pnpm/ }))
    fireEvent.click(screen.getByRole('button', { name: /^next$/i }))

    expect(screen.getByText('Which checks should run?')).toBeInTheDocument()
    expect(sendButton()).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^next$/i })).toBeNull()
    expect(onSubmit).not.toHaveBeenCalled()
  })

  it('sends what the other questions got from the last question', () => {
    const { onSubmit } = renderCard({ question: TWO_QUESTIONS })

    fireEvent.click(screen.getByRole('radio', { name: /pnpm/ }))
    fireEvent.click(screen.getByRole('button', { name: /^next$/i }))
    fireEvent.click(screen.getByRole('checkbox', { name: /lint/ }))
    fireEvent.click(sendButton())

    expect(onSubmit).toHaveBeenCalledWith([['pnpm'], ['lint']])
  })

  it('sends the answers given with the unanswered ones skipped, and the caption says how many', () => {
    const { onSubmit } = renderCard({ question: TWO_QUESTIONS })

    fireEvent.click(screen.getByRole('radio', { name: /pnpm/ }))
    expect(screen.getByText('1 of 2 answered · 1 will be skipped')).toBeInTheDocument()
    fireEvent.click(nextButton())
    fireEvent.click(sendButton())

    expect(onSubmit).toHaveBeenCalledWith([['pnpm'], []])
  })

  it('keeps Send enabled with nothing answered, and says on screen that it skips', () => {
    const { onSubmit, unmount } = renderCard()

    expect(sendButton()).not.toBeDisabled()
    const caption = screen.getByText('Nothing picked: Send skips this question.')
    // The caption is the button's description, not a tooltip alone.
    expect(sendButton().getAttribute('aria-describedby')).toBe(caption.id)
    fireEvent.click(sendButton())
    expect(onSubmit).toHaveBeenCalledWith([[]])

    fireEvent.click(screen.getByRole('radio', { name: /bun/ }))
    expect(sendButton()).not.toBeDisabled()
    expect(screen.queryByText('Nothing picked: Send skips this question.')).toBeNull()
    expect(sendButton().getAttribute('aria-describedby')).toBeNull()

    unmount()
    clearQuestionDrafts()
    renderCard({ question: TWO_QUESTIONS })
    expect(nextButton()).not.toBeDisabled()
    const multi = screen.getByText('0 of 2 answered · 2 will be skipped')
    expect(nextButton().getAttribute('aria-describedby')).toBe(multi.id)
  })

  it('counts answered and skipped questions in the caption of a multi-question card', () => {
    renderCard({ question: TWO_QUESTIONS })

    expect(screen.getByText('0 of 2 answered · 2 will be skipped')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('radio', { name: /pnpm/ }))
    expect(screen.getByText('1 of 2 answered · 1 will be skipped')).toBeInTheDocument()
    fireEvent.click(nextButton())
    fireEvent.click(screen.getByRole('checkbox', { name: /lint/ }))
    // Everything answered: the count stays, with nothing left to skip.
    expect(screen.getByText('2 of 2 answered')).toBeInTheDocument()
  })

  // On a phone the caption shrank to one word a line beside four buttons:
  // it keeps a readable width, so the buttons wrap under it instead.
  it('keeps the caption readable on a narrow card, and adds no empty line without one', () => {
    const { unmount } = renderCard({ question: TWO_QUESTIONS })
    const caption = screen.getByText('0 of 2 answered · 2 will be skipped')
    expect(caption.className.split(/\s+/)).toContain('basis-48')
    expect(caption.className.split(/\s+/)).not.toContain('min-w-0')
    unmount()
    clearQuestionDrafts()
    renderCard()
    fireEvent.click(screen.getByRole('radio', { name: /bun/ }))
    const actions = sendButton().parentElement!.parentElement!
    expect(actions.querySelector('span[id$="-caption"]')).toBeNull()
  })

  it('moves on with Next from an unanswered question, which then goes out skipped', () => {
    const { onSubmit } = renderCard({ question: TWO_QUESTIONS })

    fireEvent.click(nextButton())
    expect(screen.getByText('Which checks should run?')).toBeInTheDocument()
    expect(onSubmit).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('checkbox', { name: /build/ }))
    fireEvent.click(sendButton())
    expect(onSubmit).toHaveBeenCalledWith([[], ['build']])
  })

  it('sends the last question skipped when only an earlier one was answered', () => {
    const { onSubmit } = renderCard({ question: TWO_QUESTIONS })

    fireEvent.click(screen.getByRole('radio', { name: /bun/ }))
    fireEvent.click(screen.getByRole('button', { name: /Checks/ }))
    fireEvent.click(sendButton())

    expect(onSubmit).toHaveBeenCalledWith([['bun'], []])
  })

  it('sends a lone unanswered question as an empty answer', () => {
    const { onSubmit } = renderCard()

    fireEvent.click(sendButton())

    expect(onSubmit).toHaveBeenCalledWith([[]])
  })

  it('accumulates selections for a multi-answer question', () => {
    const { onSubmit } = renderCard({ question: TWO_QUESTIONS })

    fireEvent.click(screen.getByRole('button', { name: /Checks/ }))
    fireEvent.click(screen.getByRole('checkbox', { name: /lint/ }))
    fireEvent.click(screen.getByRole('checkbox', { name: /build/ }))
    fireEvent.click(sendButton())

    expect(onSubmit).toHaveBeenCalledWith([[], ['lint', 'build']])
  })

  it('deselects an already-checked option in a multi-answer question', () => {
    const { onSubmit } = renderCard({ question: TWO_QUESTIONS })

    fireEvent.click(screen.getByRole('button', { name: /Checks/ }))
    fireEvent.click(screen.getByRole('checkbox', { name: /lint/ }))
    fireEvent.click(screen.getByRole('checkbox', { name: /lint/ }))
    expect(sendButton()).not.toBeDisabled()
    expect(screen.getByText('0 of 2 answered · 2 will be skipped')).toBeInTheDocument()
    fireEvent.click(sendButton())

    expect(onSubmit).toHaveBeenCalledWith([[], []])
  })

  it('sends free text when the user types their own answer', () => {
    const { onSubmit } = renderCard()

    fireEvent.click(screen.getByRole('radio', { name: /type your own answer/i }))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'yarn, actually' } })
    fireEvent.click(sendButton())

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
    fireEvent.click(screen.getByRole('button', { name: /^next$/i }))
    fireEvent.click(screen.getByRole('checkbox', { name: /type your own answer/i }))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'typecheck' } })
    fireEvent.click(sendButton())

    expect(onSubmit).toHaveBeenCalledWith([['yarn'], ['typecheck']])
  })

  it('skips a question whose custom answer was left blank', () => {
    const { onSubmit } = renderCard()

    fireEvent.click(screen.getByRole('radio', { name: /type your own answer/i }))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '   ' } })
    // A blank box is no answer: it counts as unanswered, and Send skips it.
    expect(screen.getByText('Nothing picked: Send skips this question.')).toBeInTheDocument()
    fireEvent.click(sendButton())

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
    // The backend index-matches answers to questions, so a skipped question
    // has to arrive as an empty group rather than be dropped.
    const { onSubmit } = renderCard({ question: TWO_QUESTIONS })

    fireEvent.click(nextButton())
    fireEvent.click(sendButton())

    expect(onSubmit).toHaveBeenCalledWith([[], []])
  })

  it('has only Back and Next on a middle question, Back and Send on the last, and no Dismiss or Skip anywhere', () => {
    renderCard({ question: THREE_QUESTIONS })
    // The step buttons above the form are not the footer.
    const footer = () =>
      screen
        .getAllByRole('button')
        .filter((button) => !screen.getByRole('group', { name: 'Questions' }).contains(button))
        .map((button) => button.textContent)

    // First: Next alone.
    expect(footer()).toEqual(['Next'])
    expect(screen.queryByRole('button', { name: /dismiss|skip/i })).toBeNull()

    // Middle: Back and Next.
    fireEvent.click(nextButton())
    expect(footer()).toEqual(['Back', 'Next'])
    expect(screen.queryByRole('button', { name: /dismiss|skip/i })).toBeNull()

    // Last: Back and Send.
    fireEvent.click(nextButton())
    expect(footer()).toEqual(['Back', 'Send'])
    expect(screen.queryByRole('button', { name: /dismiss|skip/i })).toBeNull()
  })

  it('offers a single question only Send, with no Dismiss or Skip', () => {
    renderCard()

    expect(screen.getAllByRole('button').map((button) => button.textContent)).toEqual(['Send'])
    expect(screen.queryByRole('button', { name: /dismiss|skip/i })).toBeNull()
  })

  it('keeps earlier answers when stepping back', () => {
    const { onSubmit } = renderCard({ question: TWO_QUESTIONS })

    fireEvent.click(screen.getByRole('radio', { name: /pnpm/ }))
    fireEvent.click(screen.getByRole('button', { name: /^next$/i }))
    fireEvent.click(screen.getByRole('checkbox', { name: /lint/ }))

    fireEvent.click(screen.getByRole('button', { name: /^back$/i }))
    expect(screen.getByText('Which package manager?')).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: /pnpm/ })).toBeChecked()

    fireEvent.click(screen.getByRole('button', { name: /^next$/i }))
    fireEvent.click(sendButton())

    expect(onSubmit).toHaveBeenCalledWith([['pnpm'], ['lint']])
  })

  it('blocks a double submit while the answer is in flight', () => {
    const { onSubmit } = renderCard({ submitting: true })

    expect(screen.getByRole('button', { name: /sending/i })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: /sending/i }))
    expect(onSubmit).not.toHaveBeenCalled()
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
    fireEvent.click(sendButton())

    expect(onSubmit).toHaveBeenCalledWith([['bun']])
  })

  it('does not carry a draft across different questions', () => {
    const { unmount } = renderCard()
    fireEvent.click(screen.getByRole('radio', { name: /bun/ }))
    unmount()

    const { onSubmit } = renderCard({ question: question({ id: 'q-2' }) })
    // Nothing picked on this one: the earlier pick did not carry over, so it goes out skipped.
    expect(screen.getByText('Nothing picked: Send skips this question.')).toBeInTheDocument()
    fireEvent.click(sendButton())

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

  describe('keyboard', () => {
    it('picks the Nth option with a digit while focus is on an option', () => {
      const { onSubmit } = renderCard()
      const first = screen.getByRole('radio', { name: /pnpm/ })
      first.focus()

      fireEvent.keyDown(first, { key: '2' })

      expect(screen.getByRole('radio', { name: /bun/ })).toBeChecked()
      expect(screen.getByRole('radio', { name: /pnpm/ })).not.toBeChecked()
      expect(onSubmit).not.toHaveBeenCalled()
    })

    it('picks from anywhere inside the card, on a button too', () => {
      renderCard()

      fireEvent.keyDown(sendButton(), { key: '1' })

      expect(screen.getByRole('radio', { name: /pnpm/ })).toBeChecked()
    })

    it('toggles an option on a multi-answer question', () => {
      renderCard({ question: TWO_QUESTIONS })
      fireEvent.click(screen.getByRole('button', { name: /Checks/ }))
      const lint = screen.getByRole('checkbox', { name: /lint/ })

      fireEvent.keyDown(lint, { key: '1' })
      fireEvent.keyDown(lint, { key: '3' })
      expect(lint).toBeChecked()
      expect(screen.getByRole('checkbox', { name: /build/ })).toBeChecked()

      fireEvent.keyDown(lint, { key: '1' })
      expect(lint).not.toBeChecked()
    })

    it('numbers "Type your own answer" after the listed options', () => {
      renderCard()

      fireEvent.keyDown(screen.getByRole('radio', { name: /pnpm/ }), { key: '3' })

      expect(screen.getByRole('radio', { name: /type your own answer/i })).toBeChecked()
      expect(screen.getByLabelText('Your answer')).toBeInTheDocument()
    })

    it('ignores a digit with no such option', () => {
      renderCard()

      fireEvent.keyDown(screen.getByRole('radio', { name: /pnpm/ }), { key: '9' })

      expect(screen.queryAllByRole('radio', { checked: true })).toHaveLength(0)
    })

    it('leaves digits to a text field', () => {
      renderCard()
      fireEvent.click(screen.getByRole('radio', { name: /type your own answer/i }))
      const box = screen.getByLabelText('Your answer')

      fireEvent.keyDown(box, { key: '1' })

      expect(screen.getByRole('radio', { name: /pnpm/ })).not.toBeChecked()
      expect(screen.getByRole('radio', { name: /type your own answer/i })).toBeChecked()
    })

    it('leaves digits alone with a modifier held', () => {
      renderCard()

      fireEvent.keyDown(screen.getByRole('radio', { name: /pnpm/ }), { key: '1', metaKey: true })

      expect(screen.getByRole('radio', { name: /pnpm/ })).not.toBeChecked()
    })

    it('sends on Enter once there is an answer, and not before', () => {
      const { onSubmit } = renderCard()
      const first = screen.getByRole('radio', { name: /pnpm/ })

      fireEvent.keyDown(first, { key: 'Enter' })
      expect(onSubmit).not.toHaveBeenCalled()

      fireEvent.keyDown(first, { key: '2' })
      fireEvent.keyDown(first, { key: 'Enter' })
      expect(onSubmit).toHaveBeenCalledWith([['bun']])
    })

    it('leaves Enter on a button to that button', () => {
      const { onSubmit } = renderCard()
      fireEvent.click(screen.getByRole('radio', { name: /bun/ }))

      fireEvent.keyDown(sendButton(), { key: 'Enter' })

      expect(onSubmit).not.toHaveBeenCalled()
    })

    it('takes Next on Enter from a non-last question once it has an answer, and Send on the last', () => {
      const { onSubmit } = renderCard({ question: TWO_QUESTIONS })
      const first = screen.getByRole('radio', { name: /pnpm/ })

      fireEvent.keyDown(first, { key: 'Enter' })
      expect(screen.getByText('Which package manager?')).toBeInTheDocument()

      fireEvent.keyDown(first, { key: '1' })
      fireEvent.keyDown(first, { key: 'Enter' })
      expect(screen.getByText('Which checks should run?')).toBeInTheDocument()
      expect(onSubmit).not.toHaveBeenCalled()

      // The new question has no answer yet: Enter leaves it alone.
      const lint = screen.getByRole('checkbox', { name: /lint/ })
      fireEvent.keyDown(lint, { key: 'Enter' })
      expect(onSubmit).not.toHaveBeenCalled()
      fireEvent.keyDown(lint, { key: '1' })
      fireEvent.keyDown(lint, { key: 'Enter' })
      expect(onSubmit).toHaveBeenCalledWith([['pnpm'], ['lint']])
    })

    it('takes the primary action on Cmd+Enter from the free-text box, Next before the last question', () => {
      const { onSubmit } = renderCard({ question: TWO_QUESTIONS })
      fireEvent.click(screen.getByRole('radio', { name: /type your own answer/i }))
      const box = screen.getByLabelText('Your answer')

      // Blank: no answer yet, so nothing happens.
      fireEvent.keyDown(box, { key: 'Enter', metaKey: true })
      expect(screen.getByText('Which package manager?')).toBeInTheDocument()

      fireEvent.change(box, { target: { value: 'yarn' } })
      fireEvent.keyDown(box, { key: 'Enter', metaKey: true })
      expect(screen.getByText('Which checks should run?')).toBeInTheDocument()
      expect(onSubmit).not.toHaveBeenCalled()
    })

    it('keeps Enter in the free-text box a new line, and sends on Cmd or Ctrl+Enter', () => {
      const { onSubmit } = renderCard()
      fireEvent.click(screen.getByRole('radio', { name: /type your own answer/i }))
      const box = screen.getByLabelText('Your answer')
      fireEvent.change(box, { target: { value: 'yarn' } })

      fireEvent.keyDown(box, { key: 'Enter' })
      expect(onSubmit).not.toHaveBeenCalled()

      fireEvent.keyDown(box, { key: 'Enter', ctrlKey: true })
      expect(onSubmit).toHaveBeenCalledWith([['yarn']])
    })

    it('does not send while the answer is in flight', () => {
      const { onSubmit } = renderCard({ submitting: true })
      fireEvent.click(screen.getByRole('radio', { name: /bun/ }))

      fireEvent.keyDown(screen.getByRole('radio', { name: /bun/ }), { key: 'Enter' })

      expect(onSubmit).not.toHaveBeenCalled()
    })

    it('shows each option\'s digit as a keycap that touch screens do not get', () => {
      renderCard()

      const caps = Array.from(document.querySelectorAll('kbd')).map((kbd) => kbd.textContent)
      // Two options and "Type your own answer".
      expect(caps).toEqual(['1', '2', '3'])
      for (const kbd of document.querySelectorAll('kbd')) {
        expect(kbd.className).toContain('pointer-coarse:hidden')
        expect(kbd.getAttribute('aria-hidden')).toBe('true')
      }
      // The digit is not part of the option's name; assistive tech gets it as a shortcut.
      expect(screen.getByRole('radio', { name: /^pnpm Recommended/ })).toBeInTheDocument()
      expect(screen.getByRole('radio', { name: /pnpm/ }).getAttribute('aria-keyshortcuts')).toBe('1')
    })

    it('shows no keycap on multi-choice rows (the checkbox is the affordance), yet the digit keys still pick them', () => {
      renderCard({ question: TWO_QUESTIONS })
      fireEvent.click(screen.getByRole('button', { name: /Checks/ }))

      expect(document.querySelectorAll('kbd')).toHaveLength(0)
      const test = screen.getByRole('checkbox', { name: /test/ })
      expect(test.getAttribute('aria-keyshortcuts')).toBe('2')
      expect(test).not.toBeChecked()

      fireEvent.keyDown(test, { key: '2' })
      expect(test).toBeChecked()
      expect(screen.getByRole('checkbox', { name: /lint/ })).not.toBeChecked()
    })
  })

  describe('look', () => {
    it('fills the chosen option with the selection fill and the rest with the keycap fill, with no borders', () => {
      renderCard()
      fireEvent.click(screen.getByRole('radio', { name: /bun/ }))

      const chosen = screen.getByRole('radio', { name: /bun/ }).closest('label')!
      const other = screen.getByRole('radio', { name: /pnpm/ }).closest('label')!
      expect(chosen.className).toContain('bg-(--color-fill-selected)')
      expect(chosen.className).toContain('text-(--color-text-on-selected)')
      expect(other.className).toContain('bg-(--bg-key)')
      for (const label of [chosen, other]) expect(label.className).not.toMatch(/(?<![\w-])border(?![\w-])/)
    })

    it('has no border inside the card, so the frame around it is the only one', () => {
      const { container } = renderCard({ question: TWO_QUESTIONS })

      expect(container.innerHTML).not.toMatch(/(?<![\w-:])border-[btlrxy](?![\w-])|(?<![\w-:])border(?![\w-])/)
    })

    it('keeps the option text and the caption at 12px or larger', () => {
      renderCard({
        question: question({
          questions: [
            { question: 'Which?', header: 'Which', multiple: false, options: [{ label: 'pnpm', description: 'Fast', recommended: false }] },
          ],
        }),
      })

      expect(screen.getByText('Fast').parentElement?.className).toContain('text-xs')
      expect(screen.getByText('Nothing picked: Send skips this question.').className).toContain('text-xs')
    })
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
