/**
 * **Connect your phone** (desktop footer, command palette): one click to the
 * QR code a phone scans to add this computer to the account. It opens
 * Settings → Remote control with a sign-in request, and the Account page signs in
 * (server and client both on) when it sees one while this computer is a
 * guest. The page does the sign-in so its errors and the "only this
 * computer" check show where they always do. Light: no account code here,
 * so the footer stays in the startup bundle's budget.
 */
import { create } from 'zustand'

import { BUILT_IN_NAME_KEY, computerNameKey } from '@/lib/app-backend'
import { isDesktopShell } from '@/lib/desktop-shell'
import { useDesktopCloudStatus } from '@/queries/cloud-light'
import { useBackendStatusQuery } from '@/queries/useHealthQuery'
import { useSettingsStore } from '@/stores/useSettingsStore'

interface ConnectPhoneState {
  /** Requests made; the page signs in for each one it has not handled. */
  requested: number
  handled: number
}

export const useConnectPhoneStore = create<ConnectPhoneState>(() => ({ requested: 0, handled: 0 }))

/**
 * Opens Settings → Remote control; with `signIn` (the default, for a guest) the page
 * starts the sign-in. A sign-in already under way just shows its screen.
 */
export function startConnectPhone({ signIn = true }: { signIn?: boolean } = {}): void {
  if (signIn) useConnectPhoneStore.setState((s) => ({ requested: s.requested + 1 }))
  useSettingsStore.getState().openSettings('remote')
}

/** True once per request: the caller signs in. */
export function consumeConnectPhone(): boolean {
  const { requested, handled } = useConnectPhoneStore.getState()
  if (requested === handled) return false
  useConnectPhoneStore.setState({ handled: requested })
  return true
}

/** The states the footer button is offered in: a guest, or a sign-in to return to. */
export const CONNECT_PHONE_STATES = ['guest', 'signing_in', 'scanned', 'confirming'] as const

/** Whether to offer Connect your phone, and whether it signs in (a guest) or returns to a sign-in. */
export interface ConnectPhoneOffer {
  signIn: boolean
}

/**
 * The offer the footer and the palette share: the desktop app, on its own
 * built-in server (which holds the account), not in an account yet.
 */
export function useConnectPhoneOffer(): ConnectPhoneOffer | null {
  const desktop = isDesktopShell()
  const backend = useBackendStatusQuery()
  const builtIn = desktop && computerNameKey(backend.data ?? null) === BUILT_IN_NAME_KEY
  const state = useDesktopCloudStatus(builtIn).data?.state
  if (!builtIn || !state || !(CONNECT_PHONE_STATES as readonly string[]).includes(state)) return null
  return { signIn: state === 'guest' }
}
