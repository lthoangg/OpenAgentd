/** Settings → Account: the optional cloud account, guest by default. */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
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
const RECOVERY_URL = 'http://localhost/api/cloud/recovery'
const DEVICES_URL = 'http://localhost/api/cloud/devices'
const PENDING_URL = 'http://localhost/api/cloud/pending'
const BEGIN_URL = 'http://localhost/api/cloud/approve/begin'
const CONFIRM_URL = 'http://localhost/api/cloud/approve/confirm'
const REJECT_URL = 'http://localhost/api/cloud/approve/reject'
const REMOVE_URL = 'http://localhost/api/cloud/devices/remove'
/** Synthetic: not a real account, slot, or secret. */
const INVITE = 'agentd://invite?a=test-account-0000000000&s=test-slot-000000000&k=test-only'

beforeEach(() => {
  server.listen()
  // A connected page lists devices and requests: none unless a test says so.
  server.use(
    http.get(DEVICES_URL, () => HttpResponse.json([])),
    http.get(PENDING_URL, () => HttpResponse.json([])),
  )
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
  it('offers Sign in first, with both roles on, and a link as the alternative, without blocking anything', async () => {
    serveStatus({ state: 'guest', notice: null })
    renderPage()

    expect(await screen.findByText('Reach your computer from anywhere.')).toBeTruthy()
    expect(screen.getByText('Optional. Everything works without an account.')).toBeTruthy()
    expect((screen.getByRole('checkbox', { name: /Use as server/ }) as HTMLInputElement).checked).toBe(true)
    expect((screen.getByRole('checkbox', { name: /Use as client/ }) as HTMLInputElement).checked).toBe(true)
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeTruthy()
    expect(screen.queryByLabelText('Invitation link')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Join with a link instead' }))
    expect(screen.getByLabelText('Invitation link').getAttribute('type')).toBe('password')
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('needs at least one role to sign in', async () => {
    serveStatus({ state: 'guest', notice: null })
    renderPage()

    fireEvent.click(await screen.findByRole('checkbox', { name: /Use as server/ }))
    fireEvent.click(screen.getByRole('checkbox', { name: /Use as client/ }))
    expect(screen.getByText('Choose at least one.')).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Sign in' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('starts sign-in with the chosen roles and shows the code from the response', async () => {
    let sent: unknown = null
    serveStatus({ state: 'guest', notice: null })
    server.use(
      http.post(LOGIN_URL, async ({ request }) => {
        sent = await request.json()
        return HttpResponse.json({
        state: 'signing_in',
        user_code: 'ABCD-EFGH',
        url: 'https://account.openagentd.dev/device',
        fingerprint: 'k7f2 91ab',
        expires_in: 600,
        })
      }),
    )
    renderPage()

    fireEvent.click(await screen.findByRole('checkbox', { name: /Use as client/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Sign in' }))

    expect(await screen.findByText('ABCD-EFGH')).toBeTruthy()
    expect(sent).toEqual({ server: true, client: false })
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
    expect(await screen.findByRole('button', { name: 'Sign in' })).toBeTruthy()
  })

  it('joins with a pasted invitation link and shows what to compare on the phone', async () => {
    let sent: unknown = null
    serveStatus({ state: 'guest', notice: null })
    server.use(http.post(JOIN_URL, async ({ request }) => {
      sent = await request.json()
      return HttpResponse.json({ state: 'invited', fingerprint: '9C02 E1B7', kind: 'linux' })
    }))
    renderPage()

    fireEvent.click(await screen.findByRole('button', { name: 'Join with a link instead' }))
    const field = await screen.findByLabelText('Invitation link')
    fireEvent.change(field, { target: { value: 'https://example.invalid/x' } })
    expect(screen.getByText('That is not an invitation link. Copy it again from your phone.')).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Join' }) as HTMLButtonElement).disabled).toBe(true)

    fireEvent.change(field, { target: { value: `  ${INVITE}  ` } })
    fireEvent.click(screen.getByRole('button', { name: 'Join' }))
    expect(await screen.findByText('Linux · 9C02 E1B7')).toBeTruthy()
    expect(screen.getByText(/Then tap Add\./)).toBeTruthy()
    expect(sent).toEqual({ link: INVITE, server: true, client: true })
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

    expect(await screen.findByText('Approve this computer on a device already in your account: Settings → Account → Pending approvals.')).toBeTruthy()
    expect(screen.getByText('418 207')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy()
  })

  it('omits the code while there is none', async () => {
    serveStatus({ state: 'joining', fingerprint: 'k7f2 91ab', code: null })
    renderPage()

    expect(await screen.findByText(/Approve this computer on a device already in your account/)).toBeTruthy()
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
    ['expired', 'The sign-in code expired.', 'Sign in again'],
    ['empty_account', /This account has no devices yet/, 'Sign in'],
    ['revoked', 'This device was removed from your account.', 'Sign in'],
    ['deleted', 'Account deleted.', 'Sign in'],
    ['denied', 'Sign-in was denied on the account page.', 'Sign in'],
    ['commit_mismatch', 'The request was cancelled: the codes did not match.', 'Sign in'],
    ['join_ended', 'The request to join ended: it was cancelled, expired, or the invitation was used.', 'Sign in'],
    ['confirm_mismatch', /did not match the invitation/, 'Sign in'],
    ['invite_invalid', 'That is not an invitation link. Copy it again from your phone.', 'Sign in'],
    ['signed_out', 'Signed out. Local sessions and settings are unchanged.', 'Sign in'],
    ['failed', /Something went wrong with this computer's account keys/, 'Sign in'],
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

    fireEvent.click(await screen.findByRole('button', { name: 'Sign in' }))

    expect(await screen.findByText(/Manage this computer's account with/)).toBeTruthy()
    expect(screen.getByText('agentd cloud login')).toBeTruthy()
    // The status stays; only the actions go.
    expect(screen.getByText('Reach your computer from anywhere.')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Sign in' })).toBeNull()
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

/** Calls to the desktop app's `cloud_approval_proof`, and what it answers. */
let proofCalls: Array<Record<string, unknown>> = []
let proofAnswer: string | null = 'app-proof'
const realPlatform = Object.getOwnPropertyDescriptor(window.navigator, 'platform')

/** Runs the page as the desktop app on a Mac would. */
function inDesktopApp() {
  ;(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {
    invoke: async (command: string, args: Record<string, unknown>) => {
      if (command !== 'cloud_approval_proof') throw new Error(`unexpected command: ${command}`)
      proofCalls.push(args)
      return proofAnswer
    },
    transformCallback: () => 0,
  }
  Object.defineProperty(window.navigator, 'platform', { value: 'MacIntel', configurable: true })
}

describe('a computer that creates the account or approves devices', () => {
  beforeEach(() => {
    proofCalls = []
    proofAnswer = 'app-proof'
  })

  afterEach(() => {
    delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__
    if (realPlatform) Object.defineProperty(window.navigator, 'platform', realPlatform)
    else delete (window.navigator as unknown as Record<string, unknown>).platform
  })

  it('shows the recovery code once and sends the two groups typed back', async () => {
    let sent: unknown = null
    serveStatus({ state: 'recovery', code: 'AAAA-BBBB-CCCC', check: [1, 3] })
    server.use(http.post(RECOVERY_URL, async ({ request }) => {
      sent = await request.json()
      return HttpResponse.json({ state: 'connected', fingerprint: 'f', signer: true, server: true, client: true, relay: { state: 'connecting' }, sessions: 0 })
    }))
    renderPage()

    expect(await screen.findByText('Save your recovery code.')).toBeTruthy()
    expect(screen.getByText('AAAA BBBB CCCC')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'I saved it' }))
    fireEvent.change(screen.getByLabelText('Type group 1'), { target: { value: 'AAAA' } })
    fireEvent.change(screen.getByLabelText('Type group 3'), { target: { value: 'CCCC' } })
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))
    expect(await screen.findByText('Approves devices')).toBeTruthy()
    expect(sent).toEqual({ first: 'AAAA', second: 'CCCC' })
  })

  it('shows another device that the account is being set up, without the code', async () => {
    serveStatus({ state: 'recovery' })
    renderPage()
    expect(await screen.findByText(/setting up a new account/)).toBeTruthy()
  })

  it('lists the devices with their roles, and the requests waiting', async () => {
    inDesktopApp()
    serveStatus({ state: 'connected', fingerprint: 'AA11 BB22', signer: true, server: true, client: true, relay: { state: 'online' }, sessions: 0 })
    server.use(
      http.get(DEVICES_URL, () => HttpResponse.json([
        { device_id: 'me', fingerprint: 'AA11 BB22', signer: true, server: true, client: true, me: true, kind: 'macos' },
        { device_id: 'ci', fingerprint: 'C1C1 0000', signer: false, server: true, client: false, me: false, kind: 'linux' },
      ])),
      http.get(PENDING_URL, () => HttpResponse.json([
        { enrollment_id: 'enr-1', fingerprint: '9C02 E1B7', country: null, created_at: null, expires_at: null, kind: 'ios', server: false, client: true },
      ])),
    )
    renderPage()

    expect(await screen.findByText('Linux · C1C1 0000')).toBeTruthy()
    expect(screen.getByText('Server')).toBeTruthy()
    expect(screen.getByText('Used as')).toBeTruthy()
    expect(screen.getAllByText('Server and client').length).toBeGreaterThan(0)
    expect(await screen.findByText('Pending approvals')).toBeTruthy()
    expect(screen.getByText('Asks to be: client')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Remove Linux · C1C1 0000' })).toBeTruthy()
  })

  it('approves a request with the code, never adding a role it did not ask for', async () => {
    inDesktopApp()
    let confirmed: unknown = null
    let proof: string | null = null
    serveStatus({ state: 'connected', fingerprint: 'f', signer: true, server: true, client: true, relay: { state: 'online' }, sessions: 0 })
    server.use(
      http.get(PENDING_URL, () => HttpResponse.json([
        { enrollment_id: 'enr-1', fingerprint: '9C02 E1B7', country: null, created_at: null, expires_at: null, kind: 'ios', server: false, client: true },
      ])),
      http.post(BEGIN_URL, () => HttpResponse.json({ code: '418207', server: false, client: true })),
      http.post(CONFIRM_URL, async ({ request }) => {
        confirmed = await request.json()
        proof = request.headers.get('X-Agentd-Approval')
        return HttpResponse.json({ state: 'connected', fingerprint: 'f', signer: true, server: true, client: true, relay: { state: 'online' }, sessions: 0 })
      }),
      http.post(REJECT_URL, () => HttpResponse.json({ state: 'connected', fingerprint: 'f', signer: true, relay: { state: 'online' }, sessions: 0 })),
    )
    renderPage()

    fireEvent.click(await screen.findByRole('button', { name: 'Review' }))
    expect(await screen.findByText('418 207')).toBeTruthy()
    const serverBox = screen.getByRole('checkbox', { name: /Use as server/ }) as HTMLInputElement
    expect(serverBox.checked).toBe(false)
    expect(serverBox.disabled).toBe(true)
    // A device that opens sessions has someone at it: it approves too by default.
    expect((screen.getByRole('checkbox', { name: 'Can approve other devices' }) as HTMLInputElement).checked).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Codes match' }))
    await waitFor(() => expect(confirmed).toEqual({ enrollment_id: 'enr-1', signer: true, server: false, client: true }))
    // The app confirmed with the person, then proved exactly this request.
    expect(proofCalls).toEqual([{ action: 'approve', id: 'enr-1', signer: true, server: false, client: true, reason: 'add a device to your account' }])
    expect(proof).toBe('app-proof')
  })

  it('adds nothing when the person cancels Touch ID', async () => {
    inDesktopApp()
    proofAnswer = null
    let confirmed = false
    serveStatus({ state: 'connected', fingerprint: 'f', signer: true, server: true, client: true, relay: { state: 'online' }, sessions: 0 })
    server.use(
      http.get(PENDING_URL, () => HttpResponse.json([
        { enrollment_id: 'enr-1', fingerprint: '9C02 E1B7', country: null, created_at: null, expires_at: null, kind: 'ios', server: false, client: true },
      ])),
      http.post(BEGIN_URL, () => HttpResponse.json({ code: '418207', server: false, client: true })),
      http.post(CONFIRM_URL, () => {
        confirmed = true
        return HttpResponse.json({})
      }),
      http.post(REJECT_URL, () => HttpResponse.json({ state: 'connected', fingerprint: 'f', signer: true, relay: { state: 'online' }, sessions: 0 })),
    )
    renderPage()

    fireEvent.click(await screen.findByRole('button', { name: 'Review' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Codes match' }))
    expect(await screen.findByText('Not confirmed. Nothing was added.')).toBeTruthy()
    expect(confirmed).toBe(false)
  })

  it('removes a device with the app\'s proof for that device', async () => {
    inDesktopApp()
    let removed: { body: unknown; proof: string | null } | null = null
    serveStatus({ state: 'connected', fingerprint: 'f', signer: true, server: true, client: true, relay: { state: 'online' }, sessions: 0 })
    server.use(
      http.get(DEVICES_URL, () => HttpResponse.json([
        { device_id: 'me', fingerprint: 'AA11 BB22', signer: true, server: true, client: true, me: true, kind: 'macos' },
        { device_id: 'ci', fingerprint: 'C1C1 0000', signer: false, server: true, client: false, me: false, kind: 'linux' },
      ])),
      http.post(REMOVE_URL, async ({ request }) => {
        removed = { body: await request.json(), proof: request.headers.get('X-Agentd-Approval') }
        return HttpResponse.json({ state: 'connected', fingerprint: 'f', signer: true, server: true, client: true, relay: { state: 'online' }, sessions: 0 })
      }),
    )
    renderPage()

    fireEvent.click(await screen.findByRole('button', { name: 'Remove Linux · C1C1 0000' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Remove' }))
    await waitFor(() => expect(removed).toEqual({ body: { device_id: 'ci' }, proof: 'app-proof' }))
    expect(proofCalls).toEqual([{ action: 'remove', id: 'ci', signer: false, server: false, client: false, reason: 'remove a device from your account' }])
  })

  it('in a plain browser, says where to approve instead of offering buttons that would fail', async () => {
    serveStatus({ state: 'connected', fingerprint: 'AA11 BB22', signer: true, server: true, client: true, relay: { state: 'online' }, sessions: 0 })
    server.use(
      http.get(DEVICES_URL, () => HttpResponse.json([
        { device_id: 'me', fingerprint: 'AA11 BB22', signer: true, server: true, client: true, me: true, kind: 'macos' },
        { device_id: 'ci', fingerprint: 'C1C1 0000', signer: false, server: true, client: false, me: false, kind: 'linux' },
      ])),
      http.get(PENDING_URL, () => HttpResponse.json([
        { enrollment_id: 'enr-1', fingerprint: '9C02 E1B7', country: null, created_at: null, expires_at: null, kind: 'ios', server: false, client: true },
      ])),
    )
    renderPage()

    expect(await screen.findByText('Approve in the OpenAgentd app on this computer, or run agentd cloud approve in Terminal.')).toBeTruthy()
    expect(screen.getByText('Remove devices in the OpenAgentd app on this computer.')).toBeTruthy()
    expect(screen.getByText('Asks to be: client')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Review' })).toBeNull()
    expect(screen.queryByRole('button', { name: /^Remove / })).toBeNull()
  })

  it('shows no device list to another device viewing this server', async () => {
    serveStatus({ state: 'connected', fingerprint: 'f', signer: true, server: true, client: true, relay: { state: 'online' }, sessions: 0 })
    server.use(http.get(DEVICES_URL, () => HttpResponse.json(FORBIDDEN, { status: 403 })))
    renderPage()

    expect(await screen.findByText('Approves devices')).toBeTruthy()
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(screen.queryByText('Devices')).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('says when this computer is not used as a server', async () => {
    serveStatus({ state: 'connected', fingerprint: 'f', signer: false, server: false, client: true, relay: { state: 'off' }, sessions: 0 })
    renderPage()
    expect(await screen.findByText(/Not used as a server/)).toBeTruthy()
    expect(screen.getByText('Client')).toBeTruthy()
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
