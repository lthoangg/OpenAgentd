/**
 * A model as Usage shows it: the short ID in mono, then the provider as a
 * small outline tag (`claude-sonnet-4-6` `agy`). The full `provider:model`
 * string is the title, so it can be matched against logs and config.
 */
import { Chip } from '@/components/ui/chip'
import { cn } from '@/lib/utils'
import { modelName } from './model'

export function providerOf(providerModel: string): string | null {
  const index = providerModel.indexOf(':')
  return index > 0 ? providerModel.slice(0, index) : null
}

export function ModelId({ id, className }: { id: string; className?: string }) {
  const provider = providerOf(id)
  return (
    <span className={cn('inline-flex min-w-0 max-w-full items-center gap-1.5', className)} title={id}>
      <span className="min-w-0 truncate font-mono">{modelName(id)}</span>
      {provider && <Chip mono variant="outline">{provider}</Chip>}
    </span>
  )
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
