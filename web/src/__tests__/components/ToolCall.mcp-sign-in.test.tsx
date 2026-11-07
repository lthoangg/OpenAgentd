/**
 * An `mcp` call refused because its server waits on sign-in offers Sign in
 * right under the call (desktop), instead of leaving the user to find
 * Settings → MCP from the agent's sentence.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ServerStatus } from '@/api/client'

let phone = false
mock.module('@/hooks/use-is-phone', () => ({ useIsPhone: () => phone }))
let servers: Partial<ServerStatus>[] = []
const connect = mock((..._args: unknown[]) => {})
mock.module('@/queries/useMcpQuery', () => ({
  useMcpServersQuery: () => ({ data: { servers }, isLoading: false, isError: false, refetch: async () => {} }),
  useConnectMcpOAuthMutation: () => ({ mutate: connect, isPending: false, isError: false }),
  useUpdateMcpServerMutation: () => ({ mutate: () => {}, isPending: false }),
}))

const { ToolCall } = await import('@/components/ToolCall')
const { mcpSignInServer } = await import('@/components/ToolCall/mcpSignIn')
const { useSettingsStore } = await import('@/stores/useSettingsStore')

const REFUSED = "Error: MCP server 'excalidraw' is not ready (needs sign-in: connect it in Settings → MCP)"
const CALL = JSON.stringify({ action: 'call', server: 'excalidraw', tool: 'create_view' })

beforeEach(() => {
  phone = false
  servers = []
  connect.mockClear()
  useSettingsStore.setState({ open: false, section: 'general', selectedName: null })
})
afterEach(cleanup)

describe('mcpSignInServer', () => {
  it('names the server of a call refused for sign-in', () => {
    expect(mcpSignInServer(REFUSED)).toBe('excalidraw')
    expect(mcpSignInServer(`${REFUSED}: token expired`)).toBe('excalidraw')
  })

  it('ignores every other answer', () => {
    expect(mcpSignInServer("Error: MCP server 'docs' is not ready (failed to start): exit 1")).toBeNull()
    expect(mcpSignInServer('1 tool (run one with action=\'call\', server, tool and arguments):')).toBeNull()
    expect(mcpSignInServer(undefined)).toBeNull()
  })
})

describe('a call refused for sign-in', () => {
  it('offers Sign in for a server that signs in from the app', () => {
    servers = [{ name: 'excalidraw', enabled: true, state: 'auth_required', transport: 'http' }]
    render(<ToolCall name="mcp" args={CALL} done result={REFUSED} />)

    fireEvent.click(screen.getByRole('button', { name: 'Sign in to excalidraw' }))

    expect(connect).toHaveBeenCalledWith('excalidraw')
    expect(screen.queryByRole('button', { name: 'Open in Settings' })).toBeNull()
  })

  it('opens the server in Settings when the app cannot sign in to it', () => {
    servers = [{ name: 'excalidraw', enabled: true, state: 'auth_required', transport: 'stdio' }]
    render(<ToolCall name="mcp" args={CALL} done result={REFUSED} />)

    expect(screen.queryByRole('button', { name: 'Sign in to excalidraw' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Open in Settings' }))

    expect(useSettingsStore.getState()).toMatchObject({ open: true, section: 'mcp-edit', selectedName: 'excalidraw' })
  })

  it('says Signed in once the server is ready', () => {
    servers = [{ name: 'excalidraw', enabled: true, state: 'ready', transport: 'http' }]
    render(<ToolCall name="mcp" args={CALL} done result={REFUSED} />)

    expect(screen.getByText('Signed in to excalidraw')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Sign in to excalidraw' })).toBeNull()
  })

  it('adds nothing on the phone', () => {
    phone = true
    servers = [{ name: 'excalidraw', enabled: true, state: 'auth_required', transport: 'http' }]
    render(<ToolCall name="mcp" args={CALL} done result={REFUSED} />)

    expect(screen.queryByRole('button', { name: 'Sign in to excalidraw' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Open in Settings' })).toBeNull()
  })

  it('adds nothing to other mcp answers', () => {
    servers = [{ name: 'docs', enabled: true, state: 'error', transport: 'http' }]
    render(<ToolCall name="mcp" args={CALL} done result="Error: MCP server 'docs' is not ready (failed to start): exit 1" />)

    expect(screen.queryByRole('button', { name: /Sign in/ })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Open in Settings' })).toBeNull()
  })
})
