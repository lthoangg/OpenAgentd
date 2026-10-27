/**
 * The server switch in progress, if any, for the "Switching to …" screen.
 *
 * Every entry point (Settings → Connection, the connection dialog, the
 * palette's Switch Server…) goes through `lib/backend-switch`, which starts
 * and ends the switch here. A switch to another origin reloads the window,
 * so the target is also handed to the next page load through
 * `sessionStorage`: its loading screen keeps saying where it is going.
 */
import { create } from 'zustand'

export interface BackendSwitchTarget {
  /** The server's name, as the server list shows it. */
  name: string
  /** A second line: the server's address, or what happens while it starts. */
  detail?: string
}

interface BackendSwitchStore {
  target: BackendSwitchTarget | null
}

export const useBackendSwitchStore = create<BackendSwitchStore>(() => ({ target: null }))

const HANDOFF_KEY = 'openagentd.backendSwitch'
/** A handoff older than this is from a switch that never finished loading. */
const HANDOFF_MAX_AGE_MS = 120_000

export function beginBackendSwitch(target: BackendSwitchTarget): void {
  useBackendSwitchStore.setState({ target })
  try {
    window.sessionStorage.setItem(HANDOFF_KEY, JSON.stringify({ ...target, at: Date.now() }))
  } catch {
    // Storage can be unavailable (private mode); the screen still shows until the reload.
  }
}

/** The switch failed, or finished without a reload. */
export function endBackendSwitch(): void {
  useBackendSwitchStore.setState({ target: null })
  clearBackendSwitchHandoff()
}

/** The new server is up: the next load is an ordinary one. */
export function clearBackendSwitchHandoff(): void {
  try {
    window.sessionStorage.removeItem(HANDOFF_KEY)
  } catch {
    // Nothing to clear.
  }
}

/** Where the switch that reloaded this window is going, if it just did. */
export function pendingBackendSwitch(now: number = Date.now()): BackendSwitchTarget | null {
  let raw: string | null = null
  try {
    raw = window.sessionStorage.getItem(HANDOFF_KEY)
  } catch {
    return null
  }
  if (!raw) return null
  try {
    const v = JSON.parse(raw) as { name?: unknown; detail?: unknown; at?: unknown }
    if (typeof v.name !== 'string' || typeof v.at !== 'number' || now - v.at > HANDOFF_MAX_AGE_MS) return null
    return { name: v.name, detail: typeof v.detail === 'string' ? v.detail : undefined }
  } catch {
    return null
  }
}
