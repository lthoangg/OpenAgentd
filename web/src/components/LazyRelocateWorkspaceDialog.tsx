/**
 * "Locate folder…", loaded on first use. It opens only for a workspace whose
 * folder is gone, so it stays out of the startup bundle and is prefetched
 * while the app is idle, like the other lazy surfaces.
 *
 * It mounts once first opened, or once the idle prefetch has run, and then
 * stays mounted so closing still fades out.
 */
import type { ComponentProps } from 'react'

import { lazySurface, useSurfaceMounted } from '@/lib/lazy-surface'

const Dialog = lazySurface(() => import('./RelocateWorkspaceDialog'), 'RelocateWorkspaceDialog')

export function RelocateWorkspaceDialog(props: ComponentProps<typeof Dialog>) {
  return useSurfaceMounted(props.from !== null) ? <Dialog {...props} /> : null
}
