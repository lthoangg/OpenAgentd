/**
 * QrScanOverlay — the in-app viewfinder for ``scanQrCode``: the page stays
 * opaque except for one rounded square in the middle, where the camera
 * (running behind the webview) shows through, with a line saying what to
 * scan and Cancel under it. Rendered into <body>, over everything.
 */
import { createPortal } from 'react-dom'

import { Button } from '@/components/ui/button'

export function QrScanOverlay({ onCancel }: { onCancel: () => void }) {
  return createPortal(
    <div
      data-qr-scan-overlay=""
      role="dialog"
      aria-modal="true"
      aria-label="Scan QR code"
      className="fixed inset-0 z-80 flex flex-col items-center justify-center gap-6 px-8 pt-safe pb-safe animate-in fade-in-0 animation-duration-(--motion-base)"
    >
      {/* The square is the only hole: its huge outline paints the page around it. */}
      <div
        aria-hidden="true"
        className="aspect-square w-full max-w-64 rounded-xl border-2 border-(--color-text) outline-solid outline-[200vmax] outline-(--bg-page)"
      />
      <p className="relative text-center text-xs text-(--color-text-2)">
        Scan the QR code under Network access on your computer.
      </p>
      <Button type="button" variant="default" className="relative min-h-11 px-6" onClick={onCancel}>
        Cancel
      </Button>
    </div>,
    document.body,
  )
}
