import { afterEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, render, screen } from '@testing-library/react'

let healthState = { isSuccess: true, isError: false }
let teamStatusState: { isSuccess: boolean; isError: boolean; data: null } = {
  isSuccess: false,
  isError: false,
  data: null,
}

mock.module('@/assets/brand/openagentd-app-icon.png', () => ({
  default: 'openagentd-app-icon.png',
}))

mock.module('@/queries/useHealthQuery', () => ({
  useHealthQuery: () => healthState,
}))

mock.module('@/queries/useTeamStatusQuery', () => ({
  useTeamStatusQuery: () => teamStatusState,
}))

mock.module('@/hooks/useReducedMotion', () => ({
  useReducedMotion: () => true,
}))

mock.module('framer-motion', () => ({
  motion: new Proxy({}, { get: () => ({ children, ...props }: React.PropsWithChildren<Record<string, unknown>>) => <div {...props}>{children}</div> }),
  AnimatePresence: ({ children }: React.PropsWithChildren) => <>{children}</>,
}))

import { Welcome } from '@/components/Welcome'

afterEach(() => {
  cleanup()
  healthState = { isSuccess: true, isError: false }
  teamStatusState = { isSuccess: false, isError: false, data: null }
})

describe('Welcome', () => {
  it('shows an error state when team status fails after health succeeds', () => {
    teamStatusState = { isSuccess: false, isError: true, data: null }

    render(<Welcome onReady={() => {}} />)

    expect(screen.getByText('Failed to connect to backend')).toBeTruthy()
  })
})
