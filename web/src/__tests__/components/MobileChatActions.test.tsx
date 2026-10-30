import { afterEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'

mock.module('lucide-react', () => new Proxy({}, { get: () => () => null }))

import { MobileChatActions } from '@/components/AgentChatView/MobileChatActions'

afterEach(cleanup)

const base = {
  open: true,
  onOpenChange: () => {},
  title: 'Fix the login bug',
  subtitle: 'app',
  onScheduler: () => {},
  onSessionSettings: () => {},
}

describe('MobileChatActions', () => {
  it('stays visible on a landscape phone, wider than md, and clears a right cutout', () => {
    render(<MobileChatActions {...base} />)

    const drawer = screen.getByRole('dialog', { name: 'More actions' })
    expect(drawer.className.split(' ')).not.toContain('md:hidden')
    expect(drawer.className.split(' ')).toContain('pr-safe')
    const backdrop = document.querySelector('.bg-\\(--color-overlay\\)')
    expect(backdrop?.className.split(' ')).not.toContain('md:hidden')
  })

  it('names the session and its workspace at the top of the sheet', () => {
    render(<MobileChatActions {...base} />)

    const drawer = screen.getByRole('dialog', { name: 'More actions' })
    expect(drawer).toHaveTextContent('Fix the login bug')
    expect(drawer).toHaveTextContent('app')
  })

  it('groups actions under Session, Workspace and App', () => {
    render(<MobileChatActions {...base} />)

    const drawer = screen.getByRole('dialog', { name: 'More actions' })
    const text = drawer.textContent ?? ''
    expect(text.indexOf('Session')).toBeLessThan(text.indexOf('Workspace'))
    expect(text.indexOf('Workspace')).toBeLessThan(text.indexOf('App'))
  })

  it('exposes the terminal action to touch users', () => {
    const onOpenTerminal = mock(() => {})

    render(<MobileChatActions {...base} onOpenTerminal={onOpenTerminal} />)

    fireEvent.click(screen.getByRole('button', { name: 'Terminal' }))

    expect(onOpenTerminal).toHaveBeenCalledTimes(1)
  })

  it('disables the terminal action when the active workspace cannot open one', () => {
    render(<MobileChatActions {...base} />)

    expect(screen.getByRole('button', { name: 'Terminal' })).toBeDisabled()
  })

  it('gives touch users tasks, session settings, prompt stepping, file search, and the command palette', () => {
    const onTasks = mock(() => {})
    const onSessionSettings = mock(() => {})
    const onPreviousPrompt = mock(() => {})
    const onNextPrompt = mock(() => {})
    const onQuickOpen = mock(() => {})
    const onCommandPalette = mock(() => {})

    render(
      <MobileChatActions
        {...base}
        onTasks={onTasks}
        onSessionSettings={onSessionSettings}
        onPreviousPrompt={onPreviousPrompt}
        onNextPrompt={onNextPrompt}
        onQuickOpen={onQuickOpen}
        onCommandPalette={onCommandPalette}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Tasks' }))
    fireEvent.click(screen.getByRole('button', { name: 'Session settings' }))
    fireEvent.click(screen.getByRole('button', { name: 'Previous prompt' }))
    fireEvent.click(screen.getByRole('button', { name: 'Next prompt' }))
    fireEvent.click(screen.getByRole('button', { name: 'Find file' }))
    fireEvent.click(screen.getByRole('button', { name: 'Command palette' }))

    expect(onTasks).toHaveBeenCalledTimes(1)
    expect(onSessionSettings).toHaveBeenCalledTimes(1)
    expect(onPreviousPrompt).toHaveBeenCalledTimes(1)
    expect(onNextPrompt).toHaveBeenCalledTimes(1)
    expect(onQuickOpen).toHaveBeenCalledTimes(1)
    expect(onCommandPalette).toHaveBeenCalledTimes(1)
  })

  it('disables tasks, prompt stepping and file search when there is nothing to act on', () => {
    render(<MobileChatActions {...base} />)

    for (const name of ['Tasks', 'Previous prompt', 'Next prompt', 'Find file', 'Command palette']) {
      expect(screen.getByRole('button', { name })).toBeDisabled()
    }
  })

  it('carries the open-task count on the More button and the Tasks row', () => {
    render(<MobileChatActions {...base} open={false} openTasks={3} onTasks={() => {}} />)

    expect(screen.getByRole('button', { name: 'More actions, 3 open tasks' })).toHaveTextContent('3')
  })

  it('shows context use with its unit and the summarize threshold', () => {
    render(<MobileChatActions {...base} tokens={{ input: 50_000, output: 1_000, trigger: 100_000 } as never} />)

    const drawer = screen.getByRole('dialog', { name: 'More actions' })
    expect(drawer).toHaveTextContent('Context (tokens)')
    expect(drawer).toHaveTextContent('50%')
    expect(drawer).toHaveTextContent('Older messages are summarized')
  })
})
