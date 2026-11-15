/**
 * The signed-in Account list: names from the account, this device first,
 * the one-approver note with its action, and the one upload of the names
 * this app remembered.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

import { DeviceRows, onlyApproverIsMe, type ListedDevice } from '@/components/account/DeviceRows'

const ME: ListedDevice = { device_id: 'me', fingerprint: 'AA11 BB22', signer: true, server: true, client: true, me: true, kind: 'macos', name: null }
const PHONE: ListedDevice = { device_id: 'phone', fingerprint: 'D00D 0001', signer: false, server: false, client: true, me: false, kind: 'ios', name: null }
const MINI: ListedDevice = { device_id: 'mini', fingerprint: '3F9A 21C4', signer: false, server: true, client: false, me: false, kind: 'macos', name: 'Studio Mini' }

const base = {
  selfLabel: 'This computer',
  removeEffect: 'It is signed out.',
  rename: () => null,
}

beforeEach(() => window.localStorage.clear())
afterEach(cleanup)

describe('onlyApproverIsMe', () => {
  it('is true only while this device is the one approver', () => {
    expect(onlyApproverIsMe([ME, PHONE])).toBe(true)
    expect(onlyApproverIsMe([ME, { ...PHONE, signer: true }])).toBe(false)
    expect(onlyApproverIsMe([{ ...ME, signer: false }, { ...PHONE, signer: true }])).toBe(false)
    expect(onlyApproverIsMe(undefined)).toBe(false)
  })
})

describe('DeviceRows', () => {
  it('lists this device first with Sign out, and others by the account name', () => {
    render(<DeviceRows {...base} devices={[MINI, ME]} meSigner canChange onSignOut={() => {}} onRemove={async () => {}} />)

    const details = screen.getAllByRole('button', { name: /^Details of / }).map((button) => button.getAttribute('aria-label'))
    expect(details).toEqual(['Details of This computer', 'Details of Studio Mini'])
    expect(screen.getAllByRole('button', { name: 'Sign out' })).toHaveLength(1)
    expect(screen.getByRole('button', { name: 'Remove Studio Mini' })).toBeTruthy()
  })

  it('prefers the account name to one this app remembered', () => {
    render(<DeviceRows {...base} devices={[ME, MINI]} names={{ mini: 'Old nickname' }} meSigner canChange />)

    expect(screen.getByRole('button', { name: 'Details of Studio Mini' })).toBeTruthy()
    expect(screen.queryByText('Old nickname')).toBeNull()
  })

  it('notes a lone approver and lets the phone approve too', async () => {
    const promoted: string[] = []
    render(<DeviceRows {...base} devices={[ME, MINI, PHONE]} meSigner canChange onMakeApprover={async (id) => { promoted.push(id) }} />)

    expect(screen.getByText('Only this computer can approve new devices.')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Let your phone approve' }))
    await waitFor(() => expect(promoted).toEqual(['phone']))
  })

  it('has no note once two devices approve', () => {
    render(<DeviceRows {...base} devices={[ME, { ...PHONE, signer: true }]} meSigner canChange onMakeApprover={async () => {}} />)

    expect(screen.queryByText(/can approve new devices/)).toBeNull()
  })

  it('names the lone approver elsewhere, with no action here', () => {
    render(<DeviceRows {...base} devices={[{ ...ME, signer: false }, { ...PHONE, signer: true }]} meSigner={false} canChange onMakeApprover={async () => {}} />)

    expect(screen.getByRole('status').textContent).toContain('Only your phone can approve new devices.')
    expect(screen.queryByRole('button', { name: /approve$/ })).toBeNull()
  })

  it('shows the promotion failure', async () => {
    render(<DeviceRows {...base} devices={[ME, PHONE]} meSigner canChange onMakeApprover={async () => { throw new Error('Cancelled.') }} />)

    fireEvent.click(screen.getByRole('button', { name: 'Let your phone approve' }))
    expect((await screen.findByRole('alert')).textContent).toContain('Cancelled.')
  })

  it('uploads remembered names the account lacks, once per account', async () => {
    const uploads: Array<[string, string]> = []
    const upload = async (id: string, name: string) => { uploads.push([id, name]) }
    const view = render(<DeviceRows {...base} devices={[ME, PHONE, MINI]} names={{ phone: ' My iPhone ', mini: 'Ignored', me: 'Mine' }} meSigner canChange uploadName={upload} />)

    await waitFor(() => expect(window.localStorage.getItem('openagentd.cloud.namesUploaded')).toBe('me'))
    // Not this device's own name, nor one the account already has.
    expect(uploads).toEqual([['phone', 'My iPhone']])

    view.unmount()
    render(<DeviceRows {...base} devices={[ME, PHONE, MINI]} names={{ phone: 'My iPhone' }} meSigner canChange uploadName={upload} />)
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(uploads).toHaveLength(1)
  })

  it('uploads nothing from a device that does not approve', async () => {
    const uploads: string[] = []
    render(<DeviceRows {...base} devices={[{ ...ME, signer: false }, PHONE]} names={{ phone: 'My iPhone' }} meSigner={false} canChange uploadName={async (id) => { uploads.push(id) }} />)

    await waitFor(() => expect(window.localStorage.getItem('openagentd.cloud.namesUploaded')).toBe('me'))
    expect(uploads).toEqual([])
  })
})
