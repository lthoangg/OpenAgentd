import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { Plug, RefreshCw, WifiOff } from 'lucide-react'
import { Wordmark } from '@/components/brand/Logo'
import { ProviderCard, ProviderSkeleton } from './ProviderCard'
import { ServerPicker } from './ServerPicker'
import { TRAY_STATUS_LABEL, providerView, trayStatus } from './providerView'
import { type TrayServerOption, type TrayUsageResult, formatCheckedAt } from './usage'

const USAGE_COMMAND = 'get_tray_usage_summary'
const ACTION_COMMAND = 'tray_action'
const FIT_COMMAND = 'tray_fit'
const TRAY_REFRESH_EVENT = 'tray-popup-refresh'
const PET_SETTINGS_COMMAND = 'pet_settings'
const PET_SETTINGS_EVENT = 'pet-settings-changed'
/** "Checked 2m ago" is re-read this often while the popup is up. */
const CHECKED_TICK_MS = 30_000
/** Stable empty list, so hooks keyed on the servers don't rerun every render. */
const NO_SERVERS: TrayServerOption[] = []

/** Native menu commands (desktop/src-tauri/src/menu.rs), plus the popup's own ``hide``. */
type TrayAction = 'show' | 'settings' | 'quit' | 'usage_manage' | 'toggle_pet' | 'hide'

const ACTIONS: Array<{ action: TrayAction; label: string; keys?: string; key?: string }> = [
  { action: 'show', label: 'Open OpenAgentd' },
  { action: 'settings', label: 'Settings', keys: '⌘,', key: ',' },
  { action: 'quit', label: 'Quit OpenAgentd', keys: '⌘Q', key: 'q' },
]

function runAction(action: TrayAction) {
  void invoke(ACTION_COMMAND, { action })
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Whether the desktop pet is on, as the shell says; null until known. */
function usePetEnabled(): boolean | null {
  const [enabled, setEnabled] = useState<boolean | null>(null)
  useEffect(() => {
    let cancelled = false
    let unlisten: (() => void) | undefined
    void invoke<{ enabled?: unknown } | null>(PET_SETTINGS_COMMAND)
      .then((settings) => {
        if (!cancelled && typeof settings?.enabled === 'boolean') setEnabled(settings.enabled)
      })
      .catch(() => {})
    void listen<{ enabled?: unknown }>(PET_SETTINGS_EVENT, (event) => {
      if (typeof event.payload?.enabled === 'boolean') setEnabled(event.payload.enabled)
    }).then((stop) => {
      if (cancelled) stop()
      else unlisten = stop
    }).catch(() => {})
    return () => {
      cancelled = true
      unlisten?.()
    }
  }, [])
  return enabled
}

export function TrayPopup() {
  const [result, setResult] = useState<TrayUsageResult | null>(null)
  /** The IPC call itself failed (the command answers server errors in ``result.error``). */
  const [loadError, setLoadError] = useState<string | null>(null)
  const [selectedServer, setSelectedServer] = useState('auto')
  const [menuOpen, setMenuOpen] = useState(false)
  const [activeOption, setActiveOption] = useState(0)
  const [refreshing, setRefreshing] = useState(false)
  const [, setClock] = useState(0)
  const rootRef = useRef<HTMLDivElement>(null)
  const petEnabled = usePetEnabled()

  const load = useCallback(async (force = false, targetServer?: string) => {
    try {
      const data = await invoke<TrayUsageResult>(USAGE_COMMAND, { force, targetServer: targetServer ?? selectedServer })
      setResult(data)
      setLoadError(null)
    } catch (err) {
      setLoadError(errorText(err))
    }
  }, [selectedServer])

  useEffect(() => {
    void load()
    // `listen` resolves after an IPC round trip; a cleanup that runs first
    // (unmount, or a server switch changing `load`) must still remove it, or
    // stale listeners keep reloading for the previous server.
    let cancelled = false
    let unlisten: (() => void) | undefined
    void (async () => {
      const stop = await listen(TRAY_REFRESH_EVENT, () => void load())
      if (cancelled) stop()
      else unlisten = stop
    })()
    return () => {
      cancelled = true
      unlisten?.()
    }
  }, [load])

  const refresh = useCallback(() => {
    if (refreshing) return
    setRefreshing(true)
    void load(true).finally(() => setRefreshing(false))
  }, [load, refreshing])

  const servers = result?.servers ?? NO_SERVERS

  const openMenu = useCallback((open: boolean) => {
    if (open) setActiveOption(Math.max(0, servers.findIndex((server) => server.id === selectedServer)))
    setMenuOpen(open)
  }, [selectedServer, servers])

  const chooseServer = useCallback((id: string) => {
    setSelectedServer(id)
    setMenuOpen(false)
    void load(false, id)
  }, [load])

  // The popup owns its keys, so the hints it shows are true wherever focus
  // sits. Claiming a key here also keeps the native menu's accelerator for
  // it from firing a second time.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (menuOpen) {
        const last = servers.length - 1
        const moves: Record<string, number> = {
          ArrowDown: activeOption >= last ? 0 : activeOption + 1,
          ArrowUp: activeOption <= 0 ? last : activeOption - 1,
          Home: 0,
          End: last,
        }
        if (event.key in moves) {
          event.preventDefault()
          setActiveOption(moves[event.key]!)
          return
        }
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          const server = servers[activeOption]
          if (server) chooseServer(server.id)
          return
        }
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        if (menuOpen) setMenuOpen(false)
        else runAction('hide')
        return
      }
      if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return
      const key = event.key.toLowerCase()
      if (key === 'r') {
        event.preventDefault()
        refresh()
        return
      }
      const action = ACTIONS.find((item) => item.key === key)
      if (action) {
        event.preventDefault()
        runAction(action.action)
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [activeOption, chooseServer, menuOpen, refresh, servers])

  // Each show focuses the window: replay the entrance then. Background
  // refreshes while it is up don't focus it, so they don't replay it.
  useEffect(() => {
    const onFocus = () => {
      const root = rootRef.current
      if (!root) return
      root.removeAttribute('data-entering')
      void root.offsetWidth
      root.setAttribute('data-entering', '')
    }
    const onBlur = () => setMenuOpen(false)
    window.addEventListener('focus', onFocus)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('focus', onFocus)
      window.removeEventListener('blur', onBlur)
    }
  }, [])

  useEffect(() => {
    const timer = setInterval(() => setClock((n) => n + 1), CHECKED_TICK_MS)
    return () => clearInterval(timer)
  }, [])

  // The window follows the popup's height (tray_fit clamps and re-anchors
  // it under the tray icon). One call per frame, and only on a change.
  useLayoutEffect(() => {
    const root = rootRef.current
    if (!root || typeof ResizeObserver === 'undefined') return
    let frame = 0
    let sent = 0
    const fit = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const height = Math.ceil(root.getBoundingClientRect().height)
        if (height <= 0 || height === sent) return
        sent = height
        void invoke(FIT_COMMAND, { height }).catch(() => {})
      })
    }
    const observer = new ResizeObserver(fit)
    observer.observe(root)
    fit()
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
    }
  }, [])

  const summary = result?.summary ?? null
  const failed = result?.error ?? loadError
  const status = trayStatus(result, loadError)
  const serverName = result?.server_name ?? 'the server'
  const views = summary?.items.map((item) => providerView(item)) ?? []
  const manage = () => runAction('usage_manage')

  return (
    <div ref={rootRef} className="tray" data-entering="">
      <header className="tray-head">
        <span className="brand">
          <Wordmark height={14} title="OpenAgentd" />
        </span>
        <span className="status" data-tone={status}>{TRAY_STATUS_LABEL[status]}</span>
      </header>

      <div className="toolbar">
        <span className="toolbar-label">Usage</span>
        <span className="toolbar-controls">
          <ServerPicker
            servers={servers}
            selected={selectedServer}
            label={result?.server_name ?? '…'}
            open={menuOpen}
            active={activeOption}
            onOpenChange={openMenu}
            onActiveChange={setActiveOption}
            onChoose={chooseServer}
          />
          <button type="button" className="icon-btn" onClick={refresh} disabled={refreshing} aria-label="Refresh usage" title="Refresh (⌘R)">
            <RefreshCw size={13} strokeWidth={2} className={refreshing ? 'spin' : undefined} aria-hidden="true" />
          </button>
        </span>
      </div>

      {status === 'loading' ? (
        <ProviderSkeleton />
      ) : status === 'offline' ? (
        <div className="blank">
          <WifiOff size={20} strokeWidth={1.8} aria-hidden="true" />
          <p className="blank-title">Can't reach {serverName}</p>
          <p className="blank-text" title={failed ?? undefined}>The server didn't answer. It may be stopped or asleep.</p>
          <button type="button" className="small-btn" onClick={refresh} disabled={refreshing}>Retry</button>
        </div>
      ) : views.length === 0 ? (
        <div className="blank">
          <Plug size={20} strokeWidth={1.8} aria-hidden="true" />
          <p className="blank-title">No providers connected</p>
          <p className="blank-text">Connect a provider to see its limits here.</p>
          <button type="button" className="small-btn" onClick={manage}>Open Providers</button>
        </div>
      ) : (
        <div className="list">
          {views.map((view) => <ProviderCard key={view.key} view={view} onManage={manage} />)}
        </div>
      )}

      {summary && (
        <p className="foot">
          {failed ? (
            <>
              <span title={failed}>Couldn't refresh</span>
              <button type="button" className="link-btn" onClick={refresh} disabled={refreshing}>Retry</button>
            </>
          ) : (
            <span>{formatCheckedAt(summary.checked_at) ?? 'Not checked yet'}</span>
          )}
        </p>
      )}

      <nav className="actions" aria-label="OpenAgentd">
        {ACTIONS.map((item) => (
          <button key={item.action} type="button" className="action" data-primary={item.action === 'show' ? '' : undefined} onClick={() => runAction(item.action)}>
            {item.label}
            {item.keys && <span className="action-keys">{item.keys}</span>}
          </button>
        )).flatMap((button, i) => (i === 0 && petEnabled !== null
          ? [button, (
              <button key="toggle_pet" type="button" className="action" onClick={() => runAction('toggle_pet')}>
                {petEnabled ? 'Hide Desktop Pet' : 'Show Desktop Pet'}
              </button>
            )]
          : [button]))}
      </nav>
    </div>
  )
}
