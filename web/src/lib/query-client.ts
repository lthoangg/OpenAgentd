import { QueryClient, type NetworkMode } from '@tanstack/react-query'

import { isDesktopShell } from './desktop-shell'

/**
 * The desktop app usually talks to its own backend on localhost, which
 * answers whether or not the machine is online. TanStack Query's default
 * ('online') pauses every query and mutation while the OS reports no
 * network, so the app stalled offline even with its backend running.
 * Browsers and the mobile app talk to a remote server, where pausing
 * offline is right.
 */
function networkMode(): NetworkMode {
  return isDesktopShell() ? 'always' : 'online'
}

export function createQueryClient(): QueryClient {
  const mode = networkMode()
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 1000 * 60 * 5, // 5 minutes
        gcTime: 1000 * 60 * 10, // 10 minutes
        refetchIntervalInBackground: false,
        networkMode: mode,
      },
      mutations: {
        networkMode: mode,
      },
    },
  })
}

export const queryClient = createQueryClient()
