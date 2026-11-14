import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom'

mock.module('lucide-react', () => new Proxy({}, { get: () => () => null }))
mock.module('@tauri-apps/api/core', () => ({
  invoke: async (_command: string, args?: { version?: string }) => {
    if (args?.version === '0.0.0') throw new Error('offline')
    return {
      version: args?.version,
      url: `https://github.com/openagentd/openagentd/releases/tag/v${args?.version}`,
      body: `# Release ${args?.version}`,
    }
  },
}))
const openExternalUrlMock = mock(async (_url: unknown) => {})
mock.module('@/lib/open-external', () => ({ openExternalUrl: openExternalUrlMock }))
mock.module('@/utils/markdown', () => ({
  MarkdownBlock: ({ content }: { content: string }) => <div>{content}</div>,
}))

import { ReleaseNotesButton } from '@/components/ReleaseNotesDialog'

beforeEach(() => openExternalUrlMock.mockClear())
afterEach(cleanup)

describe('ReleaseNotesButton', () => {
  it('marks the release-notes overlay data-swipe-ignore', async () => {
    render(<ReleaseNotesButton version="1.71.0" />)

    await userEvent.click(screen.getByRole('button', { name: /see release notes/i }))

    const dialog = await waitFor(() => screen.getByRole('dialog', { name: /release notes/i }))
    expect(dialog).toHaveAttribute('data-swipe-ignore')
  })

  it('closes the dialog on Escape and returns focus to its trigger', async () => {
    render(<ReleaseNotesButton version="1.71.0" />)
    const trigger = screen.getByRole('button', { name: /see release notes/i })
    await userEvent.click(trigger)
    await waitFor(() => screen.getByRole('dialog', { name: /release notes/i }))

    act(() => {
      // Real key presses bubble to `window`, where the keyboard dispatcher listens.
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })

    await waitFor(() => expect(trigger).toHaveFocus())
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 150))
    })
    expect(screen.queryByRole('dialog', { name: /release notes/i })).not.toBeInTheDocument()
  })

  it('opens the GitHub release page via openExternalUrl', async () => {
    render(<ReleaseNotesButton version="1.71.0" />)

    await userEvent.click(screen.getByRole('button', { name: /see release notes/i }))
    await userEvent.click(await screen.findByRole('link', { name: /view in github/i }))

    expect(openExternalUrlMock).toHaveBeenCalledWith('https://github.com/openagentd/openagentd/releases/tag/v1.71.0')
  })

  it('says it couldn\'t load the notes, in the one spelling failures use', async () => {
    render(<ReleaseNotesButton version="0.0.0" />)

    await userEvent.click(screen.getByRole('button', { name: /see release notes/i }))

    expect(await screen.findByText(/Couldn't load GitHub release notes: offline/)).toBeInTheDocument()
    expect(screen.queryByText(/Could not/)).not.toBeInTheDocument()
  })
})
