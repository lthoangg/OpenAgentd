/**
 * The phone's account: the onboarding card and merged computers on the
 * Servers screen, and the Account page with its recovery and approval flows.
 * The shell's commands are faked at `invoke`; a guest is never blocked.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'

const realPlatform = await import('@/hooks/use-platform')
const phone = { isTauri: true, os: 'ios', isMacOverlay: false, isFullscreen: false }
mock.module('@/hooks/use-platform', () => ({ ...realPlatform, getPlatform: () => phone, usePlatform: () => phone }))

type Handler = (args?: Record<string, unknown>) => unknown
let handlers: Record<string, Handler> = {}
let calls: Array<{ command: string; args?: Record<string, unknown> }> = []

mock.module('@tauri-apps/api/core', () => ({
  invoke: async (command: string, args?: Record<string, unknown>) => {
    calls.push({ command, args })
    const handler = handlers[command]
    if (!handler) throw new Error(`unexpected command: ${command}`)
    return handler(args)
  },
}))

const { ServersScreen } = await import('@/components/phone/ServersScreen')
const { PhoneAccountContent } = await import('@/components/settings/pages/settings.account.phone')
const { queryClient } = await import('@/lib/query-client')
const { resetPhoneCloudPush, phoneCloudPollInterval } = await import('@/queries/phone-cloud')
const { rememberLanFingerprint, parseLanComputers } = await import('@/lib/computer-fingerprints')

import type { DeviceRow, PendingRow, PhoneCloudStatus } from '@/api/phone-cloud'
import type { ApprovalView } from '@/api/cloud'

const CURRENT = 'http://127.0.0.1:5999'
const LAN = 'http://192.168.1.20:4082'
const appStatus = {
  base_url: CURRENT,
  mode: 'external',
  sidecar_running: false,
  external: true,
  supports_bundled: false,
  servers: [
    { base_url: CURRENT, name: 'Home Mac' },
    { base_url: LAN, name: 'Studio Mac' },
  ],
}

const CONNECTED: PhoneCloudStatus = { state: 'connected', fingerprint: 'AA11 BB22', signer: true }
const ME: DeviceRow = { device_id: 'dev-me', fingerprint: 'AA11 BB22', signer: true, me: true, kind: 'ios' }
const MAC: DeviceRow = { device_id: 'dev-mac', fingerprint: '3F9A 21C4', signer: false, me: false, kind: 'macos' }

let status: PhoneCloudStatus

/** The shell, answering with `status`; `extra` adds or replaces commands. */
function shell(initial: PhoneCloudStatus, extra: Record<string, Handler> = {}) {
  status = initial
  handlers = {
    cloud_status: () => status,
    cloud_push_register: () => ({}),
    cloud_devices: () => [ME],
    cloud_pending: () => [],
    app_backend_status: () => appStatus,
    app_server_watch_states: () => ({}),
    secure_get_access_key: () => null,
    ...extra,
  }
}

const originalFetch = globalThis.fetch

beforeEach(() => {
  calls = []
  window.localStorage.clear()
  resetPhoneCloudPush()
  queryClient.setDefaultOptions({ ...queryClient.getDefaultOptions(), queries: { ...queryClient.getDefaultOptions().queries, retry: false } })
  window.__OAD_API_BASE_URL__ = CURRENT
  globalThis.fetch = mock(async () => new Response(null, { status: 204 })) as unknown as typeof fetch
})

afterEach(() => {
  cleanup()
  queryClient.clear()
  globalThis.fetch = originalFetch
  delete window.__OAD_API_BASE_URL__
})

const ran = (command: string) => calls.filter((call) => call.command === command)

describe('onboarding card', () => {
  it('offers a guest the account, optionally, and "Not now" hides it for good', async () => {
    shell({ state: 'guest', notice: null, supported: true })
    const first = render(<ServersScreen active onOpenSessions={() => {}} />)

    expect(await screen.findByText('Reach your computer from anywhere.')).toBeTruthy()
    expect(screen.getByText(/It's optional: everything else works without an account\./)).toBeTruthy()
    // The servers list is untouched, so nothing waits on the account.
    expect(await screen.findByText('Home Mac')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Not now' }))
    expect(screen.queryByText('Reach your computer from anywhere.')).toBeNull()
    first.unmount()

    render(<ServersScreen active onOpenSessions={() => {}} />)
    await screen.findByText('Home Mac')
    await waitFor(() => expect(ran('cloud_status').length).toBeGreaterThan(1))
    expect(screen.queryByText('Reach your computer from anywhere.')).toBeNull()
  })

  it('shows nothing where accounts are not supported', async () => {
    shell({ state: 'guest', notice: null, supported: false })
    render(<ServersScreen active onOpenSessions={() => {}} />)

    await screen.findByText('Home Mac')
    await waitFor(() => expect(ran('cloud_status').length).toBe(1))
    expect(screen.queryByText('Reach your computer from anywhere.')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Sign in' })).toBeNull()
  })

  it('signs in and opens the Account sheet on the sign-in code', async () => {
    const signingIn: PhoneCloudStatus = {
      state: 'signing_in', user_code: 'WXYZ-1234', url: 'https://account.openagentd.dev/device', fingerprint: 'AA11 BB22', expires_in: 600,
    }
    shell({ state: 'guest', notice: null, supported: true }, {
      cloud_sign_in: () => { status = signingIn; return signingIn },
    })
    render(<ServersScreen active onOpenSessions={() => {}} />)

    fireEvent.click(await screen.findByRole('button', { name: 'Sign in' }))

    const sheet = await screen.findByRole('dialog', { name: 'Account' })
    expect(await within(sheet).findByText('WXYZ-1234')).toBeTruthy()
    expect(ran('cloud_sign_in')).toHaveLength(1)
  })
})

describe('computers on the Servers screen', () => {
  it('shows a saved LAN server that is an account computer once, "via LAN", and opens it by its address', async () => {
    window.localStorage.setItem('openagentd.cloud.lanComputers', JSON.stringify({ '3F9A21C4': LAN }))
    shell(CONNECTED, {
      cloud_devices: () => [ME, MAC],
      cloud_open_computer: () => ({ status: appStatus, via: 'lan' }),
    })
    render(<ServersScreen active onOpenSessions={() => {}} />)

    expect(await screen.findByText('macOS · 3F9A 21C4')).toBeTruthy()
    expect(screen.getByText('via LAN')).toBeTruthy()
    // One row for the computer: the saved server is not listed again.
    expect(screen.queryByText('Studio Mac')).toBeNull()
    expect(screen.getByText('Home Mac')).toBeTruthy()
    // This phone is not a computer.
    expect(screen.queryByText(/iOS · AA11 BB22/)).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Use macOS · 3F9A 21C4' }))
    await waitFor(() => expect(ran('cloud_open_computer')).toHaveLength(1))
    expect(ran('cloud_open_computer')[0].args).toEqual({ deviceId: 'dev-mac', lanBaseUrl: LAN })
    expect(await screen.findByText('Opened over your network.')).toBeTruthy()
  })

  it('opens a computer with no known LAN address through the account', async () => {
    shell(CONNECTED, {
      cloud_devices: () => [ME, MAC, { device_id: 'dev-phone', fingerprint: 'D00D 0001', signer: false, me: false, kind: 'android' }],
      cloud_open_computer: () => ({ status: appStatus, via: 'account' }),
    })
    render(<ServersScreen active onOpenSessions={() => {}} />)

    expect(await screen.findByText('macOS · 3F9A 21C4')).toBeTruthy()
    expect(screen.getByText('via account')).toBeTruthy()
    expect(screen.queryByText(/Android/)).toBeNull()
    // Not the same computer as any saved server, so both stay listed.
    expect(screen.getByText('Studio Mac')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Use macOS · 3F9A 21C4' }))
    await waitFor(() => expect(ran('cloud_open_computer')).toHaveLength(1))
    expect(ran('cloud_open_computer')[0].args).toEqual({ deviceId: 'dev-mac', lanBaseUrl: null })
    expect(await screen.findByText('Opened through your account.')).toBeTruthy()
  })

  it('shows what the shell says when a computer cannot be opened', async () => {
    shell(CONNECTED, {
      cloud_devices: () => [ME, MAC],
      cloud_open_computer: () => { throw new Error('That computer is offline.') },
    })
    render(<ServersScreen active onOpenSessions={() => {}} />)

    fireEvent.click(await screen.findByRole('button', { name: 'Use macOS · 3F9A 21C4' }))
    expect((await screen.findByRole('alert')).textContent).toContain('That computer is offline.')
  })

  it('remembers which server a fingerprint belongs to', async () => {
    shell(CONNECTED)
    globalThis.fetch = mock(async (input: unknown) => {
      expect(String(input)).toBe(`${LAN}/api/cloud/status`)
      return Response.json({ state: 'connected', fingerprint: '3f9a 21c4' })
    }) as unknown as typeof fetch

    await rememberLanFingerprint(`${LAN}/`)
    expect(parseLanComputers(window.localStorage.getItem('openagentd.cloud.lanComputers') ?? '')).toEqual({ '3F9A21C4': LAN })
  })

  it('ignores a server that has no account route', async () => {
    shell(CONNECTED)
    globalThis.fetch = mock(async () => new Response('{}', { status: 404 })) as unknown as typeof fetch
    await rememberLanFingerprint(LAN)
    expect(window.localStorage.getItem('openagentd.cloud.lanComputers')).toBeNull()
  })
})

describe('Account page', () => {
  it('offers a guest Sign in and explains a notice', async () => {
    shell({ state: 'guest', notice: 'revoked', supported: true })
    render(<PhoneAccountContent />)

    expect(await screen.findByText('This device was removed from your account.')).toBeTruthy()
    expect(screen.getByText('Reach your computer from anywhere.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeTruthy()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('signs a phone in as a client only: Use as server shows, disabled', async () => {
    shell({ state: 'guest', notice: null, supported: true })
    render(<PhoneAccountContent />)
    const server = await screen.findByRole('checkbox', { name: /Use as server/ })
    expect((server as HTMLInputElement).disabled).toBe(true)
    expect((server as HTMLInputElement).checked).toBe(false)
    expect((screen.getByRole('checkbox', { name: /Use as client/ }) as HTMLInputElement).checked).toBe(true)
  })

  it('has no account UI where accounts are not supported', async () => {
    shell({ state: 'guest', notice: null, supported: false })
    render(<PhoneAccountContent />)

    await waitFor(() => expect(ran('cloud_status')).toHaveLength(1))
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.queryByText('Reach your computer from anywhere.')).toBeNull()
  })

  it('shows the sign-in code, opens the page only for https, and cancels', async () => {
    shell({ state: 'signing_in', user_code: 'WXYZ-1234', url: 'https://account.openagentd.dev/device', fingerprint: 'AA11 BB22', expires_in: 600 }, {
      cloud_cancel: () => { status = { state: 'guest', notice: null, supported: true }; return status },
    })
    render(<PhoneAccountContent />)

    expect(await screen.findByText('account.openagentd.dev/device')).toBeTruthy()
    expect(screen.getByText('WXYZ-1234')).toBeTruthy()
    expect(screen.getByText('AA11 BB22')).toBeTruthy()
    expect(screen.getByText(/you can finish once you are approved/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Open page' })).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(await screen.findByRole('button', { name: 'Sign in' })).toBeTruthy()
  })

  it('has no Open page for a url that is not https', async () => {
    shell({ state: 'signing_in', user_code: 'WXYZ-1234', url: 'http://account.example/device', fingerprint: 'f', expires_in: 600 })
    render(<PhoneAccountContent />)
    expect(await screen.findByText('WXYZ-1234')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Open page' })).toBeNull()
  })

  it('shows the join request and its code', async () => {
    shell({ state: 'joining', fingerprint: 'AA11 BB22', code: '418207' })
    render(<PhoneAccountContent />)

    expect(await screen.findByText('Approve this phone on a device already in your account: Settings → Account → Pending approvals.')).toBeTruthy()
    expect(screen.getByText('418 207')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy()
  })

  it('shows closing and unavailable accounts, never saying deactivated', async () => {
    shell({ state: 'closing', fingerprint: 'AA11 BB22', deletes_at: null })
    const first = render(<PhoneAccountContent />)
    expect(await screen.findByText('Account scheduled for deletion.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeTruthy()
    first.unmount()
    queryClient.clear()

    shell({ state: 'unavailable', fingerprint: 'AA11 BB22' })
    render(<PhoneAccountContent />)
    expect(await screen.findByText('Account unavailable.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeTruthy()
    expect(document.body.textContent?.toLowerCase()).not.toContain('deactivated')
  })

  it('polls every 2 s only while something waits on the person', () => {
    const waiting: PhoneCloudStatus[] = [
      { state: 'signing_in', user_code: 'X', url: 'https://a.b', fingerprint: 'f', expires_in: 1 },
      { state: 'joining', fingerprint: 'f', code: null },
      { state: 'recovery', code: 'A-B', check: [1, 2] },
    ]
    for (const s of waiting) expect(phoneCloudPollInterval(s)).toBe(2000)
    for (const s of [undefined, CONNECTED, { state: 'guest', notice: null, supported: true }] as const) {
      expect(phoneCloudPollInterval(s)).toBe(false)
    }
  })
})

describe('recovery code', () => {
  const CODE = 'AAAAA-BBBBB-CCCCC-DDDDD-EEEEE-FFFFF-GGGGG'

  it('shows the code once, with no Copy, then asks for two groups and shows a rejection', async () => {
    let attempts = 0
    shell({ state: 'recovery', code: CODE, check: [2, 5] }, {
      cloud_confirm_recovery: () => {
        attempts += 1
        if (attempts === 1) throw new Error('Those are not groups 2 and 5. Check the code you saved.')
        status = CONNECTED
        return status
      },
    })
    render(<PhoneAccountContent />)

    expect(await screen.findByText('Save your recovery code.')).toBeTruthy()
    expect(screen.getByText(/OpenAgentd can't recover it for you/)).toBeTruthy()
    expect(screen.getByText('AAAAA BBBBB CCCCC DDDDD EEEEE')).toBeTruthy()
    expect(screen.getByText('FFFFF GGGGG')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /copy/i })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'I saved it' }))
    expect(screen.queryByText('AAAAA BBBBB CCCCC DDDDD EEEEE')).toBeNull()
    fireEvent.change(screen.getByLabelText('Type group 2'), { target: { value: 'BBBBB' } })
    fireEvent.change(screen.getByLabelText('Type group 5'), { target: { value: 'nope' } })
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))

    expect((await screen.findByRole('alert')).textContent).toBe('Those are not groups 2 and 5. Check the code you saved.')
    expect(ran('cloud_confirm_recovery')[0].args).toEqual({ first: 'BBBBB', second: 'nope' })

    fireEvent.change(screen.getByLabelText('Type group 5'), { target: { value: 'EEEEE' } })
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }))
    expect(await screen.findByText('Approves devices')).toBeTruthy()
    expect(ran('cloud_confirm_recovery')[1].args).toEqual({ first: 'BBBBB', second: 'EEEEE' })
  })

  it('can be cancelled', async () => {
    shell({ state: 'recovery', code: CODE, check: [1, 3] }, {
      cloud_cancel: () => { status = { state: 'guest', notice: null, supported: true }; return status },
    })
    render(<PhoneAccountContent />)
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }))
    expect(await screen.findByRole('button', { name: 'Sign in' })).toBeTruthy()
  })
})

describe('connected account', () => {
  const LINUX: DeviceRow = { device_id: 'dev-linux', fingerprint: '9C02 E1B7', signer: false, me: false, kind: 'linux' }

  it('lists devices and removes another one after asking', async () => {
    shell(CONNECTED, {
      cloud_devices: () => [ME, LINUX],
      cloud_remove_device: () => CONNECTED,
    })
    render(<PhoneAccountContent />)

    expect(await screen.findByText('Linux · 9C02 E1B7')).toBeTruthy()
    expect(screen.getByText('This phone')).toBeTruthy()
    expect(screen.getByText('This device')).toBeTruthy()
    expect(screen.getByText('Approves devices')).toBeTruthy()
    // Not this phone itself.
    expect(screen.getAllByRole('button', { name: /^Remove / })).toHaveLength(1)

    fireEvent.click(screen.getByRole('button', { name: 'Remove Linux · 9C02 E1B7' }))
    expect(await screen.findByText('Remove this device?')).toBeTruthy()
    expect(screen.getByText('It stops reaching your computers through your account.')).toBeTruthy()
    expect(ran('cloud_remove_device')).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: 'Remove' }))
    await waitFor(() => expect(ran('cloud_remove_device')).toHaveLength(1))
    expect(ran('cloud_remove_device')[0].args).toEqual({ deviceId: 'dev-linux' })
  })

  it('registers for push quietly once connected', async () => {
    shell(CONNECTED)
    render(<PhoneAccountContent />)
    await screen.findByText('Approves devices')
    await waitFor(() => expect(ran('cloud_push_register')).toHaveLength(1))
    expect(ran('cloud_push_register')[0].args).toEqual({ prompt: false })
  })

  it('warns before the only approver signs out', async () => {
    shell(CONNECTED, { cloud_sign_out: () => { status = { state: 'guest', notice: 'signed_out', supported: true }; return status } })
    render(<PhoneAccountContent />)
    await screen.findByText('Approves devices')
    await waitFor(() => expect(ran('cloud_devices')).toHaveLength(1))

    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))
    expect(await screen.findByText('Sign out of your account?')).toBeTruthy()
    expect(screen.getByText(/This phone is the only device that can approve others/)).toBeTruthy()
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Sign out' }))
    expect(await screen.findByText('Signed out. Local sessions and settings are unchanged.')).toBeTruthy()
  })

  it('does not warn when another device can approve', async () => {
    shell(CONNECTED, { cloud_devices: () => [ME, { ...LINUX, signer: true }] })
    render(<PhoneAccountContent />)
    await screen.findByText('Linux · 9C02 E1B7')

    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }))
    expect(await screen.findByText('Sign out of your account?')).toBeTruthy()
    expect(screen.queryByText(/only device that can approve others/)).toBeNull()
  })

  it('asks for pending approvals only while the phone can approve', async () => {
    shell({ state: 'connected', fingerprint: 'AA11 BB22', signer: false })
    render(<PhoneAccountContent />)
    await screen.findByText('Member')
    await waitFor(() => expect(ran('cloud_devices')).toHaveLength(1))
    expect(ran('cloud_pending')).toHaveLength(0)
    expect(screen.queryByRole('button', { name: /^Remove / })).toBeNull()
  })
})

describe('approval sheet', () => {
  const PENDING: PendingRow = { enrollment_id: 'enr-1', fingerprint: '9C02 E1B7', country: 'VN', created_at: Date.now() - 61_000, expires_at: null, kind: 'linux' }

  /** The Account page with one request waiting; `begin` is the code's arrival. */
  async function review(extra: Record<string, Handler>) {
    shell(CONNECTED, { cloud_pending: () => [PENDING], ...extra })
    render(<PhoneAccountContent />)
    expect(await screen.findByText('Linux · 9C02 E1B7 · VN · 1 min ago')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Review' }))
    return await screen.findByRole('dialog')
  }

  it('keeps Codes match disabled until the code arrives, then confirms with the approver flag', async () => {
    let release: (code: string) => void = () => {}
    const sheet = await review({
      cloud_approve_begin: () => new Promise<ApprovalView>((resolve) => { release = (code) => resolve({ code, server: true, client: false }) }),
      cloud_approve_confirm: () => CONNECTED,
    })

    expect(within(sheet).getByText('Add this device?')).toBeTruthy()
    expect(within(sheet).getByText('Waiting for the other device…')).toBeTruthy()
    expect((within(sheet).getByRole('button', { name: 'Codes match' }) as HTMLButtonElement).disabled).toBe(true)
    expect(ran('cloud_approve_begin')[0].args).toEqual({ enrollmentId: 'enr-1' })

    release('418207')
    expect(await within(sheet).findByText('418 207')).toBeTruthy()
    const match = within(sheet).getByRole('button', { name: 'Codes match' }) as HTMLButtonElement
    expect(match.disabled).toBe(false)

    // Asked for server only: client cannot be turned on, and a server-only device does not approve by default.
    expect((within(sheet).getByRole('checkbox', { name: /Use as client/ }) as HTMLInputElement).disabled).toBe(true)
    fireEvent.click(within(sheet).getByRole('checkbox', { name: 'Can approve other devices' }))
    fireEvent.click(match)
    await waitFor(() => expect(ran('cloud_approve_confirm')).toHaveLength(1))
    expect(ran('cloud_approve_confirm')[0].args).toEqual({ enrollmentId: 'enr-1', approver: true, server: true, client: false })
  })

  it('adds a server-only device that cannot approve others by default', async () => {
    const sheet = await review({
      cloud_approve_begin: () => ({ code: '418207', server: true, client: false }),
      cloud_approve_confirm: () => CONNECTED,
    })
    fireEvent.click(await within(sheet).findByRole('button', { name: 'Codes match' }))
    await waitFor(() => expect(ran('cloud_approve_confirm')).toHaveLength(1))
    expect(ran('cloud_approve_confirm')[0].args).toEqual({ enrollmentId: 'enr-1', approver: false, server: true, client: false })
    // Confirmed: the sheet closes without rejecting anything.
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(ran('cloud_approve_reject')).toHaveLength(0)
  })

  it('rejects the request when the sheet is closed without confirming', async () => {
    const sheet = await review({
      cloud_approve_begin: () => ({ code: '418207', server: true, client: false }),
      cloud_approve_reject: () => null,
    })
    await within(sheet).findByText('418 207')
    fireEvent.keyDown(sheet, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await waitFor(() => expect(ran('cloud_approve_reject')).toHaveLength(1))
    expect(ran('cloud_approve_reject')[0].args).toEqual({ enrollmentId: 'enr-1' })
    expect(ran('cloud_approve_confirm')).toHaveLength(0)
  })

  it("rejects on Don't match and says someone may be trying to join", async () => {
    const sheet = await review({
      cloud_approve_begin: () => ({ code: '418207', server: true, client: false }),
      cloud_approve_reject: () => null,
    })
    fireEvent.click(await within(sheet).findByRole('button', { name: "Don't match" }))

    expect(await screen.findByText("Request cancelled. If you didn't start it, someone may be trying to join your account.")).toBeTruthy()
    expect(ran('cloud_approve_reject')[0].args).toEqual({ enrollmentId: 'enr-1' })
    expect(ran('cloud_approve_confirm')).toHaveLength(0)
    // Done after a rejection does not reject again.
    fireEvent.click(within(sheet).getByRole('button', { name: 'Done' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(ran('cloud_approve_reject')).toHaveLength(1)
  })

  it('lets the person turn a requested role off, and a device that opens sessions approves by default', async () => {
    const sheet = await review({
      cloud_approve_begin: () => ({ code: '418207', server: true, client: true }),
      cloud_approve_confirm: () => CONNECTED,
    })
    await within(sheet).findByText('418 207')
    const approver = within(sheet).getByRole('checkbox', { name: 'Can approve other devices' })
    expect((approver as HTMLInputElement).checked).toBe(true)
    fireEvent.click(within(sheet).getByRole('checkbox', { name: /Use as server/ }))
    fireEvent.click(within(sheet).getByRole('button', { name: 'Codes match' }))
    await waitFor(() => expect(ran('cloud_approve_confirm')).toHaveLength(1))
    expect(ran('cloud_approve_confirm')[0].args).toEqual({ enrollmentId: 'enr-1', approver: true, server: false, client: true })
  })

  it('cannot confirm with no role left', async () => {
    const sheet = await review({
      cloud_approve_begin: () => ({ code: '418207', server: false, client: true }),
    })
    await within(sheet).findByText('418 207')
    fireEvent.click(within(sheet).getByRole('checkbox', { name: /Use as client/ }))
    expect(within(sheet).getByText('Choose at least one.')).toBeTruthy()
    expect((within(sheet).getByRole('button', { name: 'Codes match' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('shows why an approval could not start', async () => {
    const sheet = await review({
      cloud_approve_begin: () => { throw new Error('The other device stopped waiting.') },
    })
    expect((await within(sheet).findByRole('alert')).textContent).toContain('The other device stopped waiting.')
    expect((within(sheet).getByRole('button', { name: 'Codes match' }) as HTMLButtonElement).disabled).toBe(true)
  })
})

describe('approval push', () => {
  const OLD: PendingRow = { enrollment_id: 'enr-old', fingerprint: '1111 2222', country: null, created_at: Date.now() - 120_000, expires_at: null, kind: 'linux' }
  const NEW: PendingRow = { enrollment_id: 'enr-new', fingerprint: '9C02 E1B7', country: 'VN', created_at: Date.now() - 5_000, expires_at: null, kind: 'macos' }

  it('opens the sheet for the newest request when the push was tapped', async () => {
    const { PhoneCloudSync } = await import('@/hooks/use-phone-cloud-sync')
    shell(CONNECTED, {
      cloud_take_notification: () => 'approval',
      cloud_pending: () => [OLD, NEW],
      cloud_approve_begin: () => new Promise(() => {}),
    })
    render(<PhoneCloudSync />)
    const sheet = await screen.findByRole('dialog')
    expect(within(sheet).getByText('Add this device?')).toBeTruthy()
    expect(within(sheet).getByText(/9C02 E1B7/)).toBeTruthy()
    await waitFor(() => expect(ran('cloud_approve_begin')).toHaveLength(1))
    expect(ran('cloud_approve_begin')[0].args).toEqual({ enrollmentId: 'enr-new' })
  })

  it('opens nothing when the app opened without a tap, or the phone does not approve', async () => {
    const { PhoneCloudSync } = await import('@/hooks/use-phone-cloud-sync')
    shell(CONNECTED, { cloud_take_notification: () => null, cloud_pending: () => [NEW] })
    const first = render(<PhoneCloudSync />)
    await waitFor(() => expect(ran('cloud_take_notification')).toHaveLength(1))
    expect(ran('cloud_pending')).toHaveLength(0)
    expect(screen.queryByRole('dialog')).toBeNull()
    first.unmount()
    queryClient.clear()
    calls = []

    shell({ ...CONNECTED, signer: false }, { cloud_take_notification: () => 'approval' })
    render(<PhoneCloudSync />)
    await waitFor(() => expect(ran('cloud_status')).not.toHaveLength(0))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(ran('cloud_take_notification')).toHaveLength(0)
  })
})
