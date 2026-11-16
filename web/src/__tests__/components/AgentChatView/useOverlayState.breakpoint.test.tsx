/**
 * useOverlayState — crossing the phone breakpoint while mounted.
 *
 * ``isMobile`` follows a live media query, so a desktop window resized below
 * the phone breakpoint flips it without remounting the chat view. The hook
 * must call the same hooks in the same order on both sides of the flip, or
 * React throws and the chat view is lost.
 */
import { afterEach, describe, expect, it, mock } from 'bun:test'
import type React from 'react'
import { cleanup, renderHook } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useOverlayState, type UseOverlayStateArgs } from '@/components/AgentChatView/useOverlayState'

function wrapper({ children }: { children: React.ReactNode }) {
  return <QueryClientProvider client={new QueryClient()}>{children}</QueryClientProvider>
}

function args(isMobile: boolean): UseOverlayStateArgs {
  return {
    isMobile,
    workspace: '/repo/project',
    toggleScheduler: mock(() => {}),
    toggleRunPicker: mock(() => {}),
    togglePalette: mock(() => {}),
    toggleQuickOpen: mock(() => {}),
  }
}

afterEach(cleanup)

describe('useOverlayState across the phone breakpoint', () => {
  it('keeps rendering when a desktop window narrows to a phone layout', () => {
    const { result, rerender } = renderHook((props: UseOverlayStateArgs) => useOverlayState(props), {
      wrapper,
      initialProps: args(false),
    })

    expect(() => rerender(args(true))).not.toThrow()
    expect(result.current.sidebarDrawer).toBe(false)
  })

  it('keeps rendering when a phone layout widens back to desktop', () => {
    const { result, rerender } = renderHook((props: UseOverlayStateArgs) => useOverlayState(props), {
      wrapper,
      initialProps: args(true),
    })
    expect(result.current.sidebarDrawer).toBe(false)

    expect(() => rerender(args(false))).not.toThrow()
    expect(typeof result.current.sidebarDrawer).toBe('boolean')
  })
})
