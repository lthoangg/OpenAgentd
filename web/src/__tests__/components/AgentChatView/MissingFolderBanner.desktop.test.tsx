/**
 * On desktop the missing-folder notice is one line under the header too
 * (desktop mockup 12.3), not a card over the transcript: the folder's name,
 * Open workspace… and Hide from sidebar; the full path is the tooltip.
 */
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

mock.module('@/hooks/use-is-phone', () => ({ useIsPhone: () => false }))
mock.module('@tanstack/react-router', () => ({ useNavigate: () => () => {} }))

const { MissingFolderBanner } = await import('@/components/AgentChatView/MissingFolderBanner')

afterEach(cleanup)

describe('MissingFolderBanner on desktop', () => {
  it('is one line naming the folder, with its two ways out', () => {
    const onOpenFolder = mock(() => {})
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MissingFolderBanner workspace="/Users/me/code/design-demo" onOpenFolder={onOpenFolder} />
      </QueryClientProvider>,
    )
    const banner = screen.getByRole('status')
    expect(banner.textContent).toContain('design-demo was moved or deleted')
    expect(banner.querySelector('.truncate')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Open workspace…' }))
    expect(onOpenFolder).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: 'Hide from sidebar' })).toBeTruthy()
  })
})
