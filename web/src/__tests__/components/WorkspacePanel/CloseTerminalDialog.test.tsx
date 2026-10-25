import { afterEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

mock.module('lucide-react', () => new Proxy({}, { get: () => () => null }))

import { CloseTerminalDialog } from '@/components/WorkspacePanel/CloseTerminalDialog'

afterEach(cleanup)

describe('CloseTerminalDialog', () => {
  it('focuses Cancel, so a reflex Enter never stops a running shell', async () => {
    render(<CloseTerminalDialog open title="Terminal 1" onConfirm={() => {}} onCancel={() => {}} />)

    // Not even for the first frame, before the modal's focus pass runs.
    expect(document.activeElement).not.toBe(screen.getByRole('button', { name: 'Close terminal' }))
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' })))
  })

  it('still stops the shell when Close terminal is clicked', () => {
    const onConfirm = mock(() => {})
    render(<CloseTerminalDialog open title="Terminal 1" onConfirm={onConfirm} onCancel={() => {}} />)

    fireEvent.click(screen.getByRole('button', { name: 'Close terminal' }))
    expect(onConfirm).toHaveBeenCalledTimes(1)
  })
})
