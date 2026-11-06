/**
 * The phone's Servers screen, loaded on first use. It sits under Sessions,
 * so nothing on the first screen needs it: it (with the server panel it
 * holds) stays out of the startup bundle and is prefetched while the app is
 * idle, so a swipe back from Sessions finds it drawn.
 */
import type { ComponentProps } from 'react'

import { lazySurface, useSurfaceMounted } from '@/lib/lazy-surface'

const Screen = lazySurface(() => import('./ServersScreen'), 'ServersScreen')

export function ServersScreen(props: ComponentProps<typeof Screen>) {
  return useSurfaceMounted(props.active) ? <Screen {...props} /> : null
}
