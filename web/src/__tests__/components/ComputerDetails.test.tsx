/**
 * A computer's Details: what the list rows no longer carry (system, key,
 * role, address), and Rename for the computer the app is on.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

import { ComputerDetailsDialog, deviceFacts } from '@/components/ComputerDetails'

afterEach(cleanup)

const FACTS = deviceFacts({ kind: 'macos', fingerprint: '3F9A 21C4', signer: true, server: true, client: false })

describe('deviceFacts', () => {
  it('lists the system, the key and the role', () => {
    expect(FACTS).toEqual([
      { label: 'System', value: 'macOS' },
      { label: 'Key', value: '3F9A 21C4', mono: true },
      { label: 'Role', value: 'Server · approves devices' },
    ])
    expect(deviceFacts({ kind: 'plan9', fingerprint: 'AA11', signer: false, server: true, client: true })).toEqual([
      { label: 'Key', value: 'AA11', mono: true },
      { label: 'Role', value: 'Server and client' },
    ])
  })
})

describe('ComputerDetailsDialog', () => {
  it('shows the name and the facts, with the key in full', () => {
    render(<ComputerDetailsDialog open onOpenChange={() => {}} title="Work" facts={FACTS} renameHint="Open this computer to rename it." />)
    const dialog = screen.getByRole('dialog', { name: 'Work' })
    expect(dialog.textContent).toContain('NameWork')
    expect(dialog.textContent).toContain('SystemmacOS')
    expect(dialog.textContent).toContain('Key3F9A 21C4')
    expect(dialog.textContent).toContain('RoleServer · approves devices')
    // Not on this computer: no Rename, and it says how to get one.
    expect(screen.queryByRole('button', { name: 'Rename' })).toBeNull()
    expect(dialog.textContent).toContain('Open this computer to rename it.')
  })

  it('renames the computer the app is on', async () => {
    const saved: string[] = []
    const save = async (name: string) => { saved.push(name) }
    render(<ComputerDetailsDialog open onOpenChange={() => {}} title="studio-mini" facts={FACTS} rename={{ name: 'studio-mini', save }} />)
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }))
    const input = screen.getByRole('textbox', { name: 'Name' }) as HTMLInputElement
    expect(input.value).toBe('studio-mini')
    expect(input.maxLength).toBe(40)
    fireEvent.change(input, { target: { value: '  Work  ' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(saved).toEqual(['Work']))
    await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Name' })).toBeNull())
  })

  it('saves on Enter, and an empty name gives the computer its own name back', async () => {
    const saved: string[] = []
    const save = async (name: string) => { saved.push(name) }
    render(<ComputerDetailsDialog open onOpenChange={() => {}} title="Work" facts={FACTS} rename={{ name: 'Work', save }} />)
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }))
    const input = screen.getByRole('textbox', { name: 'Name' })
    expect(screen.getByText('Leave it empty to use the computer’s own name.')).toBeTruthy()
    fireEvent.change(input, { target: { value: '' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(saved).toEqual(['']))
  })

  it('says why a rename did not happen and keeps what was typed', async () => {
    const save = async () => { throw new Error('The computer did not answer.') }
    render(<ComputerDetailsDialog open onOpenChange={() => {}} title="Work" facts={FACTS} rename={{ name: 'Work', save }} />)
    fireEvent.click(screen.getByRole('button', { name: 'Rename' }))
    fireEvent.change(screen.getByRole('textbox', { name: 'Name' }), { target: { value: 'Personal' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    expect((await screen.findByRole('alert')).textContent).toContain('The computer did not answer.')
    expect((screen.getByRole('textbox', { name: 'Name' }) as HTMLInputElement).value).toBe('Personal')
  })
})
