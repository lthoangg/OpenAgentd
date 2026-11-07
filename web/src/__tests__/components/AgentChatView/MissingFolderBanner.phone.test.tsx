/**
 * A phone shows the missing-folder notice as one line under the bar with a
 * single Fix; the path and the choices open in an action sheet (mockup C8).
 */
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

mock.module('@/hooks/use-is-phone', () => ({ useIsPhone: () => true }))
mock.module('@tanstack/react-router', () => ({ useNavigate: () => () => {} }))

const { MissingFolderBanner } = await import('@/components/AgentChatView/MissingFolderBanner')

afterEach(cleanup)

describe('MissingFolderBanner on a phone', () => {
  it('is one line with Fix, and Fix offers the path and the two ways out', () => {
    const onOpenFolder = mock(() => {})
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MissingFolderBanner workspace="/Users/me/gone" onOpenFolder={onOpenFolder} />
      </QueryClientProvider>,
    )
    const banner = screen.getByRole('status')
    expect(banner.textContent).toContain('Folder was moved or deleted')
    expect(banner.textContent).not.toContain('/Users/me/gone')

    fireEvent.click(screen.getByRole('button', { name: 'Fix' }))
    const sheet = document.querySelector<HTMLElement>('[data-action-sheet]')!
    expect(sheet.textContent).toContain('/Users/me/gone')
    fireEvent.click(sheet.querySelector('[data-action-sheet-item="open"]')!)
    expect(onOpenFolder).toHaveBeenCalledTimes(1)
  })
})
