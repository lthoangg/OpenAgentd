import { Chip } from '@/components/ui/chip'
import { formatMetaDuration } from '@/components/ui/meta-row'
import { ModelName } from '@/components/ui/model-name'
import { useSimpleDetail } from '@/stores/useDisplayPrefsStore'
import { formatDurationWords } from '@/utils/format'

/**
 * A provider call failed and is being retried: one line, the model ID in
 * mono, the attempt and the wait with units, the raw error as a chip.
 * ``exhausted``: the retries ran out; the same line says so, and the error
 * card after it carries the way forward.
 *
 * With the Detail setting on Simple the line is a sentence, with no model ID
 * and no error code: "The model is busy. Trying again in 8 seconds (2 of 5)."
 * A dropped connection, which retries without a budget, says so instead.
 */
export function RetryNotice({ model, attempt, maxAttempts, delay, errorType, statusCode, exhausted = false }: {
  model?: string
  attempt?: unknown
  maxAttempts?: unknown
  delay?: unknown
  errorType?: unknown
  statusCode?: unknown
  exhausted?: boolean
}) {
  const simple = useSimpleDetail()
  if (simple) {
    const budgeted = typeof maxAttempts === 'number'
    const sentence = exhausted
      ? `Stopped trying${budgeted ? ` after ${maxAttempts} ${maxAttempts === 1 ? 'attempt' : 'attempts'}` : ''}.`
      : [
          budgeted ? 'The model is busy.' : 'The connection dropped.',
          ` Trying again${typeof delay === 'number' ? ` in ${formatDurationWords(delay * 1000)}` : ''}`,
          budgeted && attempt !== undefined && attempt !== null ? ` (${String(attempt)} of ${maxAttempts})` : '',
          '.',
        ].join('')
    return (
      <div
        role="status"
        data-provider-retry={exhausted ? undefined : ''}
        data-provider-exhausted={exhausted ? '' : undefined}
        className="flex min-h-7 items-center rounded-sm border border-(--color-border) bg-(--bg-card) px-3 py-1.5 text-xs text-(--color-text-muted)"
      >
        {sentence}
      </div>
    )
  }
  // Dropped connections retry without a budget until the network is back.
  const progress = typeof maxAttempts === 'number'
    ? `${String(attempt ?? '?')}/${maxAttempts}`
    : String(attempt ?? '?')
  const error = [statusCode, errorType].filter((v) => v !== undefined && v !== null && v !== '').map(String).join(' ')
  const modelName = model ? <ModelName id={model} className="align-bottom text-(--color-text-2)" /> : 'the model'
  return (
    <div
      role="status"
      data-provider-retry={exhausted ? undefined : ''}
      data-provider-exhausted={exhausted ? '' : undefined}
      className="flex min-h-7 flex-wrap items-center gap-x-2 gap-y-1 rounded-sm border border-(--color-border) bg-(--bg-card) px-3 py-1.5 text-xs text-(--color-text-muted)"
    >
      {exhausted ? (
        <span>
          {'Stopped retrying '}
          {modelName}
          {typeof maxAttempts === 'number' && <>{' after '}<span className="font-mono tabular-nums">{maxAttempts}</span>{maxAttempts === 1 ? ' attempt' : ' attempts'}</>}
        </span>
      ) : (
        <span>
          {'Retrying '}
          {modelName}
          {' · attempt '}
          <span className="font-mono tabular-nums">{progress}</span>
          {typeof delay === 'number' && <>{' · in '}<span className="font-mono tabular-nums">{formatMetaDuration(delay * 1000)}</span></>}
        </span>
      )}
      {error && <Chip tone="warning" mono>{error}</Chip>}
    </div>
  )
}
