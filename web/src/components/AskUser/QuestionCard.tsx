/**
 * QuestionCard — the form the user answers ``ask_user`` with.
 *
 * Pure and props-driven: it owns selection state and the draft cache, and knows
 * nothing about the store, the API, or which shell (dock or sheet) it sits in.
 *
 * Shape of the reply it produces: ``string[][]``, index-matched to the questions
 * that were asked, with an empty entry meaning "skipped". The backend validates
 * against exactly that, so nothing here may reorder or omit a group.
 *
 * Every question offers "Type your own answer". The server sends ``custom`` for
 * older clients only; it no longer lets the model turn free text off.
 *
 * The primary action is always **Send**: it sends the answers given so far, and
 * any question left unanswered goes out as skipped (the caption says how many).
 * It waits, with the reason on screen, until at least one answer exists.
 * Skipping is its own secondary action and names what it does — "Skip this
 * question" moves on, and on the last question "Skip and send" sends with it
 * skipped. Back and Next page through a multi-question card.
 *
 * Keys: 1–9 pick the Nth option of the current question (the last number is
 * "Type your own answer"), Enter sends, and Cmd/Ctrl+Enter sends from the
 * free-text box. They apply while focus is inside the card and not in a text
 * field. Each option carries its digit as a keycap (hidden on touch).
 * Double-clicking a single-answer option chooses it and goes on, as a list
 * dialog does: to the next question, or Send from the last.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { flushSync } from 'react-dom'
import { Check } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { hasFinePointer } from '@/lib/pointer'
import { cn } from '@/lib/utils'
import { InlineMarkdown } from '@/utils/inline-markdown'
import type { PendingQuestion, QuestionItem } from '@/api/types'
import {
  readQuestionDraft,
  writeQuestionDraft,
  type QuestionDraft,
} from './draft-cache'

const CUSTOM_LABEL = 'Type your own answer'

/** Cap matching ``MAX_ANSWER_CHARS`` in ``app/api/schemas/agent.py``. */
const MAX_ANSWER_CHARS = 2000

/** A text-entry target keeps its keys: digits and Enter are typing there. */
function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable || target.tagName === 'TEXTAREA') return true
  return target.tagName === 'INPUT' && !/^(radio|checkbox|button|submit|reset)$/.test((target as HTMLInputElement).type)
}

interface QuestionCardProps {
  question: PendingQuestion
  /** Index-matched selected labels per question; empty entry = skipped. */
  onSubmit: (answers: string[][]) => void
  onDismiss: () => void
  submitting: boolean
  error: string | null
  /** Rendered above the questions — the dock and the sheet frame it differently. */
  className?: string
}

/** Collapse the draft into the wire shape. */
function toAnswers(questions: QuestionItem[], draft: QuestionDraft): string[][] {
  return questions.map((item, index) => {
    const selected = draft.selected[index] ?? []
    if (!draft.customActive[index]) return selected
    const text = (draft.customText[index] ?? '').trim()
    // A chosen-but-blank free-text answer is a skip, not an empty string: the
    // backend would otherwise show the model an answer the user never gave.
    if (!text) return item.multiple ? selected : []
    return item.multiple ? [...selected, text] : [text]
  })
}

export function QuestionCard({
  question,
  onSubmit,
  onDismiss,
  submitting,
  error,
  className,
}: QuestionCardProps) {
  const questions = question.questions
  const [draft, setDraft] = useState<QuestionDraft>(() => readQuestionDraft(question.id))

  // Re-seed when the card is reused for a different question (the dock keys on
  // id, but a parent that does not would otherwise show a stale draft).
  const [prevQuestionId, setPrevQuestionId] = useState(question.id)
  if (prevQuestionId !== question.id) {
    setPrevQuestionId(question.id)
    setDraft(readQuestionDraft(question.id))
  }

  useEffect(() => {
    writeQuestionDraft(question.id, draft)
  }, [question.id, draft])

  const step = Math.min(draft.step, questions.length - 1)
  const current = questions[step]

  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const isCustomActive = draft.customActive[step] === true

  useEffect(() => {
    if (isCustomActive && textareaRef.current) {
      const el = textareaRef.current
      if (typeof el.scrollIntoView === 'function') {
        el.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
      }
      // Mobile viewports (Tauri mobile app / mobile browser) shrink when the soft
      // keyboard slides up (~300ms). Re-scroll to ensure the placeholder remains visible.
      const timer = setTimeout(() => {
        if (typeof el.scrollIntoView === 'function') {
          el.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
        }
      }, 300)
      return () => clearTimeout(timer)
    }
  }, [isCustomActive, step])

  const update = useCallback((patch: Partial<QuestionDraft>) => {
    setDraft((prev) => ({ ...prev, ...patch }))
  }, [])

  const choose = (index: number, label: string, item: QuestionItem) => {
    setDraft((prev) => {
      const selected = prev.selected[index] ?? []
      if (!item.multiple) {
        return {
          ...prev,
          selected: { ...prev.selected, [index]: [label] },
          // Picking a listed option turns the free-text box off; a single-answer
          // question can only carry one of the two.
          customActive: { ...prev.customActive, [index]: false },
        }
      }
      const next = selected.includes(label)
        ? selected.filter((value) => value !== label)
        : [...selected, label]
      return { ...prev, selected: { ...prev.selected, [index]: next } }
    })
  }

  const chooseCustom = (index: number, item: QuestionItem) => {
    const activating = !draft.customActive[index]
    // Render the box and focus it inside this tap: a touch keyboard opens only
    // for focus within a user gesture, and only when the user asked for it.
    flushSync(() => {
      setDraft((prev) => {
        const active = !prev.customActive[index]
        return {
          ...prev,
          customActive: { ...prev.customActive, [index]: active },
          selected:
            active && !item.multiple
              ? { ...prev.selected, [index]: [] }
              : prev.selected,
        }
      })
    })
    if (activating) textareaRef.current?.focus()
  }

  const answeredCount = useMemo(
    () => toAnswers(questions, draft).filter((group) => group.length > 0).length,
    [questions, draft],
  )
  const unansweredCount = questions.length - answeredCount

  const isLastStep = step === questions.length - 1
  const isFirstStep = step === 0
  const currentAnswered = (toAnswers(questions, draft)[step] ?? []).length > 0

  // Send needs something to send; the caption says why it waits.
  const canSend = !submitting && answeredCount > 0
  const send = () => {
    if (!canSend) return
    onSubmit(toAnswers(questions, draft))
  }

  // Skipping the current question leaves it blank: it moves on, and from the
  // last question it sends what the other questions got.
  const skip = () => {
    if (submitting) return
    if (!isLastStep) {
      update({ step: step + 1 })
      return
    }
    onSubmit(toAnswers(questions, draft))
  }

  // A double-click on a single-answer option is that choice plus the default
  // action, as in a list dialog: the next question, or Send from the last.
  const chooseAndContinue = (label: string) => {
    if (submitting) return
    const next: QuestionDraft = {
      ...draft,
      selected: { ...draft.selected, [step]: [label] },
      customActive: { ...draft.customActive, [step]: false },
    }
    if (!isLastStep) {
      setDraft({ ...next, step: step + 1 })
      return
    }
    setDraft(next)
    onSubmit(toAnswers(questions, next))
  }

  const caption =
    answeredCount === 0
      ? questions.length > 1
        ? 'Answer at least one question to send.'
        : 'Pick an answer to send, or skip.'
      : questions.length > 1
        ? `${answeredCount} of ${questions.length} answered${unansweredCount > 0 ? ` · ${unansweredCount} will be skipped` : ''}`
        : null
  const captionId = `${useId()}-caption`

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.defaultPrevented || event.nativeEvent.isComposing) return
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      if (!canSend) return
      event.preventDefault()
      send()
      return
    }
    if (event.metaKey || event.ctrlKey || event.altKey || isTextEntry(event.target)) return
    if (/^[1-9]$/.test(event.key)) {
      const index = Number(event.key) - 1
      const option = current.options[index]
      if (option) choose(step, option.label, current)
      else if (index === current.options.length) chooseCustom(step, current)
      else return
      event.preventDefault()
      return
    }
    // Enter on a button or link is that control's own click.
    if (event.key === 'Enter' && canSend && !(event.target as HTMLElement).closest('button, a')) {
      event.preventDefault()
      send()
    }
  }

  return (
    <div className={cn('flex min-h-0 flex-col', className)} onKeyDown={onKeyDown}>
      {questions.length > 1 && (
        // A stepper through one form, not a tab set: every step submits together
        // and there is no per-step panel. Plain buttons keep the keyboard model
        // the browser already provides — declaring `role="tab"` would promise
        // arrow-key navigation this does not implement.
        <div role="group" aria-label="Questions" className="flex shrink-0 gap-1 overflow-x-auto px-3 pt-1 pb-2">
          {questions.map((item, index) => {
            const answered = (toAnswers(questions, draft)[index] ?? []).length > 0
            return (
              <button
                key={index}
                type="button"
                aria-current={index === step ? 'step' : undefined}
                onClick={() => update({ step: index })}
                className={cn(
                  'flex min-h-6 items-center gap-1.5 rounded-sm px-2 py-1 text-meta whitespace-nowrap transition-colors pointer-coarse:min-h-9 pointer-coarse:px-3',
                  index === step
                    ? 'bg-(--bg-key) font-medium text-(--color-text)'
                    : 'text-(--color-text-muted) hover:bg-(--bg-key)/40 hover:text-(--color-text)',
                )}
              >
                {answered && <Check size={11} className="text-(--accent-green-text)" />}
                {/* ``header`` is plain text by contract — never markdown. */}
                <span>{item.header || `Question ${index + 1}`}</span>
              </button>
            )
          })}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto px-3 pt-1 pb-3">
        <fieldset className="min-w-0 border-0 p-0">
          <legend className="selectable-text mb-2.5 block text-code leading-relaxed text-(--color-text) [overflow-wrap:anywhere]">
            <InlineMarkdown text={current.question} />
          </legend>

          <div
            className="flex flex-col gap-1.5"
            role={current.multiple ? 'group' : 'radiogroup'}
          >
            {current.options.map((option, index) => {
              const selected = (draft.selected[step] ?? []).includes(option.label)
              return (
                <OptionRow
                  key={option.label}
                  multiple={current.multiple}
                  checked={selected}
                  onToggle={() => choose(step, option.label, current)}
                  onChooseAndContinue={current.multiple ? undefined : () => chooseAndContinue(option.label)}
                  label={option.label}
                  description={option.description}
                  recommended={option.recommended}
                  shortcut={index < 9 ? index + 1 : null}
                />
              )
            })}

            <OptionRow
              multiple={current.multiple}
              checked={isCustomActive}
              onToggle={() => chooseCustom(step, current)}
              label={CUSTOM_LABEL}
              description={null}
              recommended={false}
              plainLabel
              shortcut={current.options.length < 9 ? current.options.length + 1 : null}
            />
          </div>

          {isCustomActive && (
            <Textarea
              ref={textareaRef}
              // A restored card (reconnect, reopened sheet) must not raise a
              // touch keyboard on its own; ``chooseCustom`` focuses on tap.
              autoFocus={hasFinePointer()}
              value={draft.customText[step] ?? ''}
              maxLength={MAX_ANSWER_CHARS}
              onChange={(event) =>
                update({ customText: { ...draft.customText, [step]: event.target.value } })
              }
              placeholder="Your answer…"
              aria-label="Your answer"
              className="mt-2 min-h-16"
            />
          )}
        </fieldset>
      </div>

      {error && (
        <p role="alert" className="shrink-0 px-3 pb-2 text-xs text-(--color-error)">
          {error}
        </p>
      )}

      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 px-3 pb-3">
        {/* 12rem at least: on a phone the buttons wrap under the caption
            rather than squeezing it to one word a line. */}
        {caption && (
          <span id={captionId} className="flex-1 basis-48 text-xs text-(--color-text-muted)">
            {caption}
          </span>
        )}
        <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={onDismiss} disabled={submitting}>
            Dismiss
          </Button>
          {!isFirstStep && (
            <Button type="button" variant="ghost" size="sm" onClick={() => update({ step: step - 1 })} disabled={submitting}>
              Back
            </Button>
          )}
          {!isLastStep && (
            <Button type="button" variant="ghost" size="sm" onClick={() => update({ step: step + 1 })} disabled={submitting}>
              Next
            </Button>
          )}
          {!currentAnswered && (
            <Button type="button" variant="default" size="sm" onClick={skip} disabled={submitting}>
              {isLastStep ? 'Skip and send' : 'Skip this question'}
            </Button>
          )}
          <Button
            type="button"
            variant="primary"
            size="sm"
            onClick={send}
            disabled={!canSend}
            aria-describedby={canSend ? undefined : captionId}
          >
            {submitting ? 'Sending…' : 'Send'}
          </Button>
        </div>
      </div>
    </div>
  )
}

/**
 * One selectable option.
 *
 * A real ``input`` carries the role, checked state and keyboard behaviour, so
 * radio/checkbox semantics come from the platform rather than ARIA guesswork;
 * it is visually hidden and the row is the control. The chosen row is filled
 * Bark edge to edge, the others take the keycap fill, and nothing has a border.
 * The recommendation is part of the label text (not a colour or a bare icon) so
 * it reaches the accessible name; the digit keycap is decoration for the
 * 1–9 shortcut (``aria-keyshortcuts`` names it for assistive tech).
 */
function OptionRow({
  multiple,
  checked,
  onToggle,
  onChooseAndContinue,
  label,
  description,
  recommended,
  plainLabel = false,
  shortcut,
}: {
  multiple: boolean
  checked: boolean
  onToggle: () => void
  /** Double-click: choose and go on (next question, or Send). */
  onChooseAndContinue?: () => void
  label: string
  description?: string | null
  recommended: boolean
  plainLabel?: boolean
  /** The digit that picks this row, or ``null`` past the ninth. */
  shortcut: number | null
}) {
  return (
    <label
      onDoubleClick={onChooseAndContinue}
      className={cn(
        'flex cursor-pointer items-start gap-2.5 rounded-md px-2.5 py-2 transition-colors has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-(--focus-ring) pointer-coarse:min-h-9',
        checked
          ? 'bg-(--color-fill-selected) text-(--color-text-on-selected)'
          : 'bg-(--bg-key) text-(--color-text) hover:bg-(--color-fill-key-hover)',
      )}
    >
      <input
        type={multiple ? 'checkbox' : 'radio'}
        checked={checked}
        onChange={onToggle}
        aria-keyshortcuts={shortcut === null ? undefined : String(shortcut)}
        className="sr-only"
      />
      {shortcut !== null && (
        <kbd
          aria-hidden="true"
          className={cn(
            'mt-px inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-xs px-1 font-mono text-meta leading-none pointer-coarse:hidden',
            checked ? 'bg-(--color-text-on-selected)/20 text-(--color-text-on-selected)' : 'bg-(--bg-card) text-(--color-text-muted)',
          )}
        >
          {shortcut}
        </kbd>
      )}
      {multiple && (
        // A multi-answer question reads as checkboxes: the fill alone would
        // not say that several can be chosen.
        <span
          aria-hidden="true"
          className={cn(
            'mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-xs',
            checked ? 'bg-(--color-text-on-selected)/20' : 'bg-(--bg-card)',
          )}
        >
          {checked && <Check size={11} />}
        </span>
      )}
      <span className="min-w-0 flex-1">
        <span className="block text-xs leading-relaxed [overflow-wrap:anywhere]">
          {plainLabel ? label : <InlineMarkdown text={label} variant="code" />}
          {recommended && (
            // A tag, not a status chip: the chip fills would vanish into the
            // keycap-filled row, so it takes the card fill (or a lighter Bark).
            <span
              className={cn(
                'ml-1.5 inline-flex h-[18px] items-center rounded-xs px-1.5 align-middle text-meta leading-none font-medium whitespace-nowrap',
                checked ? 'bg-(--color-text-on-selected)/20 text-(--color-text-on-selected)' : 'bg-(--bg-card) text-(--color-text-muted)',
              )}
            >
              Recommended
            </span>
          )}
        </span>
        {description && (
          <span
            className={cn(
              'mt-0.5 block text-xs leading-relaxed [overflow-wrap:anywhere]',
              checked ? 'text-(--color-text-on-selected)' : 'text-(--color-text-muted)',
            )}
          >
            <InlineMarkdown text={description} />
          </span>
        )}
      </span>
    </label>
  )
}
