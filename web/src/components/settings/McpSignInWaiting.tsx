/**
 * While a connector's sign-in is open in the browser: say so, let the person
 * call it off, and take the address the sign-in ended on when it could not
 * come back by itself (a browser that blocked the app link, a localhost page
 * on another machine).
 */
import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { TEXT } from '@/components/settings/tokens'
import { deliverSignInCode } from '@/lib/mcp-sign-in'
import { errorMessage } from '@/utils/errors'
import { cn } from '@/lib/utils'

export function McpSignInWaiting({ onCancel, className }: { onCancel: () => void; className?: string }) {
  const [pasting, setPasting] = useState(false)
  const [value, setValue] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const submit = async () => {
    setError(null)
    setBusy(true)
    try {
      await deliverSignInCode({ url: value.trim() })
      setPasting(false)
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={cn('space-y-2', className)} role="status">
      <div className="flex flex-wrap items-center gap-2">
        <span className={TEXT.hint}>Waiting for sign-in in your browser…</span>
        <Button type="button" variant="ghost" size="xs" onClick={onCancel}>Cancel</Button>
        {!pasting && (
          <Button type="button" variant="ghost" size="xs" onClick={() => setPasting(true)}>Paste address</Button>
        )}
      </div>
      {pasting && (
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            void submit()
          }}
        >
          <Input
            aria-label="Address the sign-in ended on"
            placeholder="Paste the address the sign-in ended on"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            autoFocus
          />
          <Button type="submit" size="sm" disabled={busy || !value.trim()}>{busy ? 'Finishing…' : 'Finish'}</Button>
        </form>
      )}
      {error && <p className="text-meta text-(--color-error)">{error}</p>}
    </div>
  )
}
