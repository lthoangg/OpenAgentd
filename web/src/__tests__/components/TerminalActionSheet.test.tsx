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
})
