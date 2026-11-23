/** TanStack Query hooks for the sites the agent may use in the Browser tab. */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { getBrowserSites, updateBrowserSites, type BrowserSites } from '@/api/client'
import { queryKeys } from './keys'

export function useBrowserSitesQuery(options?: { enabled?: boolean }) {
  return useQuery({
    queryKey: queryKeys.settings.browserSites(),
    queryFn: getBrowserSites,
    staleTime: 30_000,
    enabled: options?.enabled ?? true,
  })
}

/**
 * Change the rules. The server takes them whole, so the change is applied to
 * a copy read just before: a site another window, or the agent's card, added
 * since this one loaded is not dropped.
 */
export function useChangeBrowserSitesMutation() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: async (change: (rules: BrowserSites) => BrowserSites) => updateBrowserSites(change(await getBrowserSites())),
    onSuccess: (data) => {
      client.setQueryData(queryKeys.settings.browserSites(), data)
    },
  })
}
