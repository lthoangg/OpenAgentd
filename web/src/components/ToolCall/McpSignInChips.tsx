/**
 * Under an `mcp` call refused because its server needs sign-in (desktop):
 * Sign in right there for a URL server the app can sign in to, the server's
 * Settings page for any other (an API key, a local server), and a quiet
 * "Signed in" once it is ready. Same rule as the composer's MCP rows
 * (`SessionMcpServers`): sign-in is for an enabled URL server.
 */
import { useIsPhone } from '@/hooks/use-is-phone'
import { useConnectMcpOAuthMutation, useMcpServersQuery } from '@/queries/useMcpQuery'
import { useSettingsStore } from '@/stores/useSettingsStore'
import { TOOL_CHIP_CLASS } from './chipStyles'

export function McpSignInChips({ server }: { server: string }) {
  return useIsPhone() ? null : <SignInChips server={server} />
}

function SignInChips({ server }: { server: string }) {
  const { data } = useMcpServersQuery()
  const connect = useConnectMcpOAuthMutation()
  const openSettings = useSettingsStore((s) => s.openSettings)

  const status = data?.servers.find((s) => s.name === server)
  if (status?.state === 'ready') {
    return <span className="ml-2 text-meta text-(--color-text-muted)">Signed in to {server}</span>
  }
  const canSignIn = Boolean(status?.enabled && status.state === 'auth_required' && (status.transport === 'http' || status.transport === 'sse'))
  return (
    <>
      {canSignIn && (
        <button type="button" className={TOOL_CHIP_CLASS} disabled={connect.isPending} onClick={() => connect.mutate(server)}>
          {connect.isPending ? 'Waiting for the browser…' : `Sign in to ${server}`}
        </button>
      )}
      {(!canSignIn || connect.isError) && (
        <button type="button" className={TOOL_CHIP_CLASS} onClick={() => openSettings('mcp-edit', server)}>
          Open in Settings
        </button>
      )}
      {connect.isError && <span role="status" className="ml-2 text-meta text-(--color-text-muted)">Couldn't sign in</span>}
    </>
  )
}
