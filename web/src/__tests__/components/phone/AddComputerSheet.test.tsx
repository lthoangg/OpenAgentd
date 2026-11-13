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
const { AddComputerSheet } = await import('@/components/phone/AddComputerSheet')
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

describe('AddComputerSheet', () => {
  it('offers the code once, waits for the tap and native approval, then shows the number', async () => {
    render(<StrictMode><AddComputerSheet link={LINK} onClose={() => {}} /></StrictMode>)
    expect(await screen.findByText('macOS · 3F9A 21C4')).toBeTruthy()
    expect(ran('cloud_add_scanned')).toHaveLength(1)
    expect(ran('cloud_add_scanned')[0]?.args).toEqual({ link: LINK })
    expect(ran('cloud_invite_add')).toHaveLength(0)
    fireEvent.click(screen.getByRole('checkbox', { name: /Use as client/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    await waitFor(() => expect(finishAdd).not.toBeNull())
    expect(ran('cloud_invite_add')[0]?.args).toEqual({ enrollmentId: 'request-1', approver: true, server: true, client: false })
    expect(screen.queryByText('47')).toBeNull()
    // Face ID makes the app inactive: it must not cancel its own write.
    document.dispatchEvent(new Event('visibilitychange'))
    finishAdd?.({ state: 'connected', signer: true, fingerprint: 'phone', number: '47' })
    expect(await screen.findByText('47')).toBeTruthy()
    expect(screen.getByRole('heading', { name: 'Pick this number on the computer' })).toBeTruthy()
    expect(ran('cloud_invite_cancel')).toHaveLength(0)
  })

  it('keeps Add disabled until the computer claims', async () => {
    poll = { state: 'waiting' }
    const view = render(<AddComputerSheet link={LINK} onClose={() => {}} />)
    expect(await screen.findByText('Waiting for the computer…')).toBeTruthy()
    expect((screen.getByRole('button', { name: 'Add' }) as HTMLButtonElement).disabled).toBe(true)
    view.unmount()
    await waitFor(() => expect(ran('cloud_invite_cancel')).toHaveLength(1))
  })

  it('says to cancel on the computer when someone else answered first', async () => {
    offerError = 'Someone else answered this code. Cancel on the computer, then sign in again to show a new code.'
    render(<AddComputerSheet link={LINK} onClose={() => {}} />)
    expect((await screen.findByRole('alert')).textContent).toContain('Cancel on the computer')
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
    await screen.findByText('macOS · 3F9A 21C4')
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))
    expect((await screen.findByRole('alert')).textContent).toContain('Approval cancelled.')
    expect(screen.queryByLabelText('Number to pick')).toBeNull()
    expect((screen.getByRole('button', { name: 'Add' }) as HTMLButtonElement).disabled).toBe(false)
  })
})
