import { afterEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'

mock.module('lucide-react', () => new Proxy({}, { get: () => () => null }))

import { MobileChatActions } from '@/components/AgentChatView/MobileChatActions'

afterEach(cleanup)

describe('MobileChatActions', () => {
  it('exposes transcript find and terminal actions to touch users', () => {
    const onFindInTranscript = mock(() => {})
    const onOpenTerminal = mock(() => {})

    render(
      <MobileChatActions
        open
        onOpenChange={() => {}}
        workspace="/repo/app"
        onScheduler={() => {}}
        onFindInTranscript={onFindInTranscript}
        onOpenTerminal={onOpenTerminal}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Find in transcript' }))
    fireEvent.click(screen.getByRole('button', { name: 'Open terminal' }))

    expect(onFindInTranscript).toHaveBeenCalledTimes(1)
    expect(onOpenTerminal).toHaveBeenCalledTimes(1)
  })

  it('disables the terminal action when the active workspace cannot open one', () => {
    render(
      <MobileChatActions
        open
        onOpenChange={() => {}}
        workspace="/Users/name"
        onScheduler={() => {}}
        onFindInTranscript={() => {}}
      />,
    )

    expect(screen.getByRole('button', { name: 'Open terminal' })).toBeDisabled()
  })
})
