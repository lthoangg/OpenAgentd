import { useEffect, useState } from 'react'
import { Server } from 'lucide-react'
import { AppOverlay } from '@/components/ui/app-overlay'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { SectionCard, SectionCardHeader, SectionCardRows, SectionCardRow, SectionCardBadge } from '@/components/ui/section-card'

import { apiBaseUrl, setApiBaseUrl } from '@/api/base-url'
import { queryClient } from '@/lib/query-client'
import { queryKeys } from '@/queries/keys'
import { getAccessKey, setAccessKey } from '@/api/auth'
import {
  getAppBackendStatus,
  removeAppBackendServer,
  saveAppBackendServer,
  stopBundledAppBackend,
  switchToExternalAppBackend,
  switchToBundledAppBackend,
  type SavedAppServer,
  type AppBackendStatus,
} from '@/lib/app-backend'

const DEFAULT_SERVERS: SavedAppServer[] = [{ base_url: 'http://127.0.0.1:4082', name: 'Local CLI server' }]

interface AppBackendDialogProps {
  /** Whether the connection dialog is visible. */
  open: boolean
  /** Called when the dialog should open or close. */
  onOpenChange: (open: boolean) => void
}

export function AppBackendDialog({ open, onOpenChange }: AppBackendDialogProps) {
  const [status, setStatus] = useState<AppBackendStatus | null>(null)
  const [baseUrl, setBaseUrl] = useState('')
  const [serverName, setServerName] = useState('')
  const [accessKey, setAccessKeyInput] = useState('')
  const [rememberServer, setRememberServer] = useState(true)
  const [serverHealth, setServerHealth] = useState<Record<string, 'checking' | 'online' | 'offline'>>({})
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    let cancelled = false
    void getAppBackendStatus().then((next) => {
      if (cancelled) return
      setStatus(next)
      setBaseUrl('')
      setServerName('')
      setAccessKeyInput('')
      setRememberServer(true)
      const servers = next?.servers ?? DEFAULT_SERVERS
      setServerHealth(Object.fromEntries(servers.map((server) => [normalizeServerBaseUrl(server.base_url), 'checking'])))
      for (const server of servers) {
        const normalized = normalizeServerBaseUrl(server.base_url)
        void pingServer(normalized).then((online) => {
          if (cancelled) return
          setServerHealth((prev) => ({ ...prev, [normalized]: online ? 'online' : 'offline' }))
        })
      }
    })
    return () => { cancelled = true }
  }, [open])



  if (!open) return null

  async function checkExternal(nextBaseUrl = baseUrl, nextName = serverName, persist = rememberServer) {
    const target = normalizeServerBaseUrl(nextBaseUrl)
    const validationError = validateServerUrl(target)
    if (validationError) {
      setError(validationError)
      return
    }
    setPending(true)
    setError(null)
    try {
      const online = await pingServer(target)
      setServerHealth((prev) => ({ ...prev, [target]: online ? 'online' : 'offline' }))
      if (!online) {
        setError(connectionFailureMessage(target))
        return
      }
      const keyForConnect = accessKey.trim() || getAccessKey() || ''
      const authorized = await checkServerAuth(target, keyForConnect)
      if (!authorized) {
        setError('Server is reachable, but the access key is invalid or missing.')
        return
      }
      if (accessKey.trim()) setAccessKey(accessKey)
      const next = await switchToExternalAppBackend(target, nextName, persist)
      setApiBaseUrl(next.base_url)
      await refreshBackendQueries()
      setStatus(next)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setPending(false)
    }
  }

  async function connectBundled() {
    await runConnectionSwitch(() => switchToBundledAppBackend())
  }

  async function stopBundled() {
    await runConnectionSwitch(() => stopBundledAppBackend())
  }

  async function saveServer() {
    const target = normalizeServerBaseUrl(baseUrl)
    const validationError = validateServerUrl(target)
    if (validationError) {
      setError(validationError)
      return
    }
    setPending(true)
    setError(null)
    try {
      const next = await saveAppBackendServer(target, serverName)
      setStatus(next)
      setBaseUrl('')
      setServerName('')
      setServerHealth((prev) => ({ ...prev, [target]: 'checking' }))
      const online = await pingServer(target)
      setServerHealth((prev) => ({ ...prev, [target]: online ? 'online' : 'offline' }))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setPending(false)
    }
  }

  async function removeServer(baseUrl: string) {
    setPending(true)
    setError(null)
    try {
      const next = await removeAppBackendServer(baseUrl)
      if (next.base_url) setApiBaseUrl(next.base_url)
      await refreshBackendQueries()
      setStatus(next)
      setServerHealth((prev) => {
        const { [baseUrl]: _removed, ...rest } = prev
        return rest
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setPending(false)
    }
  }

  async function runConnectionSwitch(action: () => Promise<void>) {
    setPending(true)
    setError(null)
    try {
      await action()
      const next = await getAppBackendStatus()
      if (next?.base_url) {
        setApiBaseUrl(next.base_url)
      }
      await refreshBackendQueries()
      setStatus(next)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setPending(false)
    }
  }

  return (
    <AppOverlay open={open} onClose={() => onOpenChange(false)} label="Backend connection" maxWidth="480px">
      {/* Header / Title Bar */}
      <div className="flex h-11 shrink-0 items-center justify-between border-b border-(--color-border) bg-(--bg-sidebar) px-4 select-none">
        <div className="flex items-center gap-2">
          <Server size={13} className="shrink-0 text-(--color-text-muted)" aria-hidden="true" />
          <h2 className="text-xs font-semibold text-(--color-text)">Backend connection</h2>
        </div>
      </div>

        <div className="relative min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain touch-pan-y px-5 py-4">
          {/* Connected backend status line */}
          <div className="rounded border border-(--color-border) bg-(--bg-card) p-3 font-mono text-[11px] text-(--color-text-muted) flex items-center justify-between select-none">
            <span className="truncate">
              Connected: <span className="text-(--color-text) font-semibold">{status?.base_url || apiBaseUrl().replace(/\/api$/, '')}</span>
            </span>
            <SectionCardBadge>
              {status?.mode === 'external' || status?.external ? 'saved server' : 'builtin sidecar'}
            </SectionCardBadge>
          </div>

          {/* Connection options list */}
          <SectionCard>
            <SectionCardHeader>Connection options</SectionCardHeader>
            <SectionCardRows>
              {status?.supports_bundled !== false ? (
                <SectionCardRow>
                  <button
                    type="button"
                    onClick={() => {}}
                    className="flex min-w-0 flex-1 items-center gap-2 text-left focus:outline-none"
                    disabled={pending}
                  >
                    <ServerStatusDot status={status?.sidecar_running ? 'online' : undefined} />
                    <span className="truncate font-semibold text-(--color-text)">Builtin sidecar</span>
                  </button>
                  {!status?.external ? (
                    <SectionCardBadge>active</SectionCardBadge>
                  ) : null}
                  <div className="flex items-center gap-1.5 shrink-0">
                    {status?.external ? (
                      <Button
                        type="button"
                        variant="subtle"
                        size="xs"
                        onClick={() => { void connectBundled() }}
                        disabled={pending}
                      >
                        connect
                      </Button>
                    ) : null}
                    {status?.sidecar_running ? (
                      <Button
                        type="button"
                        variant="danger-subtle"
                        size="xs"
                        onClick={() => { void stopBundled() }}
                        disabled={pending}
                      >
                        stop
                      </Button>
                    ) : !status?.external ? (
                      <Button
                        type="button"
                        variant="subtle"
                        size="xs"
                        onClick={() => { void connectBundled() }}
                        disabled={pending}
                      >
                        use builtin
                      </Button>
                    ) : null}
                  </div>
                </SectionCardRow>
              ) : null}
              {(status?.servers ?? DEFAULT_SERVERS).map((server) => {
                const normalizedServerUrl = normalizeServerBaseUrl(server.base_url)
                const active = status?.mode === 'external' && normalizeServerBaseUrl(status.base_url) === normalizedServerUrl
                return (
                  <SectionCardRow key={server.base_url}>
                    <button
                      type="button"
                      onClick={() => { setBaseUrl(normalizedServerUrl); setServerName(server.name ?? '') }}
                      className="flex min-w-0 flex-1 items-center gap-2 text-left focus:outline-none"
                      disabled={pending}
                    >
                      <ServerStatusDot status={serverHealth[normalizedServerUrl] ?? serverHealth[server.base_url]} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-semibold text-(--color-text)">{server.name || server.base_url}</span>
                        {server.name ? <span className="block truncate font-mono text-[10px] text-(--color-text-subtle)">{server.base_url}</span> : null}
                      </span>
                    </button>
                    {active ? (
                      <SectionCardBadge>active</SectionCardBadge>
                    ) : null}
                    <div className="flex items-center gap-1.5 shrink-0">
                      <Button
                        type="button"
                        variant="subtle"
                        size="xs"
                        onClick={() => { void checkExternal(normalizedServerUrl, server.name ?? '', true) }}
                        disabled={pending}
                      >
                        connect
                      </Button>
                      <Button
                        type="button"
                        variant="subtle"
                        size="xs"
                        onClick={() => { setBaseUrl(normalizedServerUrl); setServerName(server.name ?? '') }}
                        disabled={pending}
                      >
                        edit
                      </Button>
                      <Button
                        type="button"
                        variant="danger-subtle"
                        size="xs"
                        onClick={() => { void removeServer(server.base_url) }}
                        disabled={pending}
                      >
                        remove
                      </Button>
                    </div>
                  </SectionCardRow>
                )
              })}
            </SectionCardRows>
          </SectionCard>

          {/* Form Configuration panel */}
          <SectionCard>
            <SectionCardHeader>Configure Server</SectionCardHeader>
            <div className="p-3.5 space-y-3.5">
              <div className="grid gap-1.5">
                <label className="text-[10.5px] font-semibold text-(--color-text-muted)" htmlFor="app-backend-url">
                  Server URL
                </label>
                <div className="flex gap-2">
                  <Input
                    id="app-backend-url"
                    value={baseUrl}
                    onChange={(event) => setBaseUrl(event.target.value)}
                    placeholder="http://<backend-host>:4082"
                    className="min-w-0 flex-1 font-mono"
                  />
                  <Button
                    type="button"
                    variant="default"
                    size="sm"
                    onClick={() => void checkExternal()}
                    disabled={pending}
                  >
                    {pending ? 'Connecting…' : 'Connect'}
                  </Button>
                </div>
              </div>

              <label className="flex min-h-11 cursor-pointer select-none items-center gap-2 rounded-sm border border-transparent px-1 text-xs text-(--color-text-muted) transition-colors md:min-h-0">
                <Checkbox
                  checked={rememberServer}
                  onChange={(event) => setRememberServer(event.currentTarget.checked)}
                  className="border-(--color-border) bg-(--bg-card) checked:border-(--color-border-strong) checked:bg-(--bg-key)"
                  checkClassName="peer-checked:text-(--color-text)"
                  disabled={pending}
                />
                <span>Save this server and reconnect to it after reload</span>
              </label>

              <div className="grid gap-1.5">
                <label className="text-[10.5px] font-semibold text-(--color-text-muted)" htmlFor="app-backend-key">
                  Access key
                </label>
                <Input
                  id="app-backend-key"
                  value={accessKey}
                  onChange={(event) => {
                    setAccessKeyInput(event.target.value)
                    setAccessKey(event.target.value)
                  }}
                  placeholder="Required when server was started with --key"
                  type="password"
                />
              </div>

              <div className="grid gap-1.5">
                <label className="text-[10.5px] font-semibold text-(--color-text-muted)" htmlFor="app-backend-name">
                  Server name
                </label>
                <div className="flex gap-2">
                  <Input
                    id="app-backend-name"
                    value={serverName}
                    onChange={(event) => setServerName(event.target.value)}
                    placeholder="Work laptop, Home server, Local CLI"
                    className="min-w-0 flex-1"
                  />
                  <Button
                    type="button"
                    variant="default"
                    size="sm"
                    onClick={() => void saveServer()}
                    disabled={pending}
                  >
                    Save server
                  </Button>
                </div>
              </div>
            </div>
          </SectionCard>

          <p className="text-[10.5px] leading-relaxed text-(--color-text-subtle)">
            Connect verifies and switches to a saved server. Save only stores or renames an entry. Use builtin returns this app to the bundled sidecar. If a LAN server fails, confirm the backend is not bound to localhost only and that firewall/local-network permissions allow access.
          </p>

          {error ? (
            <div className="rounded border border-(--color-error)/25 bg-(--color-error-subtle) px-3.5 py-2.5 text-xs text-(--color-error)" role="alert">
              {error}
            </div>
          ) : null}
        </div>

        <div className="flex flex-wrap justify-end gap-2 border-t border-(--color-border) bg-(--bg-sidebar) px-4 py-3 select-none">
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="rounded border border-(--color-border) bg-(--bg-card) px-3 py-1.5 text-xs font-medium text-(--color-text) hover:bg-(--bg-key)/40 disabled:cursor-not-allowed disabled:opacity-60 focus-visible:outline-none transition-colors"
            disabled={pending}
          >
            Cancel
          </button>
      </div>
    </AppOverlay>
  )
}

async function refreshBackendQueries(): Promise<void> {
  await queryClient.invalidateQueries({ queryKey: queryKeys.health() })
  await queryClient.invalidateQueries({ queryKey: queryKeys.team.status() })
}

function normalizeServerBaseUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, '')
  return trimmed.endsWith('/api') ? trimmed.slice(0, -4) : trimmed
}

function validateServerUrl(value: string): string | null {
  if (!value) return 'Enter a server URL first.'
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return 'Enter a full server URL, including http:// or https://.'
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return `Unsupported URL scheme: ${parsed.protocol.replace(/:$/, '')}`
  }
  return null
}

function connectionFailureMessage(baseUrl: string): string {
  try {
    const host = new URL(baseUrl).hostname
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]') {
      return 'Server did not respond to /api/health/live. Make sure OpenAgentd is running locally and the port is correct.'
    }
  } catch {
    // validateServerUrl already handles malformed URLs.
  }
  return 'Server did not respond to /api/health/live. Check that OpenAgentd is running with --host 0.0.0.0, this device is on the same network, and the URL uses the backend machine LAN IP.'
}

async function checkServerAuth(baseUrl: string, accessKey: string): Promise<boolean> {
  const base = baseUrl.replace(/\/+$/, '')
  const controller = new AbortController()
  const timeout = window.setTimeout(() => controller.abort(), 1500)
  try {
    const headers = accessKey ? { Authorization: `Bearer ${accessKey}` } : undefined
    const res = await fetch(`${base}/api/auth/check`, { cache: 'no-store', headers, signal: controller.signal })
    return res.ok || res.status === 404
  } catch {
    return false
  } finally {
    window.clearTimeout(timeout)
  }
}

async function pingServer(baseUrl: string): Promise<boolean> {
  const base = baseUrl.replace(/\/+$/, '')
  const controller = new AbortController()
  const timeout = window.setTimeout(() => controller.abort(), 1500)
  try {
    const res = await fetch(`${base}/api/health/live`, { cache: 'no-store', signal: controller.signal })
    return res.ok
  } catch {
    return false
  } finally {
    window.clearTimeout(timeout)
  }
}

function ServerStatusDot({ status }: { status: 'checking' | 'online' | 'offline' | undefined }) {
  const className = status === 'online'
    ? 'bg-(--color-success)'
    : status === 'offline'
      ? 'bg-(--color-error)'
      : 'animate-pulse bg-(--color-text-muted)'
  const label = status === 'online' ? 'Online' : status === 'offline' ? 'Offline' : 'Checking'
  return <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${className}`} title={label} aria-label={label} />
}
