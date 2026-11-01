/**
 * Performance contract for the InputComposer composer pill.
 *
 * `value` is local state (InputComposer.tsx), so the composer re-renders on every
 * keystroke. framer-motion's `layout` prop makes the projection pass measure
 * the node on every one of those renders — a forced reflow per typed
 * character, on the hottest path in the app.
 *
 * Measured with the real library via `bun scripts/bench-motion-layout.mjs`:
 *
 *   A. plain <div>                              0 rect calls  (0.00/render)
 *   B. <motion.div> (no layout)                 0 rect calls  (0.00/render)
 *   C. <motion.div layout>                     80 rect calls  (2.00/render)
 *   D. <motion.div layout animate={{padding}}> 80 rect calls  (2.00/render)
 *
 * The docked composer never collapses, so the pill needs no motion at all:
 * it renders as a plain element (case A).
 *
 * This suite cannot measure that directly: setup.ts stubs framer-motion by
 * resolved path, so every import of it inside `bun test` gets the stub. It
 * instead pins the structural contract the benchmark justifies — the pill is
 * not a motion element.
 */
import { describe, it, expect, afterEach, mock } from 'bun:test'
import type React from 'react'

/** Props captured from every rendered `motion.*` element, in render order. */
const captured: Array<Record<string, unknown>> = []

mock.module('framer-motion', () => ({
  AnimatePresence: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  motion: new Proxy(
    {},
    {
      get: (_t, tag: string) => {
        const Component = ({
          children,
          ...props
        }: { children?: React.ReactNode } & Record<string, unknown>) => {
          captured.push({ __tag: tag, ...props })
          const domProps: Record<string, unknown> = {}
          for (const [k, v] of Object.entries(props)) {
            if (k === 'className' || k === 'style' || k.startsWith('data-') || k.startsWith('aria-')) {
              domProps[k] = v
            }
          }
          return <div {...domProps}>{children}</div>
        }
        return Component
      },
    },
  ),
  useDragControls: () => ({ start: () => {}, subscribe: () => () => {} }),
  useMotionValue: (v: unknown) => ({ get: () => v, set: () => {}, onChange: () => () => {} }),
  useTransform: () => 0,
  useReducedMotion: () => false,
}))

mock.module('@/hooks/use-mobile', () => ({ useIsMobile: () => false }))
mock.module('@/hooks/use-platform', () => ({
  usePlatform: () => ({ isTauri: false, os: 'macos', isMacOverlay: false }),
  getPlatform: () => ({ isTauri: false, os: 'macos', isMacOverlay: false }),
}))

const { render, cleanup } = await import('@testing-library/react')
const { InputComposer } = await import('@/components/InputComposer')

afterEach(() => {
  cleanup()
  captured.length = 0
})

/** The composer pill is the motion element carrying the rounded-lg shell. */
function findPill() {
  return captured.find(
    (p) => typeof p.className === 'string' && p.className.includes('rounded-lg'),
  )
}

describe('InputComposer — composer pill motion contract', () => {
  it('renders the pill as a plain element: no motion node to measure per keystroke', () => {
    render(<InputComposer onSubmit={() => {}} />)
    expect(document.querySelector('[data-composer-pill]')).not.toBeNull()
    expect(findPill()).toBeUndefined()
  })
})
