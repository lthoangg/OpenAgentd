import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { Plug, RefreshCw, WifiOff } from 'lucide-react'
import { Wordmark } from '@/components/brand/Logo'
import { PET_SETTINGS_EVENT } from '@/lib/pet-setting'
import { ProviderCard, ProviderSkeleton } from './ProviderCard'
import { ServerPicker } from './ServerPicker'
import { TRAY_STATUS_LABEL, failureReason, providerView, trayStatus } from './providerView'
import { shortcutLabel } from './shortcuts'
import { type TrayServerOption, type TrayUsageResult, formatCheckedAt } from './usage'

const USAGE_COMMAND = 'get_tray_usage_summary'
const ACTION_COMMAND = 'tray_action'
const FIT_COMMAND = 'tray_fit'
const TRAY_REFRESH_EVENT = 'tray-popup-refresh'
const PET_SETTINGS_COMMAND = 'pet_settings'
/** "Checked 2m ago" is re-read this often while the popup is up. */
const CHECKED_TICK_MS = 30_000
/** Stable empty list, so hooks keyed on the servers don't rerun every render. */
const NO_SERVERS: TrayServerOption[] = []
/** The picker's first option: the server the app is on. */
const AUTO_SERVER = 'auto'

/** Native menu commands (desktop/src-tauri/src/menu.rs), plus the popup's own ``hide``. */
type TrayAction = 'show' | 'settings' | 'quit' | 'usage_manage' | 'toggle_pet' | 'hide'

/** The hint under each action is written for the platform: ⌘ on macOS, Ctrl elsewhere. */
const ACTIONS: Array<{ action: TrayAction; label: string; key?: string }> = [
  { action: 'show', label: 'Open OpenAgentd' },
  { action: 'settings', label: 'Settings', key: ',' },
  { action: 'quit', label: 'Quit OpenAgentd', key: 'q' },
]

function runAction(action: TrayAction) {
  void invoke(ACTION_COMMAND, { action })
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** What the popup calls a picker option: Auto goes by the server it stands for. */
function optionName(option: TrayServerOption): string {
  return option.id === AUTO_SERVER ? option.detail ?? option.name : option.name
}

/** Listen to a shell event; the cleanup also works if it runs before `listen` resolves. */
function useShellEvent(event: string, onEvent: () => void) {
  useEffect(() => {
    let cancelled = false
    let unlisten: (() => void) | undefined
    void (async () => {
      const stop = await listen(event, onEvent)
      if (cancelled) stop()
      else unlisten = stop
    })()
    return () => {
      cancelled = true
      unlisten?.()
    }
  }, [event, onEvent])
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
  const [selectedServer, setSelectedServer] = useState(AUTO_SERVER)
  /**
   * The name of a server just picked, until its reading arrives. Meanwhile
   * the popup shows placeholders under it: never the last server's numbers.
   */
  const [switchingTo, setSwitchingTo] = useState<string | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [activeOption, setActiveOption] = useState(0)
  const [refreshing, setRefreshing] = useState(false)
  const [, setClock] = useState(0)
  const rootRef = useRef<HTMLDivElement>(null)
  /** The server to read, for `load`, which must not change with it (one read per pick). */
  const selectedRef = useRef(AUTO_SERVER)
  /** The newest request; an answer to an older one is dropped. */
  const requestRef = useRef(0)
  /** `switchingTo`, for `load`. */
  const switchRef = useRef<string | null>(null)
  const petEnabled = usePetEnabled()

  const load = useCallback(async (force = false) => {
    const request = ++requestRef.current
    const targetServer = selectedRef.current
    try {
      const data = await invoke<TrayUsageResult>(USAGE_COMMAND, { force, targetServer })
      if (request !== requestRef.current) return
      setResult(data)
      setLoadError(null)
      // The shell reads Auto instead when the picked server is gone.
      if (data.selected_server_id && data.selected_server_id !== targetServer) {
        selectedRef.current = data.selected_server_id
        setSelectedServer(data.selected_server_id)
      }
    } catch (err) {
      if (request !== requestRef.current) return
      const reason = errorText(err)
      const name = switchRef.current
      // Nothing was read from the picked server: say so under its name,
      // with nothing left of the last one's reading.
      if (name !== null) {
        setResult((last) => last && {
          ...last,
          summary: null,
          error: reason,
          server_name: name,
          server_id: targetServer === AUTO_SERVER ? last.server_id : targetServer,
        })
      }
      setLoadError(reason)
    }
    switchRef.current = null
    setSwitchingTo(null)
  }, [])

  useEffect(() => {
    void load()
  }, [load])
  const reload = useCallback(() => void load(), [load])
  useShellEvent(TRAY_REFRESH_EVENT, reload)

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
    setMenuOpen(false)
    if (id === selectedRef.current) return
    const option = servers.find((server) => server.id === id)
    selectedRef.current = id
    setSelectedServer(id)
    switchRef.current = option ? optionName(option) : '…'
    setSwitchingTo(switchRef.current)
    setLoadError(null)
    void load()
  }, [load, servers])

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

  // The "Checked 2m ago" clock, only while the popup is up: the webview
  // lives as long as the app and is hidden nearly all of that. A show
  // focuses the window and a hide follows its blur.
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | undefined
    const tick = () => setClock((n) => n + 1)
    const stop = () => {
      clearInterval(timer)
      timer = undefined
    }
    const start = () => {
      stop()
      // Right away too: the age shown is from when the popup was last up.
      tick()
      timer = setInterval(tick, CHECKED_TICK_MS)
    }
    if (document.hasFocus()) start()
    window.addEventListener('focus', start)
    window.addEventListener('blur', stop)
    return () => {
      stop()
      window.removeEventListener('focus', start)
      window.removeEventListener('blur', stop)
    }
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

  const summary = switchingTo === null ? result?.summary ?? null : null
  const failed = switchingTo === null ? result?.error ?? loadError : null
  const status = switchingTo === null ? trayStatus(result, loadError) : 'loading'
  const noServer = status === 'no-server'
  const serverLabel = switchingTo ?? result?.server_name
  const serverName = serverLabel ?? 'the server'
  const views = summary?.items.map((item) => providerView(item)) ?? []
  /** "checked 2m ago", for the middle of a line. */
  const checkedAge = summary ? formatCheckedAt(summary.checked_at)?.replace(/^C/, 'c') : null
  const manage = () => runAction('usage_manage')

  return (
    <div ref={rootRef} className="tray" data-entering="">
      <header className="tray-head">
        <span className="brand">
          <Wordmark height={14} title="OpenAgentd" />
        </span>
        {!noServer && serverLabel && <span className="head-server">{serverLabel}</span>}
      </header>

      {noServer ? (
        <div className="blank">
          <WifiOff size={20} strokeWidth={1.8} aria-hidden="true" />
          <p className="blank-title">{TRAY_STATUS_LABEL['no-server']}</p>
          <p className="blank-text">Open OpenAgentd to start the built-in server or connect to one.</p>
          <span className="blank-actions">
            <button type="button" className="small-btn" data-primary="" onClick={() => runAction('show')}>Open OpenAgentd</button>
            <button type="button" className="small-btn" onClick={() => runAction('settings')}>Settings</button>
          </span>
        </div>
      ) : (
        <>
          <div className="toolbar">
            <span className="toolbar-label">Provider limits</span>
            <span className="status" data-tone={status}>{TRAY_STATUS_LABEL[status]}</span>
            <span className="toolbar-controls">
              <ServerPicker
                servers={servers}
                selected={selectedServer}
                label={serverLabel ?? '…'}
                open={menuOpen}
                active={activeOption}
                onOpenChange={openMenu}
                onActiveChange={setActiveOption}
                onChoose={chooseServer}
              />
              <button type="button" className="icon-btn" onClick={refresh} disabled={refreshing} aria-label="Refresh provider limits" aria-keyshortcuts="Meta+R Control+R">
                <RefreshCw size={14} strokeWidth={2} className={refreshing ? 'spin' : undefined} aria-hidden="true" />
              </button>
            </span>
          </div>

          {status === 'loading' ? (
            <ProviderSkeleton />
          ) : status === 'offline' ? (
            <div className="blank">
              <WifiOff size={20} strokeWidth={1.8} aria-hidden="true" />
              <p className="blank-title">Can't reach {serverName}</p>
              <p className="blank-text">{failureReason(failed)}</p>
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

          {summary && (failed ? (
            <div className="callout" role="alert">
              <span className="callout-text">
                {/* The numbers above are the last reading: say how old. */}
                <span>
                  <strong>Couldn't refresh</strong>
                  {checkedAge && <span className="callout-age"> · {checkedAge}</span>}
                </span>
                <span>{failureReason(failed)}</span>
              </span>
              <button type="button" className="small-btn" onClick={refresh} disabled={refreshing}>Retry</button>
            </div>
          ) : (
            <p className="foot">{formatCheckedAt(summary.checked_at) ?? 'Not checked yet'}</p>
          ))}
        </>
      )}

      <nav className="actions" aria-label="OpenAgentd">
        {ACTIONS.map((item) => (
          <button key={item.action} type="button" className="action" data-primary={item.action === 'show' ? '' : undefined} onClick={() => runAction(item.action)}>
            {item.label}
            {item.key && <span className="action-keys">{shortcutLabel(item.key)}</span>}
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
