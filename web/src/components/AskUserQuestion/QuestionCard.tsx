/**
 * QuestionCard — the form the user answers ``ask_user_question`` with.
 *
 * Pure and props-driven: it owns selection state and the draft cache, and knows
 * nothing about the store, the API, or which shell (dock or sheet) it sits in.
 *
 * Shape of the reply it produces: ``string[][]``, index-matched to the questions
 * that were asked, with an empty entry meaning "skipped". The backend validates
 * against exactly that, so nothing here may reorder or omit a group.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Check } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import { InlineMarkdown } from '@/utils/inline-markdown'
import type { PendingQuestion, QuestionItem } from '@/api/types'
import {
  readQuestionDraft,
  writeQuestionDraft,
  type QuestionDraft,
} from './draft-cache'

const CUSTOM_LABEL = 'Type your own answer'

/** Cap matching ``MAX_ANSWER_CHARS`` in ``app/api/schemas/team.py``. */
const MAX_ANSWER_CHARS = 2000

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
    if (!item.custom || !draft.customActive[index]) return selected
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
  const lastIdRef = useRef(question.id)
  if (lastIdRef.current !== question.id) {
    lastIdRef.current = question.id
    setDraft(readQuestionDraft(question.id))
  }

  useEffect(() => {
    writeQuestionDraft(question.id, draft)
  }, [question.id, draft])

  const step = Math.min(draft.step, questions.length - 1)
  const current = questions[step]

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
  }

  const answeredCount = useMemo(
    () => toAnswers(questions, draft).filter((group) => group.length > 0).length,
    [questions, draft],
  )

  const handleSubmit = () => {
    if (submitting) return
    onSubmit(toAnswers(questions, draft))
  }

  return (
    <div className={cn('flex min-h-0 flex-col', className)}>
      {questions.length > 1 && (
        // A stepper through one form, not a tab set: every step submits together
        // and there is no per-step panel. Plain buttons keep the keyboard model
        // the browser already provides — declaring `role="tab"` would promise
        // arrow-key navigation this does not implement.
        <div
          role="group"
          aria-label="Questions"
          className="flex shrink-0 gap-1 overflow-x-auto border-b border-(--color-border) px-3 pt-3 pb-2"
        >
          {questions.map((item, index) => {
            const answered = (toAnswers(questions, draft)[index] ?? []).length > 0
            return (
              <button
                key={index}
                type="button"
                aria-current={index === step ? 'step' : undefined}
                onClick={() => update({ step: index })}
                className={cn(
                  'flex items-center gap-1.5 rounded-sm px-2 py-1 text-[11px] whitespace-nowrap transition-colors',
                  index === step
                    ? 'bg-(--bg-key) text-(--color-text)'
                    : 'text-(--color-text-muted) hover:bg-(--bg-key)/40 hover:text-(--color-text)',
                )}
              >
                {answered && <Check size={11} className="text-(--color-success)" />}
                {/* ``header`` is plain text by contract — never markdown. */}
                <span>{item.header || `Question ${index + 1}`}</span>
              </button>
            )
          })}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        <fieldset className="min-w-0 border-0 p-0">
          <legend className="mb-2.5 block text-[13px] leading-relaxed text-(--color-text)">
            <InlineMarkdown text={current.question} />
          </legend>

          <div
            className="flex flex-col gap-1.5"
            role={current.multiple ? 'group' : 'radiogroup'}
          >
            {current.options.map((option) => {
              const selected = (draft.selected[step] ?? []).includes(option.label)
              return (
                <OptionRow
                  key={option.label}
                  multiple={current.multiple}
                  checked={selected}
                  onToggle={() => choose(step, option.label, current)}
                  label={option.label}
                  description={option.description}
                  recommended={option.recommended}
                />
              )
            })}

            {current.custom && (
              <OptionRow
                multiple={current.multiple}
                checked={draft.customActive[step] === true}
                onToggle={() => chooseCustom(step, current)}
                label={CUSTOM_LABEL}
                description={null}
                recommended={false}
                plainLabel
              />
            )}
          </div>

          {current.custom && draft.customActive[step] && (
            <Textarea
              autoFocus
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
        <p role="alert" className="shrink-0 px-3 pb-2 text-[11px] text-(--color-error)">
          {error}
        </p>
      )}

      <div className="flex shrink-0 flex-wrap items-center gap-2 border-t border-(--color-border) px-3 py-2.5">
        <span className="text-[11px] text-(--color-text-subtle)">
          {questions.length > 1
            ? `${answeredCount} of ${questions.length} answered`
            : answeredCount === 0
              ? 'Optional — send blank to skip'
              : null}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onDismiss}
            disabled={submitting}
          >
            Dismiss
          </Button>
          <Button
            type="button"
            variant="primary"
            size="sm"
            onClick={handleSubmit}
            disabled={submitting}
          >
            {submitting ? 'Sending…' : 'Send answer'}
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
 * radio/checkbox semantics come from the platform rather than ARIA guesswork.
 * The recommendation is part of the label text (not a colour or a bare icon) so
 * it reaches the accessible name.
 */
function OptionRow({
  multiple,
  checked,
  onToggle,
  label,
  description,
  recommended,
  plainLabel = false,
}: {
  multiple: boolean
  checked: boolean
  onToggle: () => void
  label: string
  description?: string | null
  recommended: boolean
  plainLabel?: boolean
}) {
  return (
    <label
      className={cn(
        'flex cursor-pointer items-start gap-2.5 rounded-md border px-2.5 py-2 transition-colors',
        checked
          ? 'border-(--color-border-strong) bg-(--bg-key)/50'
          : 'border-(--color-border) bg-(--bg-card) hover:bg-(--bg-key)/25',
      )}
    >
      {multiple ? (
        <Checkbox checked={checked} onChange={onToggle} className="mt-0.5" />
      ) : (
        <input
          type="radio"
          checked={checked}
          onChange={onToggle}
          className="mt-0.5 size-[18px] shrink-0 accent-(--accent-blue)"
        />
      )}
      <span className="min-w-0 flex-1">
        <span className="block text-xs leading-relaxed text-(--color-text)">
          {plainLabel ? label : <InlineMarkdown text={label} variant="code" />}
          {recommended && (
            <span className="ml-1.5 rounded-xs bg-(--bg-key) px-1 py-0.5 text-[10px] text-(--color-text-muted)">
              Recommended
            </span>
          )}
        </span>
        {description && (
          <span className="mt-0.5 block text-[11px] leading-relaxed text-(--color-text-muted)">
            <InlineMarkdown text={description} />
          </span>
        )}
      </span>
    </label>
  )
}
