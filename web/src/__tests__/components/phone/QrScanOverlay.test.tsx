/** The in-app viewfinder: a camera window with four corner marks, a line saying what to scan, and Cancel. */
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

import { QrScanOverlay } from '@/components/phone/QrScanOverlay'

afterEach(cleanup)

describe('QrScanOverlay', () => {
  it('is a dialog over the page with a camera window, four corner marks and Cancel', () => {
    const onCancel = mock(() => {})
    render(<QrScanOverlay onCancel={onCancel} />)
    const dialog = screen.getByRole('dialog', { name: 'Scan QR code' })
    expect(dialog.parentElement).toBe(document.body)
    expect(dialog.querySelector('[data-qr-window]')).not.toBeNull()
    expect(dialog.querySelectorAll('[data-qr-frame] > span')).toHaveLength(4)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onCancel).toHaveBeenCalledTimes(1)
  })
})
