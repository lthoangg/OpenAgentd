/**
 * Requests to show the phone's Servers screen, the one place a phone picks
 * or adds a server. The connection banner, the server chip and a scanned
 * `openagentd://connect` link ask for it here; the cockpit route navigates
 * to /servers, and the screen takes a link's address and key into its add
 * form (nothing connects until Save and use).
 */
import { create } from 'zustand'

import type { AppBackendPrefill } from '@/components/AppBackendPanel'

interface ServersScreenStore {
  /** Counts requests, so asking again while already there still fires. */
  request: number
  /** A connect link's details for the add form, until the screen takes them. */
  prefill: AppBackendPrefill | null
}

export const useServersScreenStore = create<ServersScreenStore>(() => ({ request: 0, prefill: null }))

export function openServersScreen(prefill: AppBackendPrefill | null = null): void {
  useServersScreenStore.setState((state) => ({ request: state.request + 1, prefill }))
}

/** The screen took the prefill into its form. */
export function takeServersPrefill(): AppBackendPrefill | null {
  const { prefill } = useServersScreenStore.getState()
  if (prefill) useServersScreenStore.setState({ prefill: null })
  return prefill
}
