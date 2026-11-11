/**
 * Whether an account computer's home network (its saved LAN address) answers
 * while the phone is on its account bridge. The route re-check
 * (`lib/account-route.ts`) sets it when the phone could move back to the LAN
 * but must not (a reply is running, or the composer holds text): the
 * computer's row on the Servers screen then says so and offers "Use home
 * network". Client state only; it starts empty on every launch.
 */
import { create } from 'zustand'

interface AccountRouteStore {
  /** Device ids whose home network is available now. */
  lanAvailable: Record<string, true>
}

export const useAccountRouteStore = create<AccountRouteStore>(() => ({ lanAvailable: {} }))

export function setLanAvailable(deviceId: string, available: boolean): void {
  useAccountRouteStore.setState((state) => {
    if (Boolean(state.lanAvailable[deviceId]) === available) return state
    const next = { ...state.lanAvailable }
    if (available) next[deviceId] = true
    else delete next[deviceId]
    return { lanAvailable: next }
  })
}
