/**
 * A new iPhone or iPad with no account: its first screen is the QR code its
 * other phone scans, the code renews by itself, the number is picked once,
 * and every word on the way is plain. The shell is faked at `invoke`.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'

const realPlatform = await import('@/hooks/use-platform')
const phone = { isTauri: true, os: 'ios', isMacOverlay: false, isFullscreen: false }
mock.module('@/hooks/use-platform', () => ({ ...realPlatform, getPlatform: () => phone, usePlatform: () => phone }))

mock.module('uqr', () => ({
  encode: () => ({ data: Array.from({ length: 29 }, () => Array.from({ length: 29 }, () => true)) }),
}))

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

const { ServersScreen, ALL_SET } = await import('@/components/phone/ServersScreen')
const { AddScannedSheet } = await import('@/components/phone/AddScannedSheet')
const { CODE_UNAVAILABLE } = await import('@/components/phone/NewDeviceSignIn')
const { queryClient } = await import('@/lib/query-client')
const { resetPhoneCloudPush } = await import('@/queries/phone-cloud')

import type { DeviceRow, PhoneCloudStatus } from '@/api/phone-cloud'

const IPAD_UA = 'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148'
const IPHONE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148'
const realUserAgent = navigator.userAgent
function setUserAgent(ua: string) {
  Object.defineProperty(window.navigator, 'userAgent', { value: ua, configurable: true })
}

const GUEST: PhoneCloudStatus = { state: 'guest', notice: null, supported: true }
const LINK = 'agentd://add?c=WXYZ1234&d=test-device&k=test-only'
const SHOWING: Extract<PhoneCloudStatus, { state: 'signing_in' }> = { state: 'signing_in', user_code: 'WXYZ-1234', url: 'https://account.openagentd.dev/device', fingerprint: 'AA11 BB22', expires_in: 600, add_link: LINK }
const CHOOSING: PhoneCloudStatus = { state: 'confirming', choices: ['17', '42', '85'] }
const CONNECTED: PhoneCloudStatus = { state: 'connected', fingerprint: 'AA11 BB22', signer: true }
const ME: DeviceRow = { device_id: 'dev-me', fingerprint: 'AA11 BB22', signer: true, me: true, kind: 'ios', server: false, client: true, online: null }
const MAC: DeviceRow = { device_id: 'dev-mac', fingerprint: '3F9A 21C4', signer: true, me: false, kind: 'macos', server: true, client: true, online: false, name: 'MacBook Pro' }

let status: PhoneCloudStatus
let codes = 0

/** A fresh device: no saved computer, a guest; `cloud_sign_in` shows a new code each time. */
function shell(initial: PhoneCloudStatus, extra: Record<string, Handler> = {}) {
  status = initial
  codes = 0
  handlers = {
    cloud_status: () => status,
    cloud_push_register: () => ({}),
    cloud_devices: () => [ME, MAC],
    cloud_pending: () => [],
    cloud_sign_in: () => {
      codes += 1
      status = { ...SHOWING, add_link: `${LINK}${codes}` }
      return status
    },
    cloud_cancel: () => { status = GUEST; return status },
    app_backend_status: () => ({ base_url: '', mode: 'external', sidecar_running: false, external: true, supports_bundled: false, servers: [] }),
    app_server_watch_states: () => ({}),
    secure_get_access_key: () => null,
    cloud_link_route: () => ({ route: 'none' }),
    ...extra,
  }
}

/** The shell moved on by itself: the page reads the status again. */
async function becomes(next: PhoneCloudStatus) {
  status = next
  await act(async () => { await queryClient.refetchQueries({ queryKey: ['phone-cloud', 'status'] }) })
}

const ran = (command: string) => calls.filter((call) => call.command === command)

/** Words that never reach a person on this path (Details rows aside). */
const JARGON = /cloud|signer|fingerprint|relay/i

beforeEach(() => {
  calls = []
  window.localStorage.clear()
  resetPhoneCloudPush()
  setUserAgent(IPAD_UA)
  queryClient.setDefaultOptions({ ...queryClient.getDefaultOptions(), queries: { ...queryClient.getDefaultOptions().queries, retry: false } })
})

afterEach(() => {
  cleanup()
  queryClient.clear()
  setUserAgent(realUserAgent)
})

describe('a new iPad, first open', () => {
  it('opens on the QR code its iPhone scans, with Google and the recovery code as links', async () => {
    shell(GUEST)
    render(<ServersScreen active />)

    expect(await screen.findByRole('heading', { level: 1, name: 'Use your computers on this iPad' })).toBeTruthy()
    expect(screen.getByText(/tap/).textContent).toBe('Open OpenAgentd on your iPhone and tap Scan.')
    const qr = await screen.findByLabelText('QR code to add this iPad')
    expect(qr).toBeTruthy()
    expect(ran('cloud_sign_in')).toHaveLength(1)
    // The QR code comes before both links.
    const google = screen.getByRole('button', { name: 'No iPhone nearby? Sign in with Google' })
    const lost = screen.getByRole('button', { name: 'Lost your phone? Use your recovery code' })
    expect(qr.compareDocumentPosition(google) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(google.compareDocumentPosition(lost) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    // Not the Computers list yet.
    expect(screen.queryByText('Computers')).toBeNull()
    expect(document.body.textContent).not.toMatch(JARGON)
  })

  it('calls a new iPhone "this iPhone" and the phone that adds it "your other iPhone"', async () => {
    setUserAgent(IPHONE_UA)
    shell(GUEST)
    render(<ServersScreen active />)
    expect(await screen.findByRole('heading', { level: 1, name: 'Use your computers on this iPhone' })).toBeTruthy()
    expect(screen.getByText(/tap/).textContent).toBe('Open OpenAgentd on your other iPhone and tap Scan.')
  })

  it('shows a new code by itself when the old one timed out', async () => {
    shell(GUEST)
    render(<ServersScreen active />)
    expect(await screen.findByLabelText('QR code to add this iPad')).toBeTruthy()
    expect(ran('cloud_sign_in')).toHaveLength(1)
    await becomes({ ...GUEST, notice: 'expired' })
    await waitFor(() => expect(ran('cloud_sign_in')).toHaveLength(2))
    expect(await screen.findByLabelText('QR code to add this iPad')).toBeTruthy()
    // Nothing to read: the person did nothing wrong.
    expect(screen.queryByText(/timed out/)).toBeNull()
  })

  it('says so when no code can be had, and tries again on Retry only', async () => {
    shell({ ...GUEST, notice: 'unreachable' })
    render(<ServersScreen active />)
    expect(await screen.findByText(CODE_UNAVAILABLE)).toBeTruthy()
    expect(ran('cloud_sign_in')).toHaveLength(0)
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(await screen.findByLabelText('QR code to add this iPad')).toBeTruthy()
    expect(ran('cloud_sign_in')).toHaveLength(1)
  })

  it('shows the sign-in code and the device ID under Sign in with Google', async () => {
    shell(GUEST)
    render(<ServersScreen active />)
    fireEvent.click(await screen.findByRole('button', { name: 'No iPhone nearby? Sign in with Google' }))
    expect(await screen.findByText('WXYZ-1234')).toBeTruthy()
    expect(screen.getByText(/Check that the page shows the same device ID/)).toBeTruthy()
    expect(screen.getByText('AA11 BB22')).toBeTruthy()
    expect(ran('cloud_sign_in')).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
    expect(await screen.findByLabelText('QR code to add this iPad')).toBeTruthy()
  })

  it('lets a person with a computer on their network reach the usual screen', async () => {
    shell(GUEST)
    render(<ServersScreen active />)
    fireEvent.click(await screen.findByRole('button', { name: 'Other ways to connect' }))
    expect(await screen.findByRole('heading', { level: 1, name: 'Computers' })).toBeTruthy()
  })
})

describe('after the iPhone scanned', () => {
  it('says to tap Add on the iPhone, then asks for the number once, and lands on the computers', async () => {
    shell(GUEST, {
      cloud_pick_number: () => { status = CONNECTED; return status },
    })
    render(<ServersScreen active />)
    await screen.findByLabelText('QR code to add this iPad')

    await becomes({ state: 'scanned', fingerprint: 'AA11 BB22' })
    expect(await screen.findByText('Tap Add on your iPhone.')).toBeTruthy()
    expect(document.body.textContent).not.toMatch(JARGON)

    await becomes(CHOOSING)
    expect(await screen.findByRole('heading', { name: 'Which number is on your iPhone?' })).toBeTruthy()
    expect(screen.getByText('No number on your iPhone? Tap Cancel.')).toBeTruthy()
    const pick = screen.getByRole('button', { name: '42' })
    expect(screen.getByRole('button', { name: '17' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '85' })).toBeTruthy()
    expect(document.body.textContent).not.toMatch(JARGON)
    fireEvent.click(pick)

    await waitFor(() => expect(ran('cloud_pick_number')).toHaveLength(1))
    expect(ran('cloud_pick_number')[0].args).toEqual({ number: '42' })
    expect(await screen.findByText(ALL_SET)).toBeTruthy()
    expect(screen.getByRole('heading', { level: 1, name: 'Computers' })).toBeTruthy()
    // An offline computer is listed, never "No computers in your account yet".
    expect(await screen.findByText('MacBook Pro')).toBeTruthy()
    expect(screen.queryByText('No computers in your account yet')).toBeNull()
  })

  it('says plainly that a wrong number added nothing, and shows a new code', async () => {
    shell(CHOOSING, {
      cloud_pick_number: () => { status = { ...GUEST, notice: 'wrong_number' }; return status },
    })
    render(<ServersScreen active />)
    fireEvent.click(await screen.findByRole('button', { name: '17' }))
    expect(await screen.findByText("Not added. That wasn't the number on your iPhone. Scan the new code to try again.")).toBeTruthy()
    await waitFor(() => expect(ran('cloud_sign_in')).toHaveLength(1))
    expect(await screen.findByLabelText('QR code to add this iPad')).toBeTruthy()
    expect(ran('cloud_pick_number')).toHaveLength(1)
  })

  it('cancels without picking', async () => {
    shell(CHOOSING)
    render(<ServersScreen active />)
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(ran('cloud_cancel')).toHaveLength(1))
    expect(ran('cloud_pick_number')).toHaveLength(0)
  })

  it('words a mismatch calmly, with no alarm', async () => {
    shell({ ...GUEST, notice: 'commit_mismatch' })
    render(<ServersScreen active />)
    expect(await screen.findByText('Not added. Try again.')).toBeTruthy()
    expect(screen.queryByText(/someone may be trying/i)).toBeNull()
  })
})

describe('plain words on the old phone', () => {
  it('keeps every word of Add this iPhone or iPad? plain until Details', async () => {
    handlers = {
      cloud_add_scanned: () => 1,
      cloud_invite_poll: () => ({ state: 'candidate', candidate: { enrollment_id: 'e', fingerprint: 'AB12 CD34', kind: 'ios', server: false, client: true } }),
      cloud_invite_cancel: () => null,
    }
    render(<AddScannedSheet link={LINK} onClose={() => {}} />)
    const sheet = await screen.findByRole('dialog', { name: 'Add this iPhone or iPad?' })
    expect(sheet.textContent).not.toMatch(JARGON)
    expect(within(sheet).queryByText(/AB12/)).toBeNull()
  })
})
