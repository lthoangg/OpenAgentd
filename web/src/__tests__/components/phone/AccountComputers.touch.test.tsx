/**
 * A computer's row on touch: a tap opens it, and Details (system, key,
 * role) is in the row's sheet, behind ⋯ or a long press.
 */
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { DeviceRow } from '@/api/phone-cloud'
import type { AppBackendStatus } from '@/lib/app-backend'

mock.module('@/hooks/use-touch-first', () => ({ useTouchFirst: () => true }))
mock.module('@tauri-apps/api/core', () => ({ invoke: async () => null }))

const { AccountComputersSection } = await import('@/components/phone/AccountComputers')

const MAC: DeviceRow = { device_id: 'dev-mac', fingerprint: '3F9A 21C4', signer: true, me: false, kind: 'macos', server: true, client: true, online: true }
const APP: AppBackendStatus = {
  base_url: 'http://192.168.1.30:4082', mode: 'external', sidecar_running: false, external: true, supports_bundled: false,
  servers: [], computer_names: { 'dev-mac': 'Work' },
}

afterEach(cleanup)

describe('a computer row on touch', () => {
  it('keeps no buttons on the row, and Details in its sheet', async () => {
    render(<AccountComputersSection computers={[{ device: MAC, label: 'Work' }]} loaded app={APP} route="none" onOpenSessions={() => {}} />)
    const row = screen.getByText('Work').closest('[data-server-row]') as HTMLElement
    expect(within(row).getByRole('button', { name: 'Open Work' })).toBeTruthy()
    expect(within(row).queryByRole('button', { name: 'Details of Work' })).toBeNull()
    expect(within(row).queryByRole('button', { name: 'Use Work' })).toBeNull()

    fireEvent.click(within(row).getByRole('button', { name: 'More actions for Work' }))
    const sheet = screen.getByRole('dialog', { name: 'Work' })
    expect(Array.from(sheet.querySelectorAll('button')).map((button) => button.textContent)).toEqual(['Details'])
    fireEvent.click(within(sheet).getByRole('button', { name: 'Details' }))
    // Details opens once the sheet has slid away.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 400)) })
    const details = screen.getByRole('dialog', { name: 'Work' })
    expect(details.textContent).toContain('Key3F9A 21C4')
    expect(details.textContent).toContain('SystemmacOS')
  })
})
