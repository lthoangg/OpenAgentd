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

const { scanQrCode } = await import('@/lib/qr-scan')

describe('scanQrCode', () => {
  it('asks for the camera, then returns the scanned text', async () => {
    expect(await scanQrCode()).toEqual({ kind: 'scanned', text: content! })
    expect(requested).toEqual(['camera'])
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
