import { useState } from 'react'

import { apiBaseUrl } from '@/api/base-url'
import { installTypeScriptLsp } from '@/api/client'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useLspInstallStore } from '@/stores/useLspInstallStore'
import type { LspInstallRequest } from '@/stores/useLspInstallStore'

export function LspInstallPrompt() {
  const request = useLspInstallStore((state) => state.request)

  if (!request) return null

  const requestKey = `${apiBaseUrl()}\0${request.workspace}\0${request.languageServerVersion}\0${request.typeScriptVersion}`
  return <LspInstallDialog key={requestKey} request={request} />
}

function LspInstallDialog({ request }: { request: LspInstallRequest }) {
  const dismiss = useLspInstallStore((state) => state.dismiss)
  const [error, setError] = useState<string | null>(null)
  const [installed, setInstalled] = useState(false)
  const [installing, setInstalling] = useState(false)

  const close = () => {
    setError(null)
    setInstalled(false)
    dismiss()
  }

  const install = async () => {
    setError(null)
    setInstalling(true)
    try {
      const status = await installTypeScriptLsp()
      if (status.typescript.state === 'error') {
        setError(status.typescript.detail ?? 'TypeScript language tools could not be installed.')
      } else if (status.typescript.state !== 'ready') {
        setError('TypeScript language tools did not finish installing. Try again or check the backend logs.')
      } else {
        setInstalled(true)
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'TypeScript language tools could not be installed.')
    } finally {
      setInstalling(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) close() }}>
      <DialogContent showCloseButton={!installing} className="min-w-0">
        <DialogHeader>
          <DialogTitle>Install TypeScript language tools?</DialogTitle>
          <DialogDescription>
            TypeScript language tools are needed for this workspace. They will be downloaded and installed on the backend, not on this device.
          </DialogDescription>
          <div className="space-y-1 font-mono text-[11px] text-(--color-text-subtle)">
            <p className="break-all">{request.workspace}</p>
            <p>Language server {request.languageServerVersion}, TypeScript {request.typeScriptVersion}</p>
          </div>
        </DialogHeader>
        {error && <p role="alert" className="mt-3 text-sm text-(--color-error)">{error}</p>}
        {installed && <p role="status" className="mt-3 text-sm text-(--color-text-muted)">TypeScript language tools are ready on the backend.</p>}
        <DialogFooter className="mt-4">
          <Button type="button" variant="default" onClick={close} disabled={installing}>
            {installed ? 'Close' : 'Not now'}
          </Button>
          {!installed && (
            <Button type="button" variant="primary" onClick={() => { void install() }} disabled={installing}>
              {installing ? 'Installing…' : 'Install on backend'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
