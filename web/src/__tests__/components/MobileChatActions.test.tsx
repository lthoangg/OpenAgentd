import { afterEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'

mock.module('lucide-react', () => new Proxy({}, { get: () => () => null }))

import { MobileChatActions } from '@/components/AgentChatView/MobileChatActions'

afterEach(cleanup)

describe('MobileChatActions', () => {
  it('stays visible on a landscape phone, wider than md, and clears a right cutout', () => {
    render(<MobileChatActions open onOpenChange={() => {}} workspace="/repo/app" onScheduler={() => {}} />)

    const drawer = screen.getByRole('dialog', { name: 'Chat actions' })
    expect(drawer.className.split(' ')).not.toContain('md:hidden')
    expect(drawer.className.split(' ')).toContain('pr-safe')
    const backdrop = document.querySelector('.bg-\\(--color-overlay\\)')
    expect(backdrop?.className.split(' ')).not.toContain('md:hidden')
  })

  it('exposes the terminal action to touch users', () => {
    const onOpenTerminal = mock(() => {})

    render(
      <MobileChatActions
        open
        onOpenChange={() => {}}
        workspace="/repo/app"
        onScheduler={() => {}}
        onOpenTerminal={onOpenTerminal}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Open terminal' }))

    expect(onOpenTerminal).toHaveBeenCalledTimes(1)
  })

  it('disables the terminal action when the active workspace cannot open one', () => {
    render(
      <MobileChatActions
        open
        onOpenChange={() => {}}
        workspace="/Users/name"
        onScheduler={() => {}}
      />,
    )

    expect(screen.getByRole('button', { name: 'Open terminal' })).toBeDisabled()
  })

  it('gives touch users prompt stepping, file search, and the command palette', () => {
    const onPreviousPrompt = mock(() => {})
    const onNextPrompt = mock(() => {})
    const onQuickOpen = mock(() => {})
    const onCommandPalette = mock(() => {})

    render(
      <MobileChatActions
        open
        onOpenChange={() => {}}
        workspace="/repo/app"
        onScheduler={() => {}}
        onPreviousPrompt={onPreviousPrompt}
        onNextPrompt={onNextPrompt}
        onQuickOpen={onQuickOpen}
        onCommandPalette={onCommandPalette}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Previous prompt' }))
    fireEvent.click(screen.getByRole('button', { name: 'Next prompt' }))
    fireEvent.click(screen.getByRole('button', { name: 'Search files' }))
    fireEvent.click(screen.getByRole('button', { name: 'Command palette' }))

    expect(onPreviousPrompt).toHaveBeenCalledTimes(1)
    expect(onNextPrompt).toHaveBeenCalledTimes(1)
    expect(onQuickOpen).toHaveBeenCalledTimes(1)
    expect(onCommandPalette).toHaveBeenCalledTimes(1)
  })

  it('disables prompt stepping and file search when there is nothing to step or search', () => {
    render(
      <MobileChatActions
        open
        onOpenChange={() => {}}
        workspace={null}
        onScheduler={() => {}}
      />,
    )

    for (const name of ['Previous prompt', 'Next prompt', 'Search files', 'Command palette']) {
      expect(screen.getByRole('button', { name })).toBeDisabled()
    }
  })
})
