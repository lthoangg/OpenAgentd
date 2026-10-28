/**
 * Screens kept out of the startup bundle (Settings, Telemetry, the
 * scheduler, MCP app results): each loads on first use, and all of them load
 * while the app is idle right after it starts, so they still open at once.
 *
 * `lazySurface` wraps a dynamic import. Once its module has loaded, the
 * surface renders it directly on the first render, with no Suspense fallback
 * and no remount. `useSurfaceMounted` holds back always-mounted surfaces
 * (modals that read their own open state) until they are needed or the idle
 * prefetch has run.
 */
import { lazy, Suspense, useState, useSyncExternalStore, type ComponentProps, type ComponentType, type JSX, type ReactNode } from 'react'

export type LazySurface<P> = ComponentType<P> & { preload: () => Promise<unknown> }

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- any component's props
type AnyComponent = ComponentType<any> | ((props: any) => JSX.Element | null)

let loaders: Array<() => Promise<unknown>> = []
let prefetched = false
const listeners = new Set<() => void>()

/** `lazySurface(() => import('@/components/SettingsModal'), 'SettingsModal')`. */
export function lazySurface<M extends Record<K, AnyComponent>, K extends keyof M & string>(
  loader: () => Promise<M>,
  name: K,
  options: { fallback?: ReactNode } = {},
): LazySurface<ComponentProps<M[K]>> {
  type P = ComponentProps<M[K]>
  let loaded: ComponentType<P> | undefined
  let pending: Promise<{ default: ComponentType<P> }> | undefined
  const load = () =>
    (pending ??= loader().then(
      (module) => {
        loaded = module[name] as ComponentType<P>
        return { default: loaded }
      },
      (error: unknown) => {
        pending = undefined
        throw error
      },
    ))
  const Lazy = lazy(load)
  loaders.push(load)

  function Surface(props: P) {
    // Decided once per mount: switching from the lazy wrapper to the loaded
    // component later would remount the surface and drop its state.
    const [Direct] = useState(() => loaded)
    if (Direct) return <Direct {...props} />
    return (
      <Suspense fallback={options.fallback ?? null}>
        <Lazy {...props} />
      </Suspense>
    )
  }
  return Object.assign(Surface, { preload: load })
}

/** Load every surface; failures are left for their first render to retry. */
export async function prefetchSurfaces(): Promise<void> {
  await Promise.allSettled(loaders.map((load) => load()))
  if (!prefetched) {
    prefetched = true
    for (const listener of listeners) listener()
  }
}

/**
 * Prefetch once the first screen has painted and the main thread is free.
 * WebKit (the desktop and iOS shells) has no `requestIdleCallback`, so it
 * waits a moment after the next frame instead.
 */
export function prefetchSurfacesWhenIdle(): () => void {
  let cancelled = false
  let idle: number | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  const start = () => {
    if (cancelled) return
    if (typeof window.requestIdleCallback === 'function') {
      idle = window.requestIdleCallback(() => { void prefetchSurfaces() }, { timeout: 2000 })
    } else {
      timer = setTimeout(() => { void prefetchSurfaces() }, 300)
    }
  }
  const frame = requestAnimationFrame(() => { timer = setTimeout(start, 0) })
  return () => {
    cancelled = true
    cancelAnimationFrame(frame)
    if (timer !== undefined) clearTimeout(timer)
    if (idle !== undefined) window.cancelIdleCallback?.(idle)
  }
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** True once `needed` has been true, or once the idle prefetch has run. */
export function useSurfaceMounted(needed: boolean): boolean {
  const ready = useSyncExternalStore(subscribe, () => prefetched, () => prefetched)
  const [mounted, setMounted] = useState(false)
  if ((needed || ready) && !mounted) setMounted(true)
  return mounted || needed || ready
}

export function resetSurfacesForTest(): void {
  loaders = []
  prefetched = false
  listeners.clear()
}
