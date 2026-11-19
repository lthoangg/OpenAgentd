/**
 * The camera QR scanner: asks for the camera once and returns the code's text.
 */
import { describe, expect, it, mock } from 'bun:test'

let permission = 'prompt'
let granted = 'granted'
let content: string | null = 'openagentd://connect?url=http%3A%2F%2F10.0.0.2%3A4082&key=k'
const requested: string[] = []
mock.module('@tauri-apps/plugin-barcode-scanner', () => ({
  Format: { QRCode: 'QR_CODE' },
  checkPermissions: async () => permission,
  requestPermissions: async () => { requested.push('camera'); return granted },
  cancel: async () => {},
  scan: async () => (content === null ? Promise.reject(new Error('cancelled')) : { content }),
}))

const haptics: string[] = []
const realHaptics = await import('@/lib/haptics')
mock.module('@/lib/haptics', () => ({ ...realHaptics, softHapticFeedback: () => { haptics.push('soft') } }))

const { scanQrCode } = await import('@/lib/qr-scan')

describe('scanQrCode', () => {
  it('asks for the camera, then returns the scanned text', async () => {
    expect(await scanQrCode()).toEqual({ kind: 'scanned', text: content! })
    expect(requested).toEqual(['camera'])
  })

  // The viewfinder closes by itself: the tap says the code was read.
  it('taps softly when a code is read, and not when the scan ends without one', async () => {
    haptics.length = 0
    await scanQrCode()
    expect(haptics).toEqual(['soft'])

    const read = content
    content = null
    await scanQrCode()
    content = read
    expect(haptics).toEqual(['soft'])
  })

  it('says denied when the camera stays off', async () => {
    granted = 'denied'
    expect(await scanQrCode()).toEqual({ kind: 'denied' })
    granted = 'granted'
  })

  it('treats a closed scanner as cancelled', async () => {
    permission = 'granted'
    content = null
    expect(await scanQrCode()).toEqual({ kind: 'cancelled' })
  })
})
