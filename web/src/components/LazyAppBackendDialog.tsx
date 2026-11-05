/**
 * The Server dialog, loaded on first use. The loading screen's "Choose
 * server", a scanned connect link and the server chip all open it, but none
 * needs it on the first screen, so it (with the network-access card and QR
 * code it holds) stays out of the startup bundle and is prefetched while the
 * app is idle, like the other lazy surfaces.
 *
 * It mounts once first opened, or once the idle prefetch has run, and then
 * stays mounted so closing still fades out (``AppOverlay`` owns the exit).
 */
import type { ComponentProps } from 'react'

import { lazySurface, useSurfaceMounted } from '@/lib/lazy-surface'

const Dialog = lazySurface(() => import('./AppBackendDialog'), 'AppBackendDialog')

export function AppBackendDialog(props: ComponentProps<typeof Dialog>) {
  return useSurfaceMounted(props.open) ? <Dialog {...props} /> : null
}
