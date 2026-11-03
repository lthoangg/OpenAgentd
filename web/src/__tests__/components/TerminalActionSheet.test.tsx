import '@testing-library/jest-dom'
import { describe, expect, it, mock } from 'bun:test'
import { fireEvent, render, screen } from '@testing-library/react'
import { TerminalActionSheet } from '@/components/Terminal/TerminalActionSheet'

describe('TerminalActionSheet', () => {
  it('renders Select All, Copy, Paste when open', () => {
    render(
      <TerminalActionSheet
        open
        onOpenChange={() => {}}
        hasSelection
        onSelectAll={() => {}}
        onCopy={() => {}}
        onPaste={() => {}}
      />,
    )
    expect(screen.getByRole('button', { name: 'Select All' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Copy' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Paste' })).toBeTruthy()
  })

  it('disables Copy when there is no active selection', () => {
    render(
      <TerminalActionSheet
        open
        onOpenChange={() => {}}
        hasSelection={false}
        onSelectAll={() => {}}
        onCopy={() => {}}
        onPaste={() => {}}
      />,
    )
    expect(screen.getByRole('button', { name: 'Copy' })).toBeDisabled()
  })

  it('invokes the matching callback for each action', () => {
    const onSelectAll = mock(() => {})
    const onCopy = mock(() => {})
    const onPaste = mock(() => {})
    render(
      <TerminalActionSheet
        open
        onOpenChange={() => {}}
        hasSelection
        onSelectAll={onSelectAll}
        onCopy={onCopy}
        onPaste={onPaste}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Select All' }))
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }))
    fireEvent.click(screen.getByRole('button', { name: 'Paste' }))
    expect(onSelectAll).toHaveBeenCalledTimes(1)
    expect(onCopy).toHaveBeenCalledTimes(1)
    expect(onPaste).toHaveBeenCalledTimes(1)
  })

  it('renders nothing when closed', () => {
    render(
      <TerminalActionSheet
        open={false}
        onOpenChange={() => {}}
        hasSelection
        onSelectAll={() => {}}
        onCopy={() => {}}
        onPaste={() => {}}
      />,
    )
    expect(screen.queryByRole('button', { name: 'Select All' })).toBeNull()
  })

  it('offers Find and Add to chat when wired, and runs them', () => {
    const onFind = mock(() => {})
    const onAddToChat = mock(() => {})
    render(
      <TerminalActionSheet
        open
        onOpenChange={() => {}}
        hasSelection
        onSelectAll={() => {}}
        onCopy={() => {}}
        onPaste={() => {}}
        onFind={onFind}
        onAddToChat={onAddToChat}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Find' }))
    fireEvent.click(screen.getByRole('button', { name: 'Add to chat' }))
    expect(onFind).toHaveBeenCalledTimes(1)
    expect(onAddToChat).toHaveBeenCalledTimes(1)
  })

  it('disables Add to chat without a selection', () => {
    render(
      <TerminalActionSheet
        open
        onOpenChange={() => {}}
        hasSelection={false}
        onSelectAll={() => {}}
        onCopy={() => {}}
        onPaste={() => {}}
        onFind={() => {}}
        onAddToChat={() => {}}
      />,
    )
    expect(screen.getByRole('button', { name: 'Add to chat' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Find' })).not.toBeDisabled()
  })

  it('hides Find and Add to chat when they are not wired', () => {
    render(
      <TerminalActionSheet
        open
        onOpenChange={() => {}}
        hasSelection
        onSelectAll={() => {}}
        onCopy={() => {}}
        onPaste={() => {}}
      />,
    )
    expect(screen.queryByRole('button', { name: 'Find' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Add to chat' })).toBeNull()
  })
})
