import { useCallback, useState } from 'react'
import { motion, useDragControls, type PanInfo } from 'framer-motion'
import { AlertCircle, Check, Download, GripVertical, Loader2, Maximize2, Minus } from 'lucide-react'

import { apiBaseUrl } from '@/api/base-url'
import { installTypeScriptLsp } from '@/api/client'
import { Button } from '@/components/ui/button'
import { useLspInstallStore } from '@/stores/useLspInstallStore'
import type { LspInstallRequest } from '@/stores/useLspInstallStore'
import { cn } from '@/lib/utils'

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
  const [minimized, setMinimized] = useState(false)
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const dragControls = useDragControls()

  const close = () => {
    setError(null)
    setInstalled(false)
    dismiss()
  }

  const handleDragEnd = useCallback((_: unknown, info: PanInfo) => {
    setOffset((prev) => ({
      x: prev.x + info.offset.x,
      y: prev.y + info.offset.y,
    }))
  }, [])

  const resetPosition = useCallback(() => {
    setOffset({ x: 0, y: 0 })
  }, [])

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
    <aside
      className="pointer-events-none flex w-full justify-end"
      aria-live="polite"
    >
      <motion.div
        drag
        dragListener={false}
        dragControls={dragControls}
        dragMomentum={false}
        dragElastic={0}
        onDragEnd={handleDragEnd}
        animate={{ x: offset.x, y: offset.y }}
        transition={{ type: 'spring', stiffness: 380, damping: 32 }}
        style={{ touchAction: 'none' }}
        role="dialog"
        aria-label="Install TypeScript language tools"
        data-swipe-ignore
        className={cn(
          'pointer-events-auto border border-(--color-border) bg-(--bg-card) text-sm text-(--color-text) shadow-(--shadow-depth) backdrop-blur-xs transition-[width,padding,border-radius] duration-(--motion-base)',
          minimized
            ? 'w-auto rounded-full px-3 py-1.5'
            : 'w-auto max-w-sm rounded-md p-4 sm:w-full sm:max-w-sm',
        )}
      >
        {minimized ? (
          <div className="flex items-center gap-2">
            <button
              type="button"
              aria-label="Drag TypeScript tools notification (double-click to reset position)"
              title="Drag to move · Double-click to reset"
              onPointerDown={(e) => dragControls.start(e)}
              onDoubleClick={resetPosition}
              className="cursor-grab active:cursor-grabbing p-0.5 rounded-xs text-(--color-text-muted) hover:text-(--color-text) hover:bg-(--bg-key)/60 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring)/40"
            >
              <GripVertical className="size-3.5" />
            </button>

            <button
              type="button"
              className="flex items-center gap-1.5 text-xs text-(--color-text) hover:text-(--color-text-2) transition-colors cursor-pointer select-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring)/40 rounded-xs px-1"
              onClick={() => setMinimized(false)}
              title="Click to expand TypeScript tools details"
            >
              {statusIcon(installing, installed, Boolean(error))}
              <span className="font-medium">{minimizedLabel(installing, installed, Boolean(error))}</span>
            </button>

            {!installed && !installing && (
              <Button
                type="button"
                variant="primary"
                size="xs"
                onClick={() => { void install() }}
              >
                {error ? 'Retry' : 'Install'}
              </Button>
            )}
            {installed && (
              <Button type="button" variant="default" size="xs" onClick={close}>
                Close
              </Button>
            )}

            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              onClick={() => setMinimized(false)}
              title="Expand"
              aria-label="Expand"
            >
              <Maximize2 className="size-3.5" />
            </Button>

            {!installed && (
              <Button
                type="button"
                variant="ghost"
                size="xs"
                onClick={close}
                disabled={installing}
                title="Remind me later"
              >
                Later
              </Button>
            )}
          </div>
        ) : (
          <div>
            <div className="flex items-start justify-between gap-3">
              <div className="flex items-start gap-2">
                <button
                  type="button"
                  aria-label="Drag TypeScript tools notification (double-click to reset position)"
                  title="Drag to move · Double-click to reset"
                  onPointerDown={(e) => dragControls.start(e)}
                  onDoubleClick={resetPosition}
                  className="cursor-grab active:cursor-grabbing p-0.5 rounded-xs text-(--color-text-muted) hover:text-(--color-text) hover:bg-(--bg-key)/60 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring)/40 mt-0.5"
                >
                  <GripVertical className="size-3.5" />
                </button>
                <div>
                  <div className="font-medium">Install TypeScript language tools?</div>
                  <div className="mt-1 text-xs text-(--color-text-muted)">
                    TypeScript language tools are needed for this workspace. They will be downloaded and installed on the backend, not on this device.
                  </div>
                </div>
              </div>

              <div className="flex items-center gap-1 shrink-0">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  onClick={() => setMinimized(true)}
                  title="Minimize"
                  aria-label="Minimize"
                >
                  <Minus className="size-3.5" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  onClick={close}
                  disabled={installing}
                  title="Remind me later"
                >
                  Later
                </Button>
              </div>
            </div>

            <div className="mt-3 space-y-1 pl-6 font-mono text-[11px] text-(--color-text-subtle)">
              <p className="break-all">{request.workspace}</p>
              <p>Language server {request.languageServerVersion}, TypeScript {request.typeScriptVersion}</p>
            </div>

            {error && <p role="alert" className="mt-3 pl-6 text-sm text-(--color-error)">{error}</p>}
            {installed && <p role="status" className="mt-3 pl-6 text-sm text-(--color-text-muted)">TypeScript language tools are ready on the backend.</p>}

            <div className="mt-4 flex justify-end gap-2">
              <Button type="button" variant="default" size="sm" onClick={close} disabled={installing}>
                {installed ? 'Close' : 'Not now'}
              </Button>
              {!installed && (
                <Button
                  type="button"
                  variant="primary"
                  size="sm"
                  onClick={() => { void install() }}
                  disabled={installing}
                >
                  {installing ? (
                    <>
                      <Loader2 className="mr-1.5 size-3.5 animate-spin" />
                      Installing…
                    </>
                  ) : error ? (
                    'Try again'
                  ) : (
                    'Install on backend'
                  )}
                </Button>
              )}
            </div>
          </div>
        )}
      </motion.div>
    </aside>
  )
}

function statusIcon(installing: boolean, installed: boolean, hasError: boolean) {
  if (installing) {
    return <Loader2 className="size-3.5 animate-spin text-(--color-text-muted)" />
  }
  if (hasError) {
    return <AlertCircle className="size-3.5 text-(--color-error)" />
  }
  if (installed) {
    return <Check className="size-3.5 text-(--color-accent)" />
  }
  return <Download className="size-3.5 text-(--color-accent)" />
}

function minimizedLabel(installing: boolean, installed: boolean, hasError: boolean): string {
  if (installing) return 'Installing tools…'
  if (hasError) return 'Install failed'
  if (installed) return 'Tools ready'
  return 'TypeScript tools'
}
