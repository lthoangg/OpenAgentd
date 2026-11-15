import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { StrictMode } from 'react'
import type { InvitePoll } from '@/api/phone-cloud'

const calls: Array<{ command: string; args?: Record<string, unknown> }> = []
let poll: InvitePoll
let addError: string | null
let offerError: string | null
let finishAdd: ((v: unknown) => void) | null
let deferredOffer: Promise<number> | null
mock.module('@tauri-apps/api/core', () => ({
  invoke: async (command: string, args?: Record<string, unknown>) => {
    calls.push({ command, args })
    if (command === 'cloud_add_scanned') {
      if (offerError) throw offerError
      return deferredOffer ?? 1
    }
    if (command === 'cloud_invite_poll') return poll
    if (command === 'cloud_invite_cancel') return null
    if (command === 'cloud_invite_add') {
      if (addError) throw addError
      return new Promise((resolve) => { finishAdd = resolve })
    }
    throw new Error(`unexpected command: ${command}`)
  },
}))
const { AddScannedSheet: AddComputerSheet } = await import('@/components/phone/AddScannedSheet')
const { queryClient } = await import('@/lib/query-client')
const LINK = 'agentd://add?c=BCDFGHJK&d=test-device-000000000&k=test-only'
const CANDIDATE = { enrollment_id: 'request-1', fingerprint: '3F9A 21C4', kind: 'macos', server: true, client: true }
const ran = (command: string) => calls.filter((c) => c.command === command)

beforeEach(() => {
  calls.length = 0
  poll = { state: 'candidate', candidate: CANDIDATE }
  addError = offerError = null
  finishAdd = null
  deferredOffer = null
})
afterEach(async () => {
  cleanup()
  await waitFor(() => expect(queryClient.isMutating()).toBe(0))
  queryClient.clear()
})

describe('AddScannedSheet', () => {
  it('offers the code once, waits for the tap and native approval, then shows the number', async () => {
    render(<StrictMode><AddComputerSheet link={LINK} onClose={() => {}} /></StrictMode>)
    expect(await screen.findByRole('heading', { name: 'Add this computer?' })).toBeTruthy()
    expect(ran('cloud_add_scanned')).toHaveLength(1)
    expect(ran('cloud_add_scanned')[0]?.args).toEqual({ link: LINK })
    expect(ran('cloud_invite_add')).toHaveLength(0)
    // The device ID and roles are under Details; changing one there still counts.
    expect(screen.queryByRole('checkbox', { name: /can open my other computers/ })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Details' }))
    expect(screen.getByText('macOS · 3F9A 21C4')).toBeTruthy()
    fireEvent.click(screen.getByRole('checkbox', { name: /can open my other computers/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    await waitFor(() => expect(finishAdd).not.toBeNull())
    expect(ran('cloud_invite_add')[0]?.args).toEqual({ enrollmentId: 'request-1', approver: true, server: true, client: false })
    expect(screen.queryByText('47')).toBeNull()
    // Face ID makes the app inactive: it must not cancel its own write.
    document.dispatchEvent(new Event('visibilitychange'))
    finishAdd?.({ state: 'connected', signer: true, fingerprint: 'phone', number: '47' })
    expect(await screen.findByText('47')).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Pick this number on the computer' })).toBeTruthy()
    expect(screen.getByText('This makes sure the computer in front of you is the one being added.')).toBeTruthy()
    expect(ran('cloud_invite_cancel')).toHaveLength(0)
  })

  it('adds with what the computer asked for when Details stays closed', async () => {
    render(<AddComputerSheet link={LINK} onClose={() => {}} />)
    expect(await screen.findByRole('heading', { name: 'Add this computer?' })).toBeTruthy()
    expect(screen.queryByRole('checkbox')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    await waitFor(() => expect(finishAdd).not.toBeNull())
    expect(ran('cloud_invite_add')[0]?.args).toEqual({ enrollmentId: 'request-1', approver: true, server: true, client: true })
    finishAdd?.({ state: 'connected', signer: true, fingerprint: 'phone', number: '47' })
    expect(await screen.findByText('47')).toBeTruthy()
  })

  it('shows Can add devices under Details too', async () => {
    poll = { state: 'candidate', candidate: { ...CANDIDATE, client: false } }
    render(<AddComputerSheet link={LINK} onClose={() => {}} />)
    await screen.findByRole('heading', { name: 'Add this computer?' })
    expect(screen.queryByRole('checkbox', { name: 'Can add devices' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Details' }))
    expect((screen.getByRole('checkbox', { name: 'Can add devices' }) as HTMLInputElement).checked).toBe(false)
  })

  it('keeps Add disabled until the computer claims', async () => {
    poll = { state: 'waiting' }
    const view = render(<AddComputerSheet link={LINK} onClose={() => {}} />)
    expect(await screen.findByText('Waiting for the device…')).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Add' }) as HTMLButtonElement).disabled).toBe(true)
    view.unmount()
    await waitFor(() => expect(ran('cloud_invite_cancel')).toHaveLength(1))
  })

  it('says to show a new code when someone else answered first', async () => {
    offerError = 'Someone else answered this code first. Show a new one.'
    render(<AddComputerSheet link={LINK} onClose={() => {}} />)
    expect((await screen.findByRole('alert')).textContent).toContain('Show a new one.')
    expect(ran('cloud_invite_add')).toHaveLength(0)
  })

  it('cancels the eventual generation even when the sheet unmounts before the offer answers', async () => {
    let resolveOffer: (value: number) => void = () => {}
    deferredOffer = new Promise((resolve) => { resolveOffer = resolve })
    const view = render(<AddComputerSheet link={LINK} onClose={() => {}} />)
    await waitFor(() => expect(ran('cloud_add_scanned')).toHaveLength(1))
    view.unmount()
    await waitFor(() => expect(ran('cloud_invite_cancel')).toHaveLength(1))
    resolveOffer(7)
    await waitFor(() => expect(ran('cloud_invite_cancel')).toHaveLength(2))
    expect(ran('cloud_invite_cancel')[1]?.args).toEqual({ generation: 7 })
  })

  it('does not show a number if Face ID was cancelled', async () => {
    addError = 'Approval cancelled.'
    render(<AddComputerSheet link={LINK} onClose={() => {}} />)
    await screen.findByRole('heading', { name: 'Add this computer?' })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    expect((await screen.findByRole('alert')).textContent).toContain('Approval cancelled.')
    expect(screen.queryByLabelText('Number to tap')).toBeNull()
    expect((screen.getByRole('button', { name: 'Add' }) as HTMLButtonElement).disabled).toBe(false)
  })

  it('names a new iPhone or iPad in plain words, and shows the number to tap on it', async () => {
    poll = { state: 'candidate', candidate: { enrollment_id: 'request-2', fingerprint: 'AB12 CD34', kind: 'ios', server: false, client: true } }
    render(<AddComputerSheet link={LINK} onClose={() => {}} />)
    expect(await screen.findByRole('heading', { name: 'Add this iPhone or iPad?' })).toBeTruthy()
    expect(screen.getByText('It can use your computers.')).toBeTruthy()
    // The device ID and roles stay out of sight until Details.
    expect(screen.queryByText(/AB12 CD34/)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    await waitFor(() => expect(finishAdd).not.toBeNull())
    // A phone asks to use computers: it can add devices too, by default.
    expect(ran('cloud_invite_add')[0]?.args).toEqual({ enrollmentId: 'request-2', approver: true, server: false, client: true })
    finishAdd?.({ state: 'connected', signer: true, fingerprint: 'phone', number: '42' })
    expect(await screen.findByRole('heading', { name: 'Tap this number on the iPhone or iPad' })).toBeTruthy()
    expect(screen.getByLabelText('Number to tap').textContent).toBe('42')
    expect(screen.getByText('This makes sure the iPhone or iPad in your hand is the one being added.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Done' })).toBeTruthy()
  })

  it('says the code timed out when it ended before anyone was added', async () => {
    poll = { state: 'ended' }
    render(<AddComputerSheet link={LINK} onClose={() => {}} />)
    expect((await screen.findByRole('alert')).textContent).toBe('This code timed out. Show a new one.')
  })
})
