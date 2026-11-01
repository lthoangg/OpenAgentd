/**
 * A model as Usage shows it: `provider:model` in mono, like everywhere else
 * (see ui/model-name), so it can be matched against logs and config.
 */
import { ModelName } from '@/components/ui/model-name'

export function providerOf(providerModel: string): string | null {
  const index = providerModel.indexOf(':')
  return index > 0 ? providerModel.slice(0, index) : null
}

export function ModelId({ id, className }: { id: string; className?: string }) {
  return <ModelName id={id} className={className} />
}

const SHORT_DATE_TIME = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
})

/** "Oct 24, 20:13" in local time. */
export function shortDateTime(ms: number): string {
  return SHORT_DATE_TIME.format(new Date(ms))
}

const SHORT_DATE_TIME_SECONDS = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
})

/** "Oct 24, 20:13:05" in local time. */
export function shortDateTimeSeconds(ms: number): string {
  return SHORT_DATE_TIME_SECONDS.format(new Date(ms))
}
