import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { OAuthLoginEvent, ProviderInfo } from '@/api/client'
import { OAuthLoginDialog } from '@/components/settings/pages/settings.providers/OAuthLoginDialog'

mock.module('lucide-react', () => new Proxy({}, { get: () => () => null }))

type StreamCallbacks = { onOAuthEvent?: (event: OAuthLoginEvent) => void }
/** Args: providerId, callbacks, signal, mode, credentialId. */
const streams: Array<{ callbacks: StreamCallbacks; signal: AbortSignal }> = []
const mockLoginStream = mock((...args: unknown[]) => {
  streams.push({ callbacks: args[1] as StreamCallbacks, signal: args[2] as AbortSignal })
})
const mockCallback = mock((..._args: unknown[]) => Promise.resolve({ ok: true }))

mock.module('@/api/client', () => ({
  oauthLoginStream: mockLoginStream,
  submitOAuthCallback: mockCallback,
  configureDefaultModel: () => Promise.resolve({ agents_updated: 0 }),
}))

const provider: ProviderInfo = {
  id: 'plug',
  label: 'Plug',
  description: '',
  kind: 'oauth',
  credentials: [],
  saved_credentials: {},
  env_var: '',
  env_vars: [],
  oauth_command: '',
  docs_url: '',
  is_configured: false,
  is_saved: false,
  cached_models: [],
  visible_models: [],
  is_disconnected: false,
  supports_fast_mode: false,
  public_access: false,
}

// One client for the whole file: a new one per render would restart the stream.
const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })

function Harness({ open = true, credentialId, p = provider }: { open?: boolean; credentialId?: string; p?: ProviderInfo }) {
  return (
    <QueryClientProvider client={queryClient}>
      <OAuthLoginDialog provider={p} open={open} onOpenChange={() => undefined} credentialId={credentialId} />
    </QueryClientProvider>
  )
}

function emit(index: number, event: OAuthLoginEvent) {
  act(() => streams[index].callbacks.onOAuthEvent?.(event))
}

async function submitCode(code: string) {
  fireEvent.change(await screen.findByLabelText(/Paste the address or code/), { target: { value: code } })
  fireEvent.click(screen.getByRole('button', { name: 'Finish signing in' }))
}

describe('OAuthLoginDialog — callback account forwarding', () => {
  beforeEach(() => {
    streams.length = 0
    mockLoginStream.mockClear()
    mockCallback.mockClear()
  })
  afterEach(cleanup)

  it('forwards the credential_id carried by the login events', async () => {
    render(<Harness />)
    emit(0, { event: 'started', credential_id: 'cred_new' })
    emit(0, { event: 'code_required', credential_id: 'cred_new' })
    await submitCode('the-code')
    await waitFor(() => expect(mockCallback).toHaveBeenCalledTimes(1))
    expect(mockCallback.mock.calls[0]).toEqual(['plug', 'the-code', 'cred_new'])
  })

  it('falls back to the reconnect target when events carry no credential_id', async () => {
    render(<Harness credentialId="cred_prop" />)
    emit(0, { event: 'code_required' })
    await submitCode('c1')
    await waitFor(() => expect(mockCallback).toHaveBeenCalledTimes(1))
    expect(mockCallback.mock.calls[0]).toEqual(['plug', 'c1', 'cred_prop'])
  })

  it('sends no account for a legacy login that never reports one', async () => {
    render(<Harness />)
    emit(0, { event: 'code_required' })
    await submitCode('c2')
    await waitFor(() => expect(mockCallback).toHaveBeenCalledTimes(1))
    expect(mockCallback.mock.calls[0]).toEqual(['plug', 'c2', undefined])
  })

  it('does not carry an account over to the next login stream', async () => {
    const { rerender } = render(<Harness />)
    emit(0, { event: 'started', credential_id: 'cred_old' })
    rerender(<Harness open={false} />)
    rerender(<Harness open />)
    expect(streams).toHaveLength(2)
    expect(streams[0].signal.aborted).toBe(true)
    // A late event of the aborted stream must not leak into the new one.
    emit(0, { event: 'started', credential_id: 'cred_stale' })
    emit(1, { event: 'code_required' })
    await submitCode('c3')
    await waitFor(() => expect(mockCallback).toHaveBeenCalledTimes(1))
    expect(mockCallback.mock.calls[0]).toEqual(['plug', 'c3', undefined])
  })
})

describe('OAuthLoginDialog: signing in, in the words of the person signing in', () => {
  beforeEach(() => {
    streams.length = 0
    mockLoginStream.mockClear()
  })
  afterEach(cleanup)

  const chatgpt: ProviderInfo = { ...provider, id: 'codex', label: 'ChatGPT' }

  it('is titled by the product, and says what to do with the code', () => {
    render(<Harness p={chatgpt} />)
    emit(0, { event: 'started' })
    emit(0, { event: 'device_code', user_code: 'WDJB-MJHT', verification_uri: 'https://auth.example/device' })

    const dialog = screen.getByRole('dialog', { name: 'Sign in to ChatGPT' })
    expect(dialog.textContent).toContain('Sign in in your browser and enter this code. This window updates when you are done.')
    expect(screen.getByText('Code to enter')).toBeTruthy()
    expect(screen.getByText('WDJB-MJHT')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Copy code' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Open the sign-in page' })).toBeTruthy()
  })

  it('uses none of the protocol’s words outside Technical details', () => {
    render(<Harness p={chatgpt} />)
    emit(0, { event: 'started' })
    emit(0, { event: 'device_code', user_code: 'WDJB-MJHT', verification_uri: 'https://auth.example/device' })
    emit(0, { event: 'polling', elapsed_s: 5 })

    const dialog = screen.getByRole('dialog')
    const details = dialog.querySelector('details')
    expect(details?.querySelector('summary')?.textContent).toContain('Technical details')
    const outside = dialog.cloneNode(true) as HTMLElement
    outside.querySelector('details')?.remove()
    expect(outside.textContent).not.toMatch(/token|device code|authoriz|OAuth|secure login|browser approval|provider/i)
  })

  it('shows one thing to act on while the code waits: no status row above it', () => {
    render(<Harness p={chatgpt} />)
    emit(0, { event: 'started' })
    expect(screen.getByText('Starting…')).toBeTruthy()
    emit(0, { event: 'device_code', user_code: 'WDJB-MJHT', verification_uri: 'https://auth.example/device' })
    expect(screen.queryByText('Starting…')).toBeNull()
    expect(screen.queryByText(/Waiting/)).toBeNull()
    // Once signed in, the row says what happens next.
    emit(0, { event: 'token_acquired' })
    expect(screen.getByText('Signed in. Checking your account…')).toBeTruthy()
  })

  it('says to sign in again for a reconnect, and which account', () => {
    render(<Harness p={chatgpt} credentialId="cred_1" />)
    const dialog = screen.getByRole('dialog', { name: 'Sign in to ChatGPT again' })
    expect(dialog.textContent).toContain('Sign in with the same account. This window updates when you are done.')
  })
})
