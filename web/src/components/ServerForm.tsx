import { useEffect, useRef } from 'react'

import { Button } from '@/components/ui/button'
import { Field } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { TEXT } from '@/components/settings/tokens'
import { useTouchFirst } from '@/hooks/use-touch-first'
import { shake } from '@/lib/shake'
import { cn } from '@/lib/utils'

/**
 * The fields and the one button of a form, drawn where it was opened: under
 * the row being edited, or at the end of the list for a new computer.
 * Connect (Save, when editing) tests the address and key first and says
 * why in place when the test fails. Escape cancels the form (and only it,
 * not the dialog around it). Enter connects, as the button does. On a touch
 * keyboard Return is "Next" between the fields, so half a form is never
 * sent, and "Go" on the last one.
 */
export function ServerForm({
  mode,
  label,
  baseUrl,
  accessKey,
  serverName,
  onBaseUrlChange,
  onAccessKeyChange,
  onServerNameChange,
  error,
  tested,
  pending,
  onSave,
  onCancel,
}: {
  mode: 'add' | 'edit'
  /** The edited computer's name; `null` for a new one. */
  label: string | null
  baseUrl: string
  accessKey: string
  serverName: string
  onBaseUrlChange: (value: string) => void
  onAccessKeyChange: (value: string) => void
  onServerNameChange: (value: string) => void
  error: string | null
  /** The address and key as typed already passed a test (a scanned code is tested on arrival). */
  tested: boolean
  pending: boolean
  onSave: () => void
  onCancel: () => void
}) {
  const touchForm = useTouchFirst()
  const urlRef = useRef<HTMLInputElement>(null)
  const fieldsRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    urlRef.current?.focus({ preventScroll: true })
    urlRef.current?.scrollIntoView?.({ block: 'nearest' })
  }, [])
  // A rejected address or key shakes the fields (a repeat of the same
  // message too: the error clears when a new try starts).
  useEffect(() => {
    if (error) shake(fieldsRef.current)
  }, [error])
  const title = mode === 'edit' ? `Edit ${label}` : 'Add a computer by address'
  const saveLabel = mode === 'add' ? (pending ? 'Connecting…' : 'Connect') : (pending ? 'Saving…' : 'Save')
  return (
    <form
      role="group"
      aria-label={title}
      data-server-form={mode}
      className="bg-(--bg-key)/20"
      noValidate
      onSubmit={(event) => {
        event.preventDefault()
        if (!pending) onSave()
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter' && touchForm && !event.nativeEvent.isComposing && event.target instanceof HTMLInputElement) {
          const fields = Array.from(event.currentTarget.querySelectorAll<HTMLInputElement>('input'))
          const next = fields[fields.indexOf(event.target) + 1]
          if (next) {
            event.preventDefault()
            next.focus()
          }
          return
        }
        if (event.key !== 'Escape') return
        event.preventDefault()
        event.stopPropagation()
        onCancel()
      }}
    >
      <p className={cn('px-4 pt-4', TEXT.title)}>{title}</p>
      <div ref={fieldsRef} className="grid gap-y-5 px-4 py-4">
        <Field label="Address" htmlFor="app-backend-url">
          <Input
            ref={urlRef}
            id="app-backend-url"
            type="url"
            inputMode="url"
            value={baseUrl}
            onChange={(event) => onBaseUrlChange(event.target.value)}
            placeholder="http://<host>:4082"
            autoComplete="off"
            spellCheck={false}
            enterKeyHint="next"
            className="h-9 font-mono"
          />
        </Field>
        <Field label="Access key" htmlFor="app-backend-key">
          <Input
            id="app-backend-key"
            value={accessKey}
            onChange={(event) => onAccessKeyChange(event.target.value)}
            placeholder="Leave empty if it has none"
            type="password"
            autoComplete="off"
            enterKeyHint="next"
            className="h-9"
          />
        </Field>
        <Field label="Name" htmlFor="app-backend-name">
          <Input
            id="app-backend-name"
            value={serverName}
            onChange={(event) => onServerNameChange(event.target.value)}
            placeholder="Work laptop, Home server"
            autoComplete="off"
            autoCapitalize="words"
            enterKeyHint="go"
            className="h-9"
          />
        </Field>
      </div>
      <div className={touchForm ? 'flex flex-col gap-3 px-4 pb-4' : 'flex flex-col gap-3 px-4 pb-4 sm:flex-row sm:items-center'}>
        <div className={cn('min-w-0 flex-1 leading-relaxed', touchForm ? 'text-meta' : 'text-xs')}>
          {error ? (
            <p role="alert" className="text-(--color-error)">{error}</p>
          ) : tested ? (
            <p role="status" className="font-medium text-(--accent-green-text)">Connection successful.</p>
          ) : null}
        </div>
        {touchForm ? (
          // Touch: one large button, with Cancel under it.
          <div className="grid gap-2">
            <Button type="submit" variant="primary" disabled={pending} className="h-11 w-full">
              {saveLabel}
            </Button>
            <Button type="button" variant="ghost" onClick={onCancel} disabled={pending} className="h-11 w-full">
              Cancel
            </Button>
          </div>
        ) : (
          <div className="flex shrink-0 flex-wrap justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={pending}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" size="sm" disabled={pending}>
              {saveLabel}
            </Button>
          </div>
        )}
      </div>
    </form>
  )
}
