import { useEffect, useRef, useState } from 'react'
import { Check, CheckCircle2, Copy, Loader2, TerminalSquare } from 'lucide-react'
import { useQueryClient } from '@tanstack/react-query'

import { installSeed, oauthLoginStream, submitOAuthCallback, type OAuthLoginEvent, type ProviderInfo } from '@/api/client'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { queryKeys } from '@/queries'
import { openExternalUrl } from '@/lib/open-external'
import { useToastStore } from '@/stores/useToastStore'
import { deviceCodeHelp, eventLabel, isBenignOAuthStreamClose } from './providerUtils'

export function OAuthLoginDialog({
  provider,
  open,
  onOpenChange,
}: {
  provider: ProviderInfo
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const [events, setEvents] = useState<OAuthLoginEvent[]>([])
  const [error, setError] = useState<string | null>(null)
  const [code, setCode] = useState('')
  const [codeCopied, setCodeCopied] = useState(false)
  const [authMode, setAuthMode] = useState<'device' | 'browser'>('device')
  const [submittingCode, setSubmittingCode] = useState(false)
  const openedUrlRef = useRef<string | null>(null)
  const successHandledRef = useRef(false)
  const queryClient = useQueryClient()
  const latest = events.at(-1)
  const deviceEvent = events.find((event) => event.event === 'device_code')
  const isSuccess = latest?.event === 'success'
  const isWorking = open && !isSuccess && !error

  const copyDeviceCode = async () => {
    if (!deviceEvent?.user_code) return
    try {
      await navigator.clipboard.writeText(deviceEvent.user_code)
      setCodeCopied(true)
      window.setTimeout(() => setCodeCopied(false), 1500)
    } catch {
      // Copy is best-effort; the code remains visible for manual entry.
    }
  }

  useEffect(() => {
    if (!open) return undefined
    const abort = new AbortController()
    openedUrlRef.current = null
    successHandledRef.current = false
    oauthLoginStream(
      provider.id,
      {
        onEvent: () => undefined,
        onOAuthEvent: (event) => {
          setEvents((current) => [...current, event])
          if (event.verification_uri && openedUrlRef.current !== event.verification_uri) {
            openedUrlRef.current = event.verification_uri
            void openExternalUrl(event.verification_uri)
          }
          if (event.event === 'success' && !successHandledRef.current) {
            successHandledRef.current = true
            void queryClient.invalidateQueries({ queryKey: queryKeys.settings.providerModels(provider.id) })
            void queryClient.invalidateQueries({ queryKey: queryKeys.settings.providers() })
            void queryClient.invalidateQueries({ queryKey: queryKeys.agentFiles.registry() })
            const model = event.suggested_model
            if (model) {
              void installSeed(model)
                .then(() => {
                  useToastStore.getState().push({
                    tone: 'success',
                    title: 'Provider connected',
                    description: 'Default agents and skills are ready.',
                  })
                })
                .catch((err: unknown) => {
                  useToastStore.getState().push({
                    tone: 'error',
                    title: 'Seed install failed',
                    description: err instanceof Error ? err.message : String(err),
                  })
                })
            } else {
              useToastStore.getState().push({ tone: 'success', title: 'Provider connected', description: provider.label })
            }
          }
          if (event.event === 'failed') {
            setError(event.message ?? 'OAuth login failed')
          }
        },
        onError: (err) => {
          if (successHandledRef.current && isBenignOAuthStreamClose(err.message)) return
          setError(err.message)
        },
      },
      abort.signal,
      authMode === 'browser' ? 'browser' : undefined,
    )
    return () => abort.abort()
  }, [authMode, open, provider.id, provider.label, queryClient])

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) setAuthMode('device')
        onOpenChange(nextOpen)
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Connect {provider.label}</DialogTitle>
          <DialogDescription>Approve the browser prompt. This window will update when the token is saved.</DialogDescription>
        </DialogHeader>
        <div className="min-w-0 space-y-4">
          <div className="flex items-center gap-3 rounded-lg border border-(--color-border) bg-(--bg-key) p-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-(--bg-card) text-(--color-accent) ring-1 ring-(--color-border)">
              {isWorking ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <CheckCircle2 className="h-4 w-4" aria-hidden="true" />}
            </div>
            <div>
              <p className="text-sm font-medium text-(--color-text)">{latest ? eventLabel(latest) : 'Starting secure login'}</p>
              <p className="text-xs text-(--color-text-muted)">Keep this dialog open until setup completes.</p>
            </div>
          </div>
          {deviceEvent?.user_code && (
            <div className="overflow-hidden rounded-xl border border-(--accent-blue)/25 bg-(--accent-blue-soft)">
              <div className="p-5 text-center">
                <p className="text-xs font-medium tracking-[0.18em] text-(--color-text-muted) uppercase">Device code</p>
                <div className="mt-2 flex flex-col items-center justify-center gap-3 sm:flex-row">
                  <p className="font-mono text-3xl font-semibold tracking-[0.18em] text-(--color-text)">{deviceEvent.user_code}</p>
                  <button
                    type="button"
                    onClick={() => { void copyDeviceCode() }}
                    className="flex h-9 w-9 items-center justify-center rounded-md border border-(--color-border) bg-(--bg-card) text-(--color-text-muted) transition-colors hover:bg-(--bg-key) hover:text-(--color-text)"
                    aria-label="Copy device code"
                    title="Copy device code"
                  >
                    {codeCopied ? <Check size={15} className="text-(--color-success)" /> : <Copy size={15} />}
                  </button>
                </div>
                <p className="mx-auto mt-2 max-w-sm text-xs leading-relaxed text-(--color-text-muted)">
                  {deviceCodeHelp(provider.id)}
                </p>
                {deviceEvent.verification_uri && (
                  <Button className="mt-4 min-h-11 sm:min-h-0" size="sm" onClick={() => void openExternalUrl(deviceEvent.verification_uri!)}>
                    Open authorization page
                  </Button>
                )}
              </div>
              {provider.id === 'codex' && authMode !== 'browser' && !isSuccess && (
                <div className="border-t border-(--accent-blue)/20 bg-(--bg-page)/70 p-4 text-left">
                  <p className="text-xs font-medium text-(--color-text)">Workspace account?</p>
                  <p className="mt-1 text-xs leading-relaxed text-(--color-text-muted)">
                    If the Codex page says your admin must enable device-code authentication, switch to browser sign-in.
                  </p>
                  <Button
                    className="mt-3 min-h-11 w-full sm:min-h-0"
                    size="sm"
                    variant="secondary"
                    onClick={() => {
                      setError(null)
                      setEvents([])
                      setAuthMode('browser')
                    }}
                  >
                    Use browser sign-in instead
                  </Button>
                </div>
              )}
            </div>
          )}
          {latest?.event === 'code_required' && (
            <form
              className="space-y-2 rounded-lg border border-(--color-border) bg-(--bg-page) p-3"
              onSubmit={(event) => {
                event.preventDefault()
                setSubmittingCode(true)
                submitOAuthCallback(provider.id, code)
                  .then((result) => {
                    setEvents((current) => [...current, { event: 'success', suggested_model: result.suggested_model }])
                    void queryClient.invalidateQueries({ queryKey: queryKeys.settings.providerModels(provider.id) })
                    void queryClient.invalidateQueries({ queryKey: queryKeys.settings.providers() })
                    void queryClient.invalidateQueries({ queryKey: queryKeys.agentFiles.registry() })

                    useToastStore.getState().push({ tone: 'success', title: 'Provider connected', description: provider.label })
                  })
                  .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
                  .finally(() => setSubmittingCode(false))
              }}
            >
              <label className="block text-xs font-medium text-(--color-text-muted)">
                Paste authorization callback URL/code
                <Input value={code} onChange={(event) => setCode(event.target.value)} className="mt-1" autoComplete="off" />
              </label>
              <Button type="submit" size="sm" disabled={!code.trim() || submittingCode}>
                {submittingCode && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
                Finish connection
              </Button>
            </form>
          )}
          {isSuccess && (
            <p className="rounded-md bg-(--color-success-subtle) p-3 text-sm text-(--color-success)">Connected successfully.</p>
          )}
          {error && <p className="rounded-md bg-(--color-error)/10 p-3 text-sm text-(--color-error)">{error}</p>}
          {events.length > 0 && (
            <details className="rounded-md border border-(--color-border) bg-(--bg-page) p-3">
              <summary className="flex cursor-pointer items-center gap-2 text-xs font-medium text-(--color-text-muted)">
                <TerminalSquare size={13} aria-hidden="true" />
                Technical details
              </summary>
              <div className="mt-3 max-h-40 min-w-0 space-y-2 overflow-auto">
                {events.map((event, index) => (
                  <p key={`${event.event}-${index}`} className="min-w-0 text-xs text-(--color-text-muted) [overflow-wrap:anywhere]">
                    <span className="font-mono text-(--color-text)">{event.event}</span>
                    {event.message ? ` · ${event.message}` : ''}
                  </p>
                ))}
              </div>
            </details>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
