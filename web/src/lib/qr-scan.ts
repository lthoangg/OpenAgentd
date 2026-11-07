/**
 * The phone's camera QR scanner (``tauri-plugin-barcode-scanner``), for the
 * `openagentd://connect` code the desktop's Network access card shows.
 * The Servers list fills its own add form from the code.
 */
import { getPlatform } from '@/hooks/use-platform'

/** The iOS and Android apps: the only shells with the scanner plugin. */
export function canScanQr(): boolean {
  const { isTauri, os } = getPlatform()
  return isTauri && (os === 'ios' || os === 'android')
}

export type ScanOutcome =
  | { kind: 'scanned'; text: string }
  | { kind: 'denied' }
  | { kind: 'cancelled' }

/**
 * Ask for the camera (once), scan one QR code, and return its text.
 *
 * ``windowed``: the camera runs behind the webview instead of over the app,
 * so the app draws the viewfinder (``QrScanOverlay``: one square in an
 * opaque page, with Cancel). While it runs, ``html[data-qr-scanning]``
 * clears the page's background so the camera shows through the square.
 */
export async function scanQrCode(): Promise<ScanOutcome> {
  const scanner = await import('@tauri-apps/plugin-barcode-scanner')
  let permission = await scanner.checkPermissions()
  if (permission !== 'granted') permission = await scanner.requestPermissions()
  if (permission !== 'granted') return { kind: 'denied' }
  const root = document.documentElement
  root.setAttribute('data-qr-scanning', '')
  try {
    const result = await scanner.scan({ windowed: true, formats: [scanner.Format.QRCode] })
    return result?.content ? { kind: 'scanned', text: result.content } : { kind: 'cancelled' }
  } catch {
    return { kind: 'cancelled' }
  } finally {
    root.removeAttribute('data-qr-scanning')
  }
}

/** Stop a scan in progress (the viewfinder's Cancel); ``scanQrCode`` resolves cancelled. */
export async function cancelQrScan(): Promise<void> {
  const scanner = await import('@tauri-apps/plugin-barcode-scanner')
  await scanner.cancel().catch(() => {})
}
