/**
 * Adding a device from the phone: the invitation QR code first, the link
 * only behind a password-style warning, a candidate added only on a tap,
 * the two-proofs notice, and the invitation cancelled when the sheet goes.
 * The shell's commands are faked at `invoke`.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

const realPlatform = await import('@/hooks/use-platform')
const phone = { isTauri: true, os: 'ios', isMacOverlay: false, isFullscreen: false }
mock.module('@/hooks/use-platform', () => ({ ...realPlatform, getPlatform: () => phone, usePlatform: () => phone }))

mock.module('uqr', () => ({
  encode: () => ({ data: Array.from({ length: 29 }, () => Array.from({ length: 29 }, () => true)) }),
}))

let scanned = ''
mock.module('@tauri-apps/plugin-barcode-scanner', () => ({
  checkPermissions: async () => 'granted',
  requestPermissions: async () => 'granted',
  scan: async () => ({ content: scanned }),
  cancel: async () => {},
  Format: { QRCode: 'QR_CODE' },
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

const { AddDeviceSheet } = await import('@/components/phone/AddDeviceSheet')
const { PhoneAccountContent } = await import('@/components/settings/pages/settings.account.phone')
const { queryClient } = await import('@/lib/query-client')

import type { InvitePoll } from '@/api/phone-cloud'

/** Synthetic: not a real account, slot, or secret. */
const LINK = 'agentd://invite?a=test-account-0000000000&s=test-slot-000000000&k=test-only'
const CANDIDATE = { enrollment_id: 'enr-1', fingerprint: '9C02 E1B7', kind: 'linux' }

let poll: InvitePoll
const ran = (command: string) => calls.filter((c) => c.command === command)

beforeEach(() => {
  calls = []
  poll = { state: 'waiting' }
  handlers = {
    cloud_invite_start: () => ({ link: LINK, expires_at: Date.now() + 600_000 }),
    cloud_invite_poll: () => poll,
    cloud_invite_cancel: () => null,
    cloud_invite_add: () => ({ state: 'connected', fingerprint: 'AA11 BB22', signer: true }),
    cloud_approve_reject: () => null,
    cloud_status: () => ({ state: 'connected', fingerprint: 'AA11 BB22', signer: true }),
    cloud_devices: () => [{ device_id: 'dev-me', fingerprint: 'AA11 BB22', signer: true, me: true, kind: 'ios' }],
    cloud_pending: () => [],
    cloud_push_register: () => ({}),
  }
})

afterEach(() => {
  cleanup()
  queryClient.clear()
})

describe('AddDeviceSheet', () => {
  it('shows the QR code first, and the link only after the warning', async () => {
    render(<AddDeviceSheet onClose={() => {}} />)
    expect(await screen.findByRole('img', { name: 'Invitation QR code' })).toBeTruthy()
    expect(screen.queryByText(LINK)).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: "Can't scan? Use a link" }))
    expect(screen.getByText('This link works like a password')).toBeTruthy()
    expect(screen.getByText(/Send it only to the device you are adding/)).toBeTruthy()
    expect(screen.queryByText(LINK)).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Show link' }))
    expect(screen.getByText(LINK)).toBeTruthy()
  })

  it('adds a candidate only when the person taps Add', async () => {
    let closed = false
    render(<AddDeviceSheet onClose={() => { closed = true }} />)
    await screen.findByRole('img', { name: 'Invitation QR code' })
    poll = { state: 'candidate', candidate: CANDIDATE }
    expect((await screen.findByTestId('invite-candidate', {}, { timeout: 4000 })).textContent).toBe('Linux · 9C02 E1B7')
    expect(screen.getByText('Add it only if the new device shows the same.')).toBeTruthy()
    // Seeing a valid candidate adds nothing by itself.
    await waitFor(() => expect(ran('cloud_invite_poll').length).toBeGreaterThan(1), { timeout: 4000 })
    expect(ran('cloud_invite_add')).toHaveLength(0)

    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    await waitFor(() => expect(ran('cloud_invite_add')).toHaveLength(1))
    expect(ran('cloud_invite_add')[0]?.args).toEqual({ enrollmentId: 'enr-1' })
    await waitFor(() => expect(closed).toBe(true))
    // Added: closing must not cancel the spent invitation.
    expect(ran('cloud_invite_cancel')).toHaveLength(0)
  })

  it('"Not this one" drops the candidate without adding it', async () => {
    poll = { state: 'candidate', candidate: CANDIDATE }
    render(<AddDeviceSheet onClose={() => {}} />)
    await screen.findByTestId('invite-candidate')
    poll = { state: 'waiting' }
    fireEvent.click(screen.getByRole('button', { name: 'Not this one' }))
    await waitFor(() => expect(ran('cloud_approve_reject')).toHaveLength(1))
    expect(ran('cloud_approve_reject')[0]?.args).toEqual({ enrollmentId: 'enr-1' })
    expect(ran('cloud_invite_add')).toHaveLength(0)
    expect(screen.queryByTestId('invite-candidate')).toBeNull()
  })

  it('says someone else has the invitation and offers a new one', async () => {
    poll = { state: 'compromised' }
    render(<AddDeviceSheet onClose={() => {}} />)
    expect(await screen.findByText(/Someone else has this invitation, so nobody was added/)).toBeTruthy()
    expect(screen.queryByRole('img', { name: 'Invitation QR code' })).toBeNull()
    expect(ran('cloud_invite_add')).toHaveLength(0)

    poll = { state: 'waiting' }
    fireEvent.click(screen.getByRole('button', { name: 'New invitation' }))
    expect(await screen.findByRole('img', { name: 'Invitation QR code' })).toBeTruthy()
    expect(ran('cloud_invite_start')).toHaveLength(2)
  })

  it('cancels the invitation when the sheet closes', async () => {
    let closed = false
    render(<AddDeviceSheet onClose={() => { closed = true }} />)
    await screen.findByRole('img', { name: 'Invitation QR code' })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(closed).toBe(true)
    await waitFor(() => expect(ran('cloud_invite_cancel')).toHaveLength(1))
  })

  it('cancels the invitation when the app goes to the background', async () => {
    let closed = false
    render(<AddDeviceSheet onClose={() => { closed = true }} />)
    await screen.findByRole('img', { name: 'Invitation QR code' })
    const visibility = Object.getOwnPropertyDescriptor(document, 'visibilityState')
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
    try {
      document.dispatchEvent(new Event('visibilitychange'))
    } finally {
      if (visibility) Object.defineProperty(document, 'visibilityState', visibility)
      else delete (document as { visibilityState?: unknown }).visibilityState
    }
    expect(closed).toBe(true)
    await waitFor(() => expect(ran('cloud_invite_cancel')).toHaveLength(1))
  })

  it('keeps the 6-digit code as the fallback', async () => {
    render(<AddDeviceSheet onClose={() => {}} />)
    await screen.findByRole('img', { name: 'Invitation QR code' })
    fireEvent.click(screen.getByRole('button', { name: 'Use a 6-digit code instead' }))
    expect(screen.getByText('Sign in with a code instead')).toBeTruthy()
    expect(screen.getByText(/compare the 6-digit code on both screens/)).toBeTruthy()
  })
})

describe('Account page', () => {
  it('lets an approver open Add a device', async () => {
    render(<PhoneAccountContent />)
    fireEvent.click(await screen.findByRole('button', { name: 'Add a device' }))
    expect(await screen.findByRole('img', { name: 'Invitation QR code' })).toBeTruthy()
  })
})

describe('joining with an invitation on a phone', () => {
  const invited = { state: 'invited', fingerprint: '5D1E 0A77', kind: 'ios' }

  beforeEach(() => {
    handlers.cloud_status = () => ({ state: 'guest', notice: null, supported: true })
    handlers.cloud_join_invite = () => invited
  })

  it('joins with a scanned invitation and shows what to compare', async () => {
    scanned = LINK
    render(<PhoneAccountContent />)
    fireEvent.click(await screen.findByRole('button', { name: 'Scan invitation' }))
    await waitFor(() => expect(ran('cloud_join_invite')).toHaveLength(1))
    expect(ran('cloud_join_invite')[0]?.args).toEqual({ link: LINK })
    expect(await screen.findByText('iOS · 5D1E 0A77')).toBeTruthy()
  })

  it('refuses a QR code that is not an invitation', async () => {
    scanned = 'openagentd://connect?url=http://192.168.1.20:4082'
    render(<PhoneAccountContent />)
    fireEvent.click(await screen.findByRole('button', { name: 'Scan invitation' }))
    expect(await screen.findByText(/That QR code is not an invitation/)).toBeTruthy()
    expect(ran('cloud_join_invite')).toHaveLength(0)
  })

  it('joins with a pasted link, and keeps Sign in for a new account or the 6-digit code', async () => {
    render(<PhoneAccountContent />)
    expect(await screen.findByRole('button', { name: 'Sign in' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Paste link' }))
    fireEvent.change(screen.getByLabelText('Invitation link'), { target: { value: LINK } })
    fireEvent.click(screen.getByRole('button', { name: 'Join' }))
    await waitFor(() => expect(ran('cloud_join_invite')).toHaveLength(1))
    expect(await screen.findByText('iOS · 5D1E 0A77')).toBeTruthy()
  })
})
