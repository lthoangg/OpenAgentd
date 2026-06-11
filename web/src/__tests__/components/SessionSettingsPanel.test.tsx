import { afterEach, describe, expect, it, mock } from 'bun:test'
import type React from 'react'
import { cleanup, render } from '@testing-library/react'

const refetch = mock(() => {})

mock.module('framer-motion', () => ({
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  motion: {
    div: ({ children, initial, animate, exit, transition, ...props }: React.ComponentProps<'div'> & { initial?: unknown; animate?: unknown; exit?: unknown; transition?: unknown }) => {
      void initial
      void animate
      void exit
      void transition
      return <div {...props}>{children}</div>
    },
    aside: ({ children, initial, animate, exit, transition, ...props }: React.ComponentProps<'aside'> & { initial?: unknown; animate?: unknown; exit?: unknown; transition?: unknown }) => {
      void initial
      void animate
      void exit
      void transition
      return <aside {...props}>{children}</aside>
    },
  },
}))

mock.module('@/queries/useAgentsQuery', () => ({
  useTeamAgentsQuery: () => ({ data: { agents: [] }, isLoading: false, refetch }),
}))

mock.module('@/queries', () => ({
  useRegistryQuery: () => ({ data: { providers: [] }, isLoading: false }),
}))

import { SessionSettingsPanel } from '@/components/SessionSettingsPanel'

afterEach(() => {
  cleanup()
  refetch.mockClear()
})

describe('SessionSettingsPanel', () => {
  it('refreshes agent metadata when opened', () => {
    const view = render(<SessionSettingsPanel open={false} onClose={() => {}} />)
    expect(refetch).not.toHaveBeenCalled()

    view.rerender(<SessionSettingsPanel open={true} onClose={() => {}} />)
    expect(refetch).toHaveBeenCalledTimes(1)
  })
})
