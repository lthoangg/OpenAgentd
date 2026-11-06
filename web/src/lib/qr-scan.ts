/**
 * The phone's camera QR scanner (``tauri-plugin-barcode-scanner``), for the
 * `openagentd://connect` code the desktop's Network access card shows.
 *
 * A scanned code is handed to ``useConnectLink`` through a window event, so
 * it takes the same path as a code scanned with the system Camera app: the
 * connect form opens filled in, and nothing connects until Save and use.
 */
import { getPlatform } from '@/hooks/use-platform'

/** The window event a scanned code travels on (detail: the raw text). */
export const SCANNED_LINK_EVENT = 'oad:scanned-connect-link'

/** The iOS and Android apps: the only shells with the scanner plugin. */
export function canScanQr(): boolean {
  const { isTauri, os } = getPlatform()
  return isTauri && (os === 'ios' || os === 'android')
}

export type ScanOutcome =
  | { kind: 'scanned'; text: string }
  | { kind: 'denied' }
  | { kind: 'cancelled' }

/** Ask for the camera (once), scan one QR code, and return its text. */
export async function scanQrCode(): Promise<ScanOutcome> {
  const scanner = await import('@tauri-apps/plugin-barcode-scanner')
  let permission = await scanner.checkPermissions()
  if (permission !== 'granted') permission = await scanner.requestPermissions()
  if (permission !== 'granted') return { kind: 'denied' }
  try {
    // windowed: false: the plugin's own full-screen camera view, over the app.
    const result = await scanner.scan({ windowed: false, formats: [scanner.Format.QRCode] })
    return result?.content ? { kind: 'scanned', text: result.content } : { kind: 'cancelled' }
  } catch {
    return { kind: 'cancelled' }
  }
}

/** Hand a scanned code to the connect-link flow (``useConnectLink``). */
export function deliverScannedLink(text: string): void {
  window.dispatchEvent(new CustomEvent(SCANNED_LINK_EVENT, { detail: text }))
}
