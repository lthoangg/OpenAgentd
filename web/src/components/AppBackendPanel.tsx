/**
 * AppBackendPanel — choose which OpenAgentd backend this app talks to.
 *
 * One panel, two hosts: Settings → Connection renders it as a page, and
 * `AppBackendDialog` wraps it for the places that need it before or outside
 * Settings (the loading screen, the footer health dot, a scanned connect
 * link). All connection logic lives here; the hosts only provide chrome.
 *
 * Top to bottom: the current connection, the saved servers (builtin sidecar
 * first), the add / edit form with its test-then-save flow, and, in the
 * desktop shell, network access for other devices.
 */
import { useEffect, useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { SectionCard } from '@/components/ui/section-card'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { NetworkAccessCard } from '@/components/NetworkAccessCard'
import { SettingsCallout } from '@/components/settings/SettingsCallout'
import { SettingsField } from '@/components/settings/SettingsField'
import { SettingsSection } from '@/components/settings/SettingsSection'
import { ICON_SIZE_INLINE, ROW_PAD, TEXT } from '@/components/settings/tokens'
import { isDesktopShell } from '@/lib/desktop-shell'
import { checkServerAuth, pingServer } from '@/lib/server-probe'
import { cn } from '@/lib/utils'

import { apiBaseUrl, setApiBaseUrl } from '@/api/base-url'
import { queryClient } from '@/lib/query-client'
import { forgetRouteForBackendSwitch } from '@/lib/route-restore'
import { queryKeys } from '@/queries/keys'
import { getStoredAccessKey, installDesktopAuth, primeStoredAccessKey, setStoredAccessKey } from '@/api/auth'
import {
  getAppBackendStatus,
  removeAppBackendServer,
  stopBundledAppBackend,
  switchToExternalAppBackend,
  switchToBundledAppBackend,
  type SavedAppServer,
  type AppBackendStatus,
} from '@/lib/app-backend'

const DEFAULT_SERVERS: SavedAppServer[] = [{ base_url: 'http://127.0.0.1:4082', name: 'Local CLI server' }]

/** Server details from a scanned `openagentd://connect` link. */
export interface AppBackendPrefill {
  baseUrl: string
  accessKey: string
}

type Health = 'checking' | 'online' | 'offline'

interface AppBackendPanelProps {
  /** Loads status and probes servers when it turns true (dialog open, page shown). */
  active: boolean
  /** Fill the form and test it; the user still confirms with Save & Connect. */
  prefill?: AppBackendPrefill | null
  /**
   * Include desktop network access. The dialog does; Settings has a separate
   * Network access page.
   */
  showNetworkAccess?: boolean
}

export function AppBackendPanel({ active, prefill = null, showNetworkAccess = false }: AppBackendPanelProps) {
  const [status, setStatus] = useState<AppBackendStatus | null>(null)
  const [baseUrl, setBaseUrl] = useState('')
  const [serverName, setServerName] = useState('')
  const [accessKey, setAccessKeyInput] = useState('')
  const [testedBaseUrl, setTestedBaseUrl] = useState<string | null>(null)
  const [serverHealth, setServerHealth] = useState<Record<string, Health>>({})
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [scanned, setScanned] = useState(false)
  /** Label of the saved server loaded into the form, or null for a new one. */
  const [editing, setEditing] = useState<string | null>(null)

  useEffect(() => {
    if (!active) return
    let cancelled = false
    void getAppBackendStatus().then((next) => {
      if (cancelled) return
      setStatus(next)
      setBaseUrl(prefill?.baseUrl ?? '')
      setServerName(prefill ? hostnameOf(prefill.baseUrl) : '')
      setAccessKeyInput(prefill?.accessKey ?? '')
      setScanned(Boolean(prefill))
      setTestedBaseUrl(null)
      setEditing(null)
      const servers = next?.servers ?? DEFAULT_SERVERS
      setServerHealth(Object.fromEntries(servers.map((server) => [normalizeServerBaseUrl(server.base_url), 'checking'])))
      for (const server of servers) {
        const normalized = normalizeServerBaseUrl(server.base_url)
        void pingServer(normalized).then((online) => {
          if (cancelled) return
          setServerHealth((prev) => ({ ...prev, [normalized]: online ? 'online' : 'offline' }))
        })
      }
      if (prefill) void testConnection(prefill.baseUrl, prefill.accessKey)
    })
    return () => { cancelled = true }
  }, [active, prefill])

  async function connectExternal(nextBaseUrl: string, nextName: string, persist: boolean) {
    const target = normalizeServerBaseUrl(nextBaseUrl)
    const validationError = validateServerUrl(target)
    if (validationError) {
      setError(validationError)
      return
    }
    const currentBaseUrl = normalizeServerBaseUrl(status?.base_url || apiBaseUrl().replace(/\/api$/, ''))
    setPending(true)
    setError(null)
    try {
      const online = await pingServer(target)
      setServerHealth((prev) => ({ ...prev, [target]: online ? 'online' : 'offline' }))
      if (!online) {
        setError(connectionFailureMessage(target))
        return
      }
      const keyForConnect = accessKey.trim() || await getStoredAccessKey(target) || ''
      const authorized = await checkServerAuth(target, keyForConnect)
      if (!authorized) {
        setError('Server is reachable, but the access key is invalid or missing.')
        return
      }
      if (accessKey.trim()) await setStoredAccessKey(accessKey, target)
      const next = await switchToExternalAppBackend(target, nextName, persist)
      await primeStoredAccessKey(next.base_url)
      delete window.__OAD_TOKEN__
      setApiBaseUrl(next.base_url)
      installDesktopAuth()
      const nextBaseUrl = normalizeServerBaseUrl(next.base_url)
      const shouldReload = nextBaseUrl !== currentBaseUrl
      await refreshBackendQueries()
      setStatus(next)
      if (shouldReload) {
        forgetRouteForBackendSwitch()
        window.location.reload()
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setPending(false)
    }
  }

  async function testConnection(rawBaseUrl: string = baseUrl, rawAccessKey: string = accessKey) {
    const target = normalizeServerBaseUrl(rawBaseUrl)
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
      const keyForTest = rawAccessKey.trim() || await getStoredAccessKey(target) || ''
      const authorized = await checkServerAuth(target, keyForTest)
      if (!authorized) {
        setError('Server is reachable, but the access key is invalid or missing.')
        return
      }
      if (rawAccessKey.trim()) await setStoredAccessKey(rawAccessKey, target)
      setTestedBaseUrl(target)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setPending(false)
    }
  }

  async function connectBundled() {
    const currentBaseUrl = normalizeServerBaseUrl(status?.base_url || apiBaseUrl().replace(/\/api$/, ''))
    const next = await runConnectionSwitch(() => switchToBundledAppBackend(), true)
    if (next?.base_url && normalizeServerBaseUrl(next.base_url) !== currentBaseUrl) {
      forgetRouteForBackendSwitch()
      window.location.reload()
    }
  }

  async function stopBundled() {
    await runConnectionSwitch(() => stopBundledAppBackend())
  }

  async function saveAndConnect() {
    const target = normalizeServerBaseUrl(baseUrl)
    if (testedBaseUrl !== target) {
      setError('Test the current server URL and access key before saving.')
      return
    }
    await connectExternal(target, serverName, true)
  }

  function editServer(nextBaseUrl: string, nextName: string) {
    setBaseUrl(nextBaseUrl)
    setServerName(nextName)
    setTestedBaseUrl(null)
    setError(null)
    setEditing(nextBaseUrl ? (nextName || nextBaseUrl) : null)
    if (!nextBaseUrl) {
      setAccessKeyInput('')
      return
    }
    void getStoredAccessKey(nextBaseUrl).then((storedKey) => setAccessKeyInput(storedKey ?? ''))
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

  async function runConnectionSwitch(
    action: () => Promise<void>,
    applyAuth = false,
  ): Promise<AppBackendStatus | null> {
    setPending(true)
    setError(null)
    try {
      await action()
      const next = await getAppBackendStatus()
      if (next?.base_url) {
        setApiBaseUrl(next.base_url)
        if (applyAuth) {
          await primeStoredAccessKey(next.base_url)
          installDesktopAuth()
        }
      }
      await refreshBackendQueries()
      setStatus(next)
      return next
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      return null
    } finally {
      setPending(false)
    }
  }

  const servers = status?.servers ?? DEFAULT_SERVERS
  // Browser builds have no shell status and a relative `/api` base: show the page origin.
  const currentUrl = status?.base_url || apiBaseUrl().replace(/\/api$/, '') || window.location.origin
  const onExternal = status?.mode === 'external' || Boolean(status?.external)
  const activeServer = onExternal
    ? servers.find((s) => normalizeServerBaseUrl(s.base_url) === normalizeServerBaseUrl(currentUrl))
    : undefined
  const currentTitle = !status
    ? 'Connected to this server'
    : onExternal
      ? `Connected to ${activeServer?.name || hostnameOf(currentUrl) || 'a saved server'}`
      : 'Connected to the builtin backend'
  const tested = testedBaseUrl !== null && testedBaseUrl === normalizeServerBaseUrl(baseUrl)

  return (
    <div className="space-y-8">
      {/* Current connection */}
      <SectionCard>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-4 sm:px-5">
          <span className="size-2.5 shrink-0 rounded-full bg-(--color-success)" aria-hidden="true" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold text-(--color-text)">{currentTitle}</p>
            <p className={cn('mt-0.5 truncate font-mono', TEXT.hint)}>{currentUrl}</p>
          </div>
          {status ? <Badge>{onExternal ? 'Saved server' : 'Builtin'}</Badge> : null}
        </div>
      </SectionCard>

      {scanned ? (
        <SettingsCallout tone="info" role="status">
          Scanned from another device. Check the server, then Save &amp; Connect.
        </SettingsCallout>
      ) : null}

      {/* Saved servers */}
      <SettingsSection
        title="Servers"
        description="Select a server to edit it below."
        flush
      >
        {status?.supports_bundled !== false ? (
          <ServerRow
            health={status?.sidecar_running ? 'online' : undefined}
            title="Builtin sidecar"
            subtitle="Runs inside this app"
            active={!status?.external}
            onSelect={() => editServer('', '')}
            disabled={pending}
          >
            {status?.sidecar_running ? (
              <>
                {status?.external ? (
                  <Button type="button" variant="subtle" size="sm" onClick={() => { void connectBundled() }} disabled={pending}>
                    Connect
                  </Button>
                ) : null}
                <Button type="button" variant="danger-subtle" size="sm" onClick={() => { void stopBundled() }} disabled={pending}>
                  Stop
                </Button>
              </>
            ) : (
              <Button type="button" variant="subtle" size="sm" onClick={() => { void connectBundled() }} disabled={pending}>
                Use builtin
              </Button>
            )}
          </ServerRow>
        ) : null}
        {servers.map((server) => {
          const normalizedServerUrl = normalizeServerBaseUrl(server.base_url)
          const active = status?.mode === 'external' && normalizeServerBaseUrl(status.base_url) === normalizedServerUrl
          const label = server.name || server.base_url
          return (
            <ServerRow
              key={server.base_url}
              health={serverHealth[normalizedServerUrl] ?? serverHealth[server.base_url]}
              title={label}
              subtitle={server.name ? server.base_url : undefined}
              mono={!server.name}
              active={active}
              onSelect={() => editServer(normalizedServerUrl, server.name ?? '')}
              disabled={pending}
            >
              <Button
                type="button"
                variant="subtle"
                size="sm"
                onClick={() => { void connectExternal(normalizedServerUrl, server.name ?? '', true) }}
                disabled={pending}
              >
                Connect
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => editServer(normalizedServerUrl, server.name ?? '')}
                disabled={pending}
              >
                Edit
              </Button>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      className="text-(--color-text-muted) hover:text-(--color-error)"
                      onClick={() => { void removeServer(server.base_url) }}
                      disabled={pending}
                      aria-label={`Remove ${label}`}
                    >
                      <Trash2 size={ICON_SIZE_INLINE} aria-hidden="true" />
                    </Button>
                  }
                />
                <TooltipContent>Remove</TooltipContent>
              </Tooltip>
            </ServerRow>
          )
        })}
      </SettingsSection>

      {/* Add / edit */}
      <SettingsSection
        title={editing ? `Edit ${editing}` : 'Add a server'}
        description="Test it first; Save & Connect stores the server and switches to it."
        actions={
          editing ? (
            <Button type="button" size="sm" variant="ghost" onClick={() => editServer('', '')} disabled={pending}>
              <Plus size={ICON_SIZE_INLINE} aria-hidden="true" />
              New server
            </Button>
          ) : null
        }
        flush
      >
        <div className="grid gap-y-5 px-4 py-4">
          <SettingsField label="Server URL" htmlFor="app-backend-url">
            <Input
              id="app-backend-url"
              value={baseUrl}
              onChange={(event) => { setBaseUrl(event.target.value); setTestedBaseUrl(null) }}
              placeholder="http://<backend-host>:4082"
              autoComplete="off"
              spellCheck={false}
              className="h-9 font-mono"
            />
          </SettingsField>
          <SettingsField label="Access key" htmlFor="app-backend-key" hint="Needed when the server was started with --key.">
            <Input
              id="app-backend-key"
              value={accessKey}
              onChange={(event) => { setAccessKeyInput(event.target.value); setTestedBaseUrl(null) }}
              placeholder="Leave empty if the server has no key"
              type="password"
              autoComplete="off"
              className="h-9"
            />
          </SettingsField>
          <SettingsField label="Server name" htmlFor="app-backend-name" hint="Optional. Shown in the server list.">
            <Input
              id="app-backend-name"
              value={serverName}
              onChange={(event) => setServerName(event.target.value)}
              placeholder="Work laptop, Home server, Local CLI"
              autoComplete="off"
              className="h-9"
            />
          </SettingsField>
        </div>
        <div className="flex flex-col gap-3 bg-(--bg-key)/20 px-4 py-3 sm:flex-row sm:items-center">
          <div className="min-w-0 flex-1 text-xs leading-relaxed">
            {error ? (
              <p role="alert" className="text-(--color-error)">{error}</p>
            ) : tested ? (
              <p role="status" className="font-medium text-(--color-success)">Connection successful.</p>
            ) : (
              <p className="text-(--color-text-muted)">Not tested yet.</p>
            )}
          </div>
          <div className="flex shrink-0 flex-wrap justify-end gap-2">
            <Button type="button" variant="default" size="sm" onClick={() => void testConnection()} disabled={pending}>
              {pending ? 'Testing…' : 'Test connection'}
            </Button>
            <Button
              type="button"
              variant="primary"
              size="sm"
              onClick={() => void saveAndConnect()}
              disabled={pending || !tested}
            >
              Save & Connect
            </Button>
          </div>
        </div>
      </SettingsSection>

      {showNetworkAccess && isDesktopShell() && status?.supports_bundled !== false ? <NetworkAccessCard /> : null}
    </div>
  )
}

function ServerRow({
  health,
  title,
  subtitle,
  mono = false,
  active,
  onSelect,
  disabled,
  children,
}: {
  health: Health | undefined
  title: string
  subtitle?: string
  /** Title is a URL. */
  mono?: boolean
  active: boolean
  onSelect: () => void
  disabled: boolean
  children: React.ReactNode
}) {
  return (
    <div className={cn('flex min-h-14 flex-col gap-3 sm:flex-row sm:items-center sm:gap-4', ROW_PAD)}>
      <button
        type="button"
        onClick={onSelect}
        disabled={disabled}
        className="flex min-w-0 flex-1 items-center gap-3 rounded-xs text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-(--focus-ring)/40"
      >
        <ServerStatusDot status={health} />
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-2">
            <span className={cn('truncate', TEXT.label, mono && 'font-mono')}>{title}</span>
            {active ? <Badge>Active</Badge> : null}
          </span>
          {subtitle ? (
            <span className={cn('mt-0.5 block truncate', TEXT.hint, subtitle.includes('://') && 'font-mono')}>{subtitle}</span>
          ) : null}
        </span>
      </button>
      <div className="flex shrink-0 flex-wrap items-center gap-1.5 pl-5 sm:pl-0">{children}</div>
    </div>
  )
}

function Badge({ children }: { children: React.ReactNode }) {
  return (
    <span className="shrink-0 rounded-full border border-(--color-border) bg-(--bg-key) px-2 py-0.5 text-[11px] font-medium text-(--color-text-muted) select-none">
      {children}
    </span>
  )
}

async function refreshBackendQueries(): Promise<void> {
  await queryClient.invalidateQueries({ queryKey: queryKeys.health() })
  // ``agents()`` is a prefix of ``agentRegistry(workspace)``, so this covers the
  // shared /agent/agents entry for every workspace after a backend switch.
  await queryClient.invalidateQueries({ queryKey: queryKeys.agents() })
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

function hostnameOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).hostname
  } catch {
    return ''
  }
}

function ServerStatusDot({ status }: { status: Health | undefined }) {
  const className = status === 'online'
    ? 'bg-(--color-success)'
    : status === 'offline'
      ? 'bg-(--color-error)'
      : 'animate-pulse bg-(--color-text-muted)'
  const label = status === 'online' ? 'Online' : status === 'offline' ? 'Offline' : 'Checking'
  return (
    <Tooltip>
      <TooltipTrigger render={<span className={`size-2 shrink-0 rounded-full ${className}`} aria-label={label} />} />
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}
