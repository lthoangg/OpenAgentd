/**
 * The server switch in progress, if any, for the "Switching to …" screen.
 *
 * Every entry point (Settings → Switch computer, the connection dialog, the
 * palette's Switch Server…) goes through `lib/backend-switch`, which starts
 * and ends the switch here. A switch to another origin reloads the window,
 * so the target is also handed to the next page load through
 * `sessionStorage`: its loading screen keeps saying where it is going.
 *
 * Each switch gets a generation. Back (`cancelBackendSwitch`) moves the
 * generation on, so the switch still running finds it is no longer current
 * and stops before its next step; a new switch does the same to the one
 * before it. From the commit point on (`markBackendSwitchCommitting`) a
 * switch can no longer be called back: the screen hides Back.
 */
import { create } from 'zustand'

/** Where the window was before a switch: what the startup screen's Back returns to. */
export type BackendSwitchOrigin =
  | { kind: 'bundled' }
  | { kind: 'server'; baseUrl: string; name: string }
  | { kind: 'computer'; deviceId: string; name: string }

export interface BackendSwitchTarget {
  /** The server's name, as the server list shows it. */
  name: string
  /** A second line: the server's address, or what happens while it starts. */
  detail?: string
}

/** A handoff read after the reload: the target, and where the window came from. */
export interface PendingBackendSwitch extends BackendSwitchTarget {
  from?: BackendSwitchOrigin
}

interface BackendSwitchStore {
  target: BackendSwitchTarget | null
  /** The current switch's generation; moves on with every switch and every Back. */
  generation: number
  /** Past the commit point: Back no longer applies. */
  committing: boolean
}

export const useBackendSwitchStore = create<BackendSwitchStore>(() => ({ target: null, generation: 0, committing: false }))

const HANDOFF_KEY = 'openagentd.backendSwitch'
/** A handoff older than this is from a switch that never finished loading. */
const HANDOFF_MAX_AGE_MS = 120_000

function writeHandoff(value: PendingBackendSwitch): void {
  try {
    window.sessionStorage.setItem(HANDOFF_KEY, JSON.stringify({ ...value, at: Date.now() }))
  } catch {
    // Storage can be unavailable (private mode); the screen still shows until the reload.
  }
}

/** Start a switch (a switch still running is superseded); returns its generation. */
export function beginBackendSwitch(target: BackendSwitchTarget): number {
  const generation = useBackendSwitchStore.getState().generation + 1
  useBackendSwitchStore.setState({ target, generation, committing: false })
  writeHandoff(target)
  return generation
}

/** Whether `generation` is still the switch on screen: no Back, no newer switch. */
export function isCurrentBackendSwitch(generation: number): boolean {
  const state = useBackendSwitchStore.getState()
  return state.generation === generation && state.target !== null
}

/** Whether a switch is under way (the screen is up). */
export function backendSwitchActive(): boolean {
  return useBackendSwitchStore.getState().target !== null
}

/** The switch reached its commit point: Back is hidden from now on. */
export function markBackendSwitchCommitting(generation: number): void {
  if (isCurrentBackendSwitch(generation)) useBackendSwitchStore.setState({ committing: true })
}

/** Remember where the window came from, for the startup screen's Back after the reload. */
export function noteBackendSwitchOrigin(generation: number, from: BackendSwitchOrigin | null): void {
  const { target } = useBackendSwitchStore.getState()
  if (!target || !from || !isCurrentBackendSwitch(generation)) return
  writeHandoff({ ...target, from })
}

/**
 * Back: the switch on screen stops at its next step and the screen goes
 * away at once. Does nothing past the commit point. Returns whether it
 * cancelled.
 */
export function cancelBackendSwitch(): boolean {
  const state = useBackendSwitchStore.getState()
  if (!state.target || state.committing) return false
  useBackendSwitchStore.setState({ target: null, generation: state.generation + 1, committing: false })
  clearBackendSwitchHandoff()
  return true
}

/** The switch failed, or finished without a reload. A switch no longer current leaves the screen alone. */
export function endBackendSwitch(generation: number): void {
  if (useBackendSwitchStore.getState().generation !== generation) return
  useBackendSwitchStore.setState({ target: null, committing: false })
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
export function pendingBackendSwitch(now: number = Date.now()): PendingBackendSwitch | null {
  let raw: string | null = null
  try {
    raw = window.sessionStorage.getItem(HANDOFF_KEY)
  } catch {
    return null
  }
  if (!raw) return null
  try {
    const v = JSON.parse(raw) as { name?: unknown; detail?: unknown; at?: unknown; from?: unknown }
    if (typeof v.name !== 'string' || typeof v.at !== 'number' || now - v.at > HANDOFF_MAX_AGE_MS) return null
    const from = parseOrigin(v.from)
    return { name: v.name, detail: typeof v.detail === 'string' ? v.detail : undefined, ...(from ? { from } : {}) }
  } catch {
    return null
  }
}

function parseOrigin(value: unknown): BackendSwitchOrigin | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  if (v.kind === 'bundled') return { kind: 'bundled' }
  const name = typeof v.name === 'string' ? v.name : ''
  if (v.kind === 'server' && typeof v.baseUrl === 'string' && v.baseUrl) return { kind: 'server', baseUrl: v.baseUrl, name }
  if (v.kind === 'computer' && typeof v.deviceId === 'string' && v.deviceId) return { kind: 'computer', deviceId: v.deviceId, name }
  return null
}
