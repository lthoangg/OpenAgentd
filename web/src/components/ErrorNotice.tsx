/**
 * What a crash screen says: a title, a sentence, the error's message in a
 * box that scrolls, its actions and Copy error details for a bug report.
 * The view boundary and the router's error page share it; the whole-app
 * screen (AppErrorBoundary) keeps its own copy so it imports almost nothing.
 */
import { useState, type ReactNode } from 'react'
import { Button } from '@/components/ui/button'

export function errorOf(value: unknown): Error {
  return value instanceof Error ? value : new Error(typeof value === 'string' ? value : 'Unknown error')
}

function CopyErrorButton({ error }: { error: Error }) {
  const [copied, setCopied] = useState(false)
  const copy = () => {
    void navigator.clipboard?.writeText(`${error.message}\n\n${error.stack ?? ''}`.trim()).then(() => setCopied(true))
  }
  return (
    <Button variant="ghost" onClick={copy}>
      {copied ? 'Copied' : 'Copy error details'}
    </Button>
  )
}

export function ErrorNotice({ title, description, error, actions, heading: Heading = 'h2' }: {
  title: string
  description: string
  error: Error
  actions: ReactNode
  heading?: 'h1' | 'h2'
}) {
  return (
    <div role="alert" className="flex max-w-sm flex-col items-center gap-4 px-6 text-center">
      <div className="flex flex-col gap-1.5">
        <Heading className="text-base font-semibold text-(--color-text)">{title}</Heading>
        <p className="text-sm text-(--color-text-muted)">{description}</p>
        <p className="mt-1 max-h-24 overflow-y-auto rounded-sm border border-(--color-border) bg-(--bg-card) px-3 py-2 text-left font-mono text-xs break-words text-(--color-text-2)">
          {error.message}
        </p>
      </div>
      <div className="flex flex-wrap justify-center gap-2">
        {actions}
        <CopyErrorButton error={error} />
      </div>
    </div>
  )
}
