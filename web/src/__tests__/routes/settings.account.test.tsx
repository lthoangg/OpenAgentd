/** Settings → Account: the optional cloud account, guest by default. */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, fireEvent } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { setupServer } from '@/__tests__/msw'
import type { ReactNode } from 'react'

mock.module('@tanstack/react-router', () => ({
  Link: ({ children }: { children: ReactNode }) => children,
}))

mock.module('@/hooks/use-mobile', () => ({
  useIsMobile: () => false,
}))

import { AccountSettingsPage } from '@/components/settings/pages/settings.account'
import type { CloudStatus } from '@/api/cloud'
import { cloudPollInterval } from '@/queries/cloud'

const server = setupServer()
let originalFetch: typeof fetch | undefined

const STATUS_URL = 'http://localhost/api/cloud/status'
const LOGIN_URL = 'http://localhost/api/cloud/login'
const LOGOUT_URL = 'http://localhost/api/cloud/logout'
const CANCEL_URL = 'http://localhost/api/cloud/login/cancel'
const JOIN_URL = 'http://localhost/api/cloud/join'
/** Synthetic: not a real account, slot, or secret. */
const INVITE = 'agentd://invite?a=test-account-0000000000&s=test-slot-000000000&k=test-only'

beforeEach(() => {
  server.listen()
  originalFetch = globalThis.fetch
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    if (typeof input === 'string' && input.startsWith('/')) {
      return originalFetch?.(`http://localhost${input}`, init) ?? Promise.reject(new Error('fetch unavailable'))
    }
    return originalFetch?.(input, init) ?? Promise.reject(new Error('fetch unavailable'))
  }) as typeof fetch
})

afterEach(() => {
  server.resetHandlers()
  if (originalFetch) globalThis.fetch = originalFetch
  originalFetch = undefined
  server.close()
})

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(<QueryClientProvider client={queryClient}><AccountSettingsPage /></QueryClientProvider>)
}

function serveStatus(status: CloudStatus) {
  server.use(http.get(STATUS_URL, () => HttpResponse.json(status)))
}

const FORBIDDEN = { detail: 'Only this computer can change its account.' }

describe('AccountSettingsPage', () => {
  it('offers joining by invitation first, and the code as the fallback, without blocking anything', async () => {
    serveStatus({ state: 'guest', notice: null })
    renderPage()

    expect(await screen.findByText('Reach your computer from anywhere.')).toBeTruthy()
    expect(screen.getByText('Optional. Everything works without an account.')).toBeTruthy()
    expect(screen.getByLabelText('Invitation link').getAttribute('type')).toBe('password')
    expect(screen.getByRole('button', { name: 'Join' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Sign in with a code instead' })).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('starts sign-in and shows the code from the response', async () => {
    serveStatus({ state: 'guest', notice: null })
    server.use(
      http.post(LOGIN_URL, () => HttpResponse.json({
        state: 'signing_in',
        user_code: 'ABCD-EFGH',
        url: 'https://account.openagentd.dev/device',
        fingerprint: 'k7f2 91ab',
        expires_in: 600,
      })),
    )
    renderPage()

    fireEvent.click(await screen.findByRole('button', { name: 'Sign in with a code instead' }))

    expect(await screen.findByText('ABCD-EFGH')).toBeTruthy()
    expect(screen.getByText('account.openagentd.dev/device')).toBeTruthy()
    expect(screen.getByText('k7f2 91ab')).toBeTruthy()
    expect(screen.getByText(/you can finish once you are approved/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy()
    const link = screen.getByRole('link', { name: 'Open page' })
    expect(link.getAttribute('href')).toBe('https://account.openagentd.dev/device')
    expect(link.getAttribute('target')).toBe('_blank')
    expect(link.getAttribute('rel')).toBe('noopener noreferrer')
  })

  it('cancels a sign-in and returns to guest', async () => {
    serveStatus({
      state: 'signing_in', user_code: 'ABCD-EFGH', url: 'https://account.openagentd.dev/device', fingerprint: 'k7f2 91ab', expires_in: 600,
    })
    server.use(http.post(CANCEL_URL, () => HttpResponse.json({ state: 'guest', notice: null })))
    renderPage()

    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }))
    expect(await screen.findByRole('button', { name: 'Sign in with a code instead' })).toBeTruthy()
  })

  it('joins with a pasted invitation link and shows what to compare on the phone', async () => {
    let sent: unknown = null
    serveStatus({ state: 'guest', notice: null })
    server.use(http.post(JOIN_URL, async ({ request }) => {
      sent = await request.json()
      return HttpResponse.json({ state: 'invited', fingerprint: '9C02 E1B7', kind: 'linux' })
    }))
    renderPage()

    const field = await screen.findByLabelText('Invitation link')
    fireEvent.change(field, { target: { value: 'https://example.invalid/x' } })
    expect(screen.getByText('That is not an invitation link. Copy it again from your phone.')).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Join' }) as HTMLButtonElement).disabled).toBe(true)

    fireEvent.change(field, { target: { value: `  ${INVITE}  ` } })
    fireEvent.click(screen.getByRole('button', { name: 'Join' }))
    expect(await screen.findByText('Linux · 9C02 E1B7')).toBeTruthy()
    expect(screen.getByText(/Then tap Add\./)).toBeTruthy()
    expect(sent).toEqual({ link: INVITE })
  })

  it('shows a claimed invitation while the phone decides', async () => {
    serveStatus({ state: 'invited', fingerprint: '9C02 E1B7', kind: null })
    renderPage()
    expect(await screen.findByText('9C02 E1B7')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy()
  })

  it('hides Open page for a url that is not https', async () => {
    serveStatus({ state: 'signing_in', user_code: 'ABCD-EFGH', url: 'http://account.example/device', fingerprint: 'f', expires_in: 600 })
    renderPage()

    expect(await screen.findByText('ABCD-EFGH')).toBeTruthy()
    expect(screen.queryByRole('link', { name: 'Open page' })).toBeNull()
  })

  it('shows the join request and the code to compare', async () => {
    serveStatus({ state: 'joining', fingerprint: 'k7f2 91ab', code: '418207' })
    renderPage()

    expect(await screen.findByText('Approve this computer on your phone: Settings → Account.')).toBeTruthy()
    expect(screen.getByText('418 207')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy()
  })

  it('omits the code while there is none', async () => {
    serveStatus({ state: 'joining', fingerprint: 'k7f2 91ab', code: null })
    renderPage()

    expect(await screen.findByText(/Approve this computer on your phone/)).toBeTruthy()
    expect(screen.queryByText(/Code to compare/)).toBeNull()
  })

  it.each([
    ['online', { state: 'online' }, 'Reachable from your devices through your account'],
    ['connecting', { state: 'connecting' }, 'Connecting…'],
    ['offline', { state: 'offline' }, 'Offline, retrying'],
    ['paused', { state: 'paused', until: null }, "Paused: today's relay allowance is used up"],
  ] as const)('shows a connected account that is %s', async (_name, relay, text) => {
    serveStatus({ state: 'connected', fingerprint: 'k7f2 91ab', signer: true, relay, sessions: 3 })
    renderPage()

    expect(await screen.findByText(text)).toBeTruthy()
    expect(screen.getByText('k7f2 91ab')).toBeTruthy()
    expect(screen.getByText('Approves devices')).toBeTruthy()
    expect(screen.getByText('Remote sessions')).toBeTruthy()
    expect(screen.getByText('3')).toBeTruthy()
  })

  it('says Member for a device that cannot approve others', async () => {
    serveStatus({ state: 'connected', fingerprint: 'f', signer: false, relay: { state: 'online' }, sessions: 0 })
    renderPage()
    expect(await screen.findByText('Member')).toBeTruthy()
  })

  it('asks before signing out, then returns to guest', async () => {
    let posts = 0
    serveStatus({ state: 'connected', fingerprint: 'f', signer: true, relay: { state: 'online' }, sessions: 0 })
    server.use(http.post(LOGOUT_URL, () => {
      posts += 1
      return HttpResponse.json({ state: 'guest', notice: 'signed_out' })
    }))
    renderPage()

    fireEvent.click(await screen.findByRole('button', { name: 'Sign out' }))
    expect(await screen.findByText('Sign out of your account?')).toBeTruthy()
    expect(screen.getByText('This device stops being reachable through your account. Local sessions and settings stay.')).toBeTruthy()
    expect(posts).toBe(0)

    const confirm = screen.getAllByRole('button', { name: 'Sign out' }).at(-1)
    if (!confirm) throw new Error('no confirm button')
    fireEvent.click(confirm)
    expect(await screen.findByText(/Signed out\. Local sessions and settings are unchanged\./)).toBeTruthy()
    expect(posts).toBe(1)
  })

  it('shows the deletion date, and keeps Sign out', async () => {
    serveStatus({ state: 'closing', fingerprint: 'f', deletes_at: Date.UTC(2031, 5, 15, 12) })
    renderPage()

    expect(await screen.findByText(/Account scheduled for deletion on .*2031/)).toBeTruthy()
    expect(screen.getByText(/choose Keep account/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeTruthy()
  })

  it('omits the date when none is known', async () => {
    serveStatus({ state: 'closing', fingerprint: 'f', deletes_at: null })
    renderPage()
    expect(await screen.findByText('Account scheduled for deletion.')).toBeTruthy()
  })

  it('shows an unavailable account without the word deactivated', async () => {
    serveStatus({ state: 'unavailable', fingerprint: 'f' })
    renderPage()

    expect(await screen.findByText('Account unavailable.')).toBeTruthy()
    expect(screen.getByText(/Remote access is paused\. Contact OpenAgentd if this continues/)).toBeTruthy()
    expect(document.body.textContent?.toLowerCase()).not.toContain('deactivated')
  })

  it.each([
    ['expired', 'The sign-in code expired.', 'Sign in with a code again'],
    ['empty_account', /This account has no devices yet/, 'Sign in with a code instead'],
    ['revoked', 'This device was removed from your account.', 'Sign in with a code instead'],
    ['deleted', 'Account deleted.', 'Sign in with a code instead'],
    ['denied', 'Sign-in was denied on the account page.', 'Sign in with a code instead'],
    ['commit_mismatch', 'The request was cancelled: the codes did not match.', 'Sign in with a code instead'],
    ['join_ended', 'The request to join ended: it was cancelled, expired, or the invitation was used.', 'Sign in with a code instead'],
    ['confirm_mismatch', /did not match the invitation/, 'Sign in with a code instead'],
    ['invite_invalid', 'That is not an invitation link. Copy it again from your phone.', 'Sign in with a code instead'],
    ['signed_out', 'Signed out. Local sessions and settings are unchanged.', 'Sign in with a code instead'],
    ['failed', /Something went wrong with this computer's account keys/, 'Sign in with a code instead'],
  ] as const)('shows the %s notice to a guest', async (notice, text, button) => {
    serveStatus({ state: 'guest', notice })
    renderPage()

    expect(await screen.findByText(text)).toBeTruthy()
    expect(screen.getByRole('button', { name: button })).toBeTruthy()
  })

  it('shows the hint and no buttons when this computer cannot change the account', async () => {
    serveStatus({ state: 'guest', notice: null })
    server.use(http.post(LOGIN_URL, () => HttpResponse.json(FORBIDDEN, { status: 403 })))
    renderPage()

    fireEvent.click(await screen.findByRole('button', { name: 'Sign in with a code instead' }))

    expect(await screen.findByText(/Manage this computer's account with/)).toBeTruthy()
    expect(screen.getByText('agentd cloud join')).toBeTruthy()
    // The status stays; only the actions go.
    expect(screen.getByText('Reach your computer from anywhere.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Sign in with a code instead' })).toBeNull()
    expect(screen.queryByLabelText('Invitation link')).toBeNull()
    expect(screen.queryByText(FORBIDDEN.detail)).toBeNull()
  })

  it('keeps a connected status read-only when sign out is forbidden', async () => {
    serveStatus({ state: 'connected', fingerprint: 'f', signer: true, relay: { state: 'online' }, sessions: 1 })
    server.use(http.post(LOGOUT_URL, () => HttpResponse.json(FORBIDDEN, { status: 403 })))
    renderPage()

    fireEvent.click(await screen.findByRole('button', { name: 'Sign out' }))
    const confirm = screen.getAllByRole('button', { name: 'Sign out' }).at(-1)
    if (!confirm) throw new Error('no confirm button')
    fireEvent.click(confirm)

    expect(await screen.findByText(/Manage this computer's account with/)).toBeTruthy()
    expect(screen.getByText('Reachable from your devices through your account')).toBeTruthy()
  })
})

describe('cloudPollInterval', () => {
  const signingIn: CloudStatus = { state: 'signing_in', user_code: 'X', url: 'https://a.b/c', fingerprint: 'f', expires_in: 1 }

  it('polls every 2000 ms only while signing in or joining', () => {
    expect(cloudPollInterval(signingIn)).toBe(2000)
    expect(cloudPollInterval({ state: 'joining', fingerprint: 'f', code: null })).toBe(2000)
    expect(cloudPollInterval({ state: 'invited', fingerprint: 'f', kind: null })).toBe(2000)
  })

  it.each<CloudStatus | undefined>([
    undefined,
    { state: 'guest', notice: null },
    { state: 'connected', fingerprint: 'f', signer: true, relay: { state: 'online' }, sessions: 0 },
    { state: 'closing', fingerprint: 'f', deletes_at: null },
    { state: 'unavailable', fingerprint: 'f' },
  ])('does not poll for %o', (status) => {
    expect(cloudPollInterval(status)).toBe(false)
  })
})
