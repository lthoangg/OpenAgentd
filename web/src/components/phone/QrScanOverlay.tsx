/**
 * QrScanOverlay — the in-app viewfinder for ``scanQrCode``. The camera runs
 * behind the webview and shows through one rounded window, wider than the
 * code (most of the screen's width, not all of it); the page around it
 * stays opaque. Inside the window four corner marks frame where the code
 * goes, nothing filled. A hint and Cancel sit under it. Rendered into
 * <body>, over everything.
 */
import { createPortal } from 'react-dom'

import { Button } from '@/components/ui/button'

/** One corner mark: two 3px strokes meeting at a rounded corner. */
const CORNER = 'absolute size-8 drop-shadow-sm'

export function QrScanOverlay({
  onCancel,
  hint = 'Scan the QR code under Network access on your computer.',
}: { onCancel: () => void; hint?: string }) {
  return createPortal(
    <div
      data-qr-scan-overlay=""
      role="dialog"
      aria-modal="true"
      aria-label="Scan QR code"
      className="fixed inset-0 z-80 flex flex-col items-center justify-center gap-6 px-4 pt-safe pb-safe animate-in fade-in-0 animation-duration-(--motion-base)"
    >
      {/* The camera window: its huge outline paints the page around it. */}
      <div
        data-qr-window=""
        className="relative aspect-[3/4] w-full max-w-sm rounded-2xl outline-solid outline-[200vmax] outline-(--bg-page)"
      >
        <div data-qr-frame="" aria-hidden="true" className="absolute inset-0 m-auto aspect-square w-3/5">
          <span className={`${CORNER} top-0 left-0 rounded-tl-lg border-t-[3px] border-l-[3px]`} />
          <span className={`${CORNER} top-0 right-0 rounded-tr-lg border-t-[3px] border-r-[3px]`} />
          <span className={`${CORNER} bottom-0 left-0 rounded-bl-lg border-b-[3px] border-l-[3px]`} />
          <span className={`${CORNER} right-0 bottom-0 rounded-br-lg border-r-[3px] border-b-[3px]`} />
        </div>
      </div>
      <p className="relative text-center text-xs text-(--color-text-2)">
        {hint}
      </p>
      <Button type="button" variant="default" className="relative h-11 px-6" onClick={onCancel}>
        Cancel
      </Button>
    </div>,
    document.body,
  )
}
