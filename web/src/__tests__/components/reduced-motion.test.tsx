/**
 * `prefers-reduced-motion` contract for framer-motion driven components.
 *
 * The global CSS guard in `index.css` zeroes `animation-duration` and
 * `transition-duration`, but framer animates via JS-driven inline transforms
 * that CSS cannot reach. Every component that moves something therefore has to
 * branch on the hook itself — these tests pin that it does.
 *
 * The framer stub here records props instead of dropping them (setup.ts's stub
 * strips them), so the assertions can inspect what each component asked for.
 */
import { describe, it, expect, afterEach, mock } from 'bun:test'
import React from 'react'

/** Props captured from every rendered `motion.*` element, in render order. */
const captured: Array<Record<string, unknown>> = []

const motionCache: Record<string, React.FC> = {}
mock.module('framer-motion', () => ({
  AnimatePresence: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  motion: new Proxy(
    {},
    {
      get: (_t, tag: string) => {
        if (!motionCache[tag]) {
          motionCache[tag] = ({
            children,
            ...props
          }: { children?: React.ReactNode } & Record<string, unknown>) => {
            captured.push({ __tag: tag, ...props })
            const domProps: Record<string, unknown> = {}
            for (const [k, v] of Object.entries(props)) {
              if (
                k === 'className' ||
                k === 'style' ||
                k === 'role' ||
                k.startsWith('data-') ||
                k.startsWith('aria-')
              ) {
                domProps[k] = v
              }
            }
            return React.createElement(tag, domProps, children)
          }
        }
        return motionCache[tag]
      },
    },
  ),
  useDragControls: () => ({ start: () => {}, subscribe: () => () => {} }),
  useMotionValue: (v: unknown) => ({ get: () => v, set: () => {}, onChange: () => () => {} }),
  useTransform: () => 0,
}))

/** Drives every component under test into its reduced-motion branch. */
mock.module('@/hooks/useReducedMotion', () => ({ useReducedMotion: () => true }))

const { render, cleanup, screen } = await import('@testing-library/react')
const userEvent = (await import('@testing-library/user-event')).default
const { ToolCall } = await import('@/components/ToolCall')
const { MobileChatActions } = await import('@/components/TeamChatView/MobileChatActions')
const { SettingsPage } = await import('@/components/settings/SettingsPage')

afterEach(() => {
  cleanup()
  captured.length = 0
})

/** Keys that move a node on screen. None may survive reduced motion. */
const MOVEMENT_KEYS = ['x', 'y', 'scale', 'scaleX', 'scaleY', 'rotate', 'height']

function expectNoMovement(target: unknown) {
  // Asserted, not skipped — a missing/!object target would otherwise make
  // every check below pass vacuously.
  expect(typeof target).toBe('object')
  expect(target).not.toBeNull()
  for (const key of MOVEMENT_KEYS) {
    expect(target).not.toHaveProperty(key)
  }
}

describe('reduced motion — ToolCall disclosure', () => {
  it('snaps the details open instead of animating height', async () => {
    const user = userEvent.setup()
    render(<ToolCall name="Bash" args="ls -la" done result="total 0" />)

    // The disclosure toggle is the tool header button (first in the row).
    await user.click(screen.getAllByRole('button')[0]!)

    const details = captured.find((p) => p.className === 'overflow-hidden')
    expect(details).toBeDefined()
    expect(details!.transition).toMatchObject({ duration: 0 })
  })
})

describe('reduced motion — SettingsPage save bar', () => {
  const dirtyDraft = {
    dirty: true,
    canSave: true,
    isSaving: false,
    save: async () => {},
    reset: () => {},
  }

  /** The save bar is the only motion element SettingsPage renders. */
  function findSaveBar() {
    return captured.find(
      (p) => typeof p.className === 'string' && p.className.includes('sticky bottom-0'),
    )
  }

  it('fades the bar in rather than sliding it up from off-screen', () => {
    render(
      <SettingsPage title="Test" draft={dirtyDraft}>
        <div />
      </SettingsPage>,
    )

    const bar = findSaveBar()
    expect(bar).toBeDefined()
    expect(bar!.initial).toEqual({ opacity: 0 })
    expect(bar!.exit).toEqual({ opacity: 0 })
    expect(bar!.transition).toMatchObject({ duration: 0 })
    expectNoMovement(bar!.initial)
    expectNoMovement(bar!.animate)
  })
})

describe('reduced motion — MobileChatActions drawer', () => {
  const props = {
    open: true,
    onOpenChange: () => {},
    workspace: '/repo/app',
    activeAgent: null,
    agents: [],
    onSelectAgent: () => {},
    onScheduler: () => {},
  }

  it('fades the drawer in rather than sliding it 280px', () => {
    render(<MobileChatActions {...props} />)

    const drawer = captured.find((p) => p.__tag === 'aside')
    expect(drawer).toBeDefined()
    expect(drawer!.initial).toEqual({ opacity: 0 })
    expect(drawer!.exit).toEqual({ opacity: 0 })
    expect(drawer!.transition).toMatchObject({ duration: 0 })
  })

  it('still tracks the finger while an edge-swipe drag is in flight', () => {
    render(<MobileChatActions {...props} dragOffset={120} />)

    const drawer = captured.find((p) => p.__tag === 'aside')
    expect(drawer!.animate).toMatchObject({ x: 120 })
  })

  it('applies no residual transform when idle', () => {
    render(<MobileChatActions {...props} />)

    const drawer = captured.find((p) => p.__tag === 'aside')
    expectNoMovement(drawer!.initial)
    expectNoMovement(drawer!.exit)
  })
})
