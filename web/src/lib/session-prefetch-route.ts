/**
 * Entering a session's URL (a reload, the route restored at launch, a link,
 * a tapped notification) starts the requests its open needs before any
 * component mounts and asks for its own.
 *
 * The layout mounts the chat only once it knows the session's folder
 * (`routes/cockpit.tsx`), and the chat is what loads the history. Left to
 * the components, the two requests run one after the other, and both queue
 * behind the sidebar's: two round trips and more to a server that is not on
 * this machine. Here they go out together, first.
 */
import { queryClient } from '@/lib/query-client'
import { prefetchSessionHistory } from '@/lib/session-prefetch'
import { cachedSessionWorkspace, sessionDetailQueryOptions } from '@/queries/session-detail'
import { useAgentStore } from '@/stores/useAgentStore'

export function warmSessionRoute(sessionId: string): void {
  // Already on screen (a draft's first message named it, or the chat kept
  // under the phone's list is pushed again): nothing is about to load.
  if (useAgentStore.getState().sessionId === sessionId) return
  prefetchSessionHistory(sessionId)
  if (!cachedSessionWorkspace(queryClient, sessionId)) void queryClient.prefetchQuery(sessionDetailQueryOptions(sessionId))
}
