import { useEffect, useState } from 'react'
import { Server } from 'lucide-react'

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
    <div
      className="mobile-safe-overlay fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="app-backend-title"
      onClick={() => { if (!pending) onOpenChange(false) }}
    >
      <div
        className="flex max-h-full w-full max-w-md flex-col overflow-hidden rounded-xl border border-(--color-border) bg-(--bg-card) text-(--color-text) shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-start gap-3 border-b border-(--color-border) px-4 py-4">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-(--bg-key) text-(--color-text-muted) ring-1 ring-(--color-border)" aria-hidden="true">
            <Server size={18} />
          </span>
          <div className="min-w-0 flex-1">
            <h2 id="app-backend-title" className="text-sm font-semibold">Backend connection</h2>
            <p className="mt-1 text-xs leading-5 text-(--color-text-muted)">
              Use the builtin sidecar or connect to one of your saved OpenAgentd servers.
            </p>
          </div>
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-4">
          <div className="rounded-md border border-(--color-border) bg-(--bg-page) px-3 py-2 text-xs text-(--color-text-muted)">
            Connected backend: <span className="font-mono text-(--color-text)">{status?.base_url || apiBaseUrl().replace(/\/api$/, '')}</span>
            <span className="ml-2 rounded bg-(--bg-key) px-1.5 py-0.5 text-[10px]">
              {status?.mode === 'external' || status?.external ? 'saved server' : 'builtin sidecar'}
            </span>
          </div>

          <div>
            <div className="mb-2 text-xs font-medium text-(--color-text)">Connection options</div>
            <div className="space-y-1">
              {status?.supports_bundled !== false ? (
                <div className="flex items-center gap-2 rounded-md border border-(--color-border) px-3 py-2 text-xs hover:bg-(--bg-page)">
                  <button
                    type="button"
                    onClick={() => {}}
                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                    disabled={pending}
                  >
                    <ServerStatusDot status={status?.sidecar_running ? 'online' : undefined} />
                    <span className="truncate font-medium">Builtin sidecar</span>
                  </button>
                  {!status?.external ? (
                    <span className="rounded bg-(--bg-key) px-1.5 py-0.5 text-[10px] text-(--color-text-muted)">active</span>
                  ) : null}
                  {status?.sidecar_running ? (
                    <button
                      type="button"
                      onClick={() => { void stopBundled() }}
                      className="rounded bg-(--bg-key) px-1.5 py-0.5 text-[10px] text-(--color-error) hover:bg-(--color-error)/10"
                      disabled={pending}
                    >
                      stop
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => { void connectBundled() }}
                      className="rounded bg-(--bg-key) px-1.5 py-0.5 text-[10px] text-(--color-text-muted) hover:text-(--color-text)"
                      disabled={pending}
                    >
                      use builtin
                    </button>
                  )}
                </div>
              ) : null}
              {(status?.servers ?? DEFAULT_SERVERS).map((server) => {
                const normalizedServerUrl = normalizeServerBaseUrl(server.base_url)
                const active = status?.mode === 'external' && normalizeServerBaseUrl(status.base_url) === normalizedServerUrl
                return (
                <div
                  key={server.base_url}
                  className="flex items-center gap-2 rounded-md border border-(--color-border) px-3 py-2 text-xs hover:bg-(--bg-page)"
                >
                  <button
                    type="button"
                    onClick={() => { setBaseUrl(normalizedServerUrl); setServerName(server.name ?? '') }}
                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                    disabled={pending}
                  >
                    <ServerStatusDot status={serverHealth[normalizedServerUrl] ?? serverHealth[server.base_url]} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">{server.name || server.base_url}</span>
                      {server.name ? <span className="block truncate font-mono text-[10px] text-(--color-text-muted)">{server.base_url}</span> : null}
                    </span>
                  </button>
                  {active ? (
                    <span className="rounded bg-(--bg-key) px-1.5 py-0.5 text-[10px] text-(--color-text-muted)">active</span>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => { void checkExternal(normalizedServerUrl, server.name ?? '', true) }}
                    className="rounded bg-(--bg-key) px-1.5 py-0.5 text-[10px] text-(--color-text-muted) hover:text-(--color-text)"
                    disabled={pending}
                  >
                    connect
                  </button>
                  <button
                    type="button"
                    onClick={() => { setBaseUrl(normalizedServerUrl); setServerName(server.name ?? '') }}
                    className="rounded bg-(--bg-key) px-1.5 py-0.5 text-[10px] text-(--color-text-muted) hover:text-(--color-text)"
                    disabled={pending}
                  >
                    edit
                  </button>
                  <button
                    type="button"
                    onClick={() => { void removeServer(server.base_url) }}
                    className="rounded bg-(--bg-key) px-1.5 py-0.5 text-[10px] text-(--color-error) hover:bg-(--color-error)/10"
                    disabled={pending}
                  >
                    remove
                  </button>
                </div>
              )})}
            </div>
          </div>

          <label className="block text-xs font-medium text-(--color-text)" htmlFor="app-backend-url">
            Server URL
          </label>
          <div className="flex gap-2">
            <input
              id="app-backend-url"
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
              placeholder="http://<backend-host>:4082"
              className="min-w-0 flex-1 rounded-md border border-(--color-border) bg-(--bg-page) px-3 py-2 font-mono text-sm text-(--color-text) outline-none transition-colors placeholder:text-(--color-text-muted) focus:border-(--focus-ring) focus:ring-3 focus:ring-(--focus-ring)/30"
            />
            <button
              type="button"
              onClick={() => void checkExternal()}
              className="rounded-md border border-(--color-border-strong) bg-(--bg-key) px-3 py-2 text-xs font-medium text-(--color-text) hover:bg-(--bg-page) disabled:cursor-not-allowed disabled:opacity-60"
              disabled={pending}
            >
              {pending ? 'Connecting…' : 'Connect'}
            </button>
          </div>
          <label className="flex items-center gap-2 text-xs text-(--color-text-muted)">
            <input
              type="checkbox"
              checked={rememberServer}
              onChange={(event) => setRememberServer(event.target.checked)}
              className="h-3.5 w-3.5 rounded border-(--color-border)"
              disabled={pending}
            />
            Save this server and reconnect to it after reload
          </label>
          <label className="block text-xs font-medium text-(--color-text)" htmlFor="app-backend-key">
            Access key
          </label>
          <input
            id="app-backend-key"
            value={accessKey}
            onChange={(event) => {
              setAccessKeyInput(event.target.value)
              setAccessKey(event.target.value)
            }}
            placeholder="Required when server was started with --key"
            type="password"
            className="w-full rounded-md border border-(--color-border) bg-(--bg-page) px-3 py-2 text-sm text-(--color-text) outline-none transition-colors placeholder:text-(--color-text-muted) focus:border-(--focus-ring) focus:ring-3 focus:ring-(--focus-ring)/30"
          />
          <label className="block text-xs font-medium text-(--color-text)" htmlFor="app-backend-name">
            Server name
          </label>
          <div className="flex gap-2">
            <input
              id="app-backend-name"
              value={serverName}
              onChange={(event) => setServerName(event.target.value)}
              placeholder="Work laptop, Home server, Local CLI"
              className="min-w-0 flex-1 rounded-md border border-(--color-border) bg-(--bg-page) px-3 py-2 text-sm text-(--color-text) outline-none transition-colors placeholder:text-(--color-text-muted) focus:border-(--focus-ring) focus:ring-3 focus:ring-(--focus-ring)/30"
            />
            <button
              type="button"
              onClick={() => void saveServer()}
              className="rounded-md border border-(--color-border-strong) bg-(--bg-key) px-3 py-2 text-xs font-medium text-(--color-text) hover:bg-(--bg-page) disabled:cursor-not-allowed disabled:opacity-60"
              disabled={pending}
            >
              Save server
            </button>
          </div>
          <p className="text-xs leading-5 text-(--color-text-muted)">
            Connect verifies and switches to a saved server. Save only stores or renames an entry. Use builtin returns this app to the bundled sidecar. If a LAN server fails, confirm the backend is not bound to localhost only and that firewall/local-network permissions allow access.
          </p>

          {error ? (
            <div className="rounded-md border border-(--color-error)/40 bg-(--color-error)/10 px-3 py-2 text-xs text-(--color-error)" role="alert">
              {error}
            </div>
          ) : null}
        </div>

        <div className="flex flex-wrap justify-end gap-2 border-t border-(--color-border) px-4 py-3">
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="rounded-md px-3 py-1.5 text-xs font-medium text-(--color-text-muted) hover:bg-(--bg-page)"
            disabled={pending}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
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
