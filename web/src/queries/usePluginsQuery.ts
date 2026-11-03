import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import {
  listPlugins,
  reloadPlugins,
  setPluginBundleEnabled,
  type PluginBundle,
  type PluginsResponse,
} from '@/api/client'
import { queryKeys } from './keys'

/** How often to re-read the list while an enabled bundle is still starting. */
export const PLUGINS_PENDING_POLL_MS = 2_000

/**
 * Poll interval for the plugin list: refetch only while an enabled bundle is
 * `pending`, so one just turned on visibly settles into `running` (or `failed`)
 * instead of sitting on `pending` until the page is reopened. Nothing pushes a
 * bundle's state, unlike an MCP server's.
 */
export function pluginsPollInterval(data: PluginsResponse | undefined): number | false {
  const starting = data?.bundles?.some((b) => b.enabled && b.state === 'pending') ?? false
  return starting ? PLUGINS_PENDING_POLL_MS : false
}

/**
 * Plugin status (v3 `api.plugins`). Deliberately not re-exported from the
 * queries barrel: only lazily loaded UI (the Plugins page, the plugin notice)
 * uses it, which keeps it out of the eager bundle.
 */
export function usePluginsQuery(enabled = true, options?: { pollWhilePending?: boolean }) {
  return useQuery({
    queryKey: queryKeys.plugins(),
    queryFn: listPlugins,
    enabled,
    // Single-file plugins load once per server process, and `config_changed`
    // invalidates this entry when plugin files change on disk. A bundle's own
    // changes (turning it on or off, Reload) write the answer in place.
    staleTime: 60_000,
    // Opt-in: only the page that shows live state wants the extra traffic.
    refetchInterval: options?.pollWhilePending
      ? (query) => pluginsPollInterval(query.state.data)
      : undefined,
  })
}

/** The MCP servers and skills a bundle brings come and go with it. */
function invalidateBundleContent(client: QueryClient) {
  void client.invalidateQueries({ queryKey: queryKeys.mcp.all() })
  void client.invalidateQueries({ queryKey: queryKeys.skillFiles.all() })
}

function patchBundle(
  client: QueryClient,
  name: string,
  patch: (bundle: PluginBundle) => PluginBundle,
) {
  client.setQueryData<PluginsResponse>(queryKeys.plugins(), (old) =>
    old?.bundles
      ? { ...old, bundles: old.bundles.map((b) => (b.name === name ? patch(b) : b)) }
      : old,
  )
}

/** Turn a bundle on or off. The switch flips at once; a refused change puts the old list back. */
export function useSetPluginBundleEnabledMutation() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: ({ name, enabled }: { name: string; enabled: boolean }) =>
      setPluginBundleEnabled(name, enabled),
    onMutate: async ({ name, enabled }) => {
      await client.cancelQueries({ queryKey: queryKeys.plugins() })
      const previous = client.getQueryData<PluginsResponse>(queryKeys.plugins())
      patchBundle(client, name, (b) => ({
        ...b,
        enabled,
        // Turning it on starts it; show that rather than its old state.
        state: enabled ? 'pending' : 'disabled',
      }))
      return { previous }
    },
    onError: (_error, _vars, context) => {
      if (context?.previous) client.setQueryData(queryKeys.plugins(), context.previous)
    },
    onSuccess: (bundle, { name }) => {
      patchBundle(client, name, () => bundle)
    },
    // Success or not, read the list again: it is what the server holds.
    onSettled: () => {
      void client.invalidateQueries({ queryKey: queryKeys.plugins() })
      invalidateBundleContent(client)
    },
  })
}

/** Rescan the plugin folders and restart the bundles that changed. Its answer is the new list. */
export function useReloadPluginsMutation() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: reloadPlugins,
    // A list read still in flight would land after the reload with the old one.
    onMutate: () => client.cancelQueries({ queryKey: queryKeys.plugins() }),
    onSuccess: (data) => {
      client.setQueryData(queryKeys.plugins(), data)
      invalidateBundleContent(client)
    },
  })
}
