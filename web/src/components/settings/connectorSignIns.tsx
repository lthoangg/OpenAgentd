/**
 * The connector sign-ins running on Settings → Connectors, by server name.
 *
 * A sign-in can start on a gallery tile (Connect adds the connector, then
 * signs in) and the tile leaves the gallery as soon as the connector exists.
 * Keeping the sign-in here, not in the tile, lets the connector's row in
 * "Your connectors" show that it is waiting and offer Cancel.
 */
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'

import type { ServerStatus } from '@/api/client'
import { signInToMcpServer, SignInCancelled } from '@/lib/mcp-sign-in'
import { queryKeys } from '@/queries/keys'
import { useToastStore } from '@/stores/useToastStore'
import { errorMessage } from '@/utils/errors'

interface SignIns {
  /** A sign-in to this server is open in the browser. */
  waiting: (name: string) => boolean
  /**
   * Get the connector (`ready` adds it), then sign in unless it is ready.
   * `popup` is the window opened on the click (`openSignInWindow()`).
   */
  run: (label: string, popup: Window | null, ready: () => Promise<ServerStatus>) => Promise<void>
  cancel: (name: string) => void
}

const Ctx = createContext<SignIns | null>(null)

export function ConnectorSignInsProvider({ children }: { children: ReactNode }) {
  const client = useQueryClient()
  const push = useToastStore((s) => s.push)
  const controllers = useRef(new Map<string, AbortController>())
  const [names, setNames] = useState<ReadonlySet<string>>(new Set())

  const sync = () => setNames(new Set(controllers.current.keys()))

  const run = useCallback<SignIns['run']>(async (label, popup, ready) => {
    let name: string | null = null
    try {
      const st = await ready()
      if (st.state === 'ready') {
        popup?.close()
        return
      }
      name = st.name
      const ac = new AbortController()
      controllers.current.set(name, ac)
      sync()
      // The connector shows up in "Your connectors" while the sign-in is open.
      void client.invalidateQueries({ queryKey: queryKeys.mcp.all() })
      await signInToMcpServer(name, { popup, signal: ac.signal })
      push({ tone: 'success', title: `Signed in to ${label}` })
    } catch (err) {
      popup?.close()
      if (!(err instanceof SignInCancelled)) push({ tone: 'error', title: `Couldn't connect ${label}`, description: errorMessage(err) })
    } finally {
      if (name) controllers.current.delete(name)
      sync()
      void client.invalidateQueries({ queryKey: queryKeys.mcp.all() })
    }
  }, [client, push])

  const value = useMemo<SignIns>(() => ({
    waiting: (name) => names.has(name),
    run,
    cancel: (name) => controllers.current.get(name)?.abort(),
  }), [names, run])

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

export function useConnectorSignIns(): SignIns {
  const v = useContext(Ctx)
  if (!v) throw new Error('useConnectorSignIns needs a ConnectorSignInsProvider')
  return v
}
