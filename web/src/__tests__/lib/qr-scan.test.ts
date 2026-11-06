/**
 * The camera QR scanner: asks for the camera once, returns the code's text,
 * and hands a code to the connect-link flow on a window event.
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
  scan: async () => (content === null ? Promise.reject(new Error('cancelled')) : { content }),
}))

const { scanQrCode, deliverScannedLink, SCANNED_LINK_EVENT } = await import('@/lib/qr-scan')

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

describe('deliverScannedLink', () => {
  it('sends the text on the scanned-link event', () => {
    const seen: unknown[] = []
    const listener = (event: Event) => seen.push((event as CustomEvent).detail)
    window.addEventListener(SCANNED_LINK_EVENT, listener)
    deliverScannedLink('openagentd://connect?x')
    window.removeEventListener(SCANNED_LINK_EVENT, listener)
    expect(seen).toEqual(['openagentd://connect?x'])
  })
})
