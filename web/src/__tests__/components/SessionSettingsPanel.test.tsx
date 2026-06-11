import { afterEach, describe, expect, it, mock } from 'bun:test'
import type React from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

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
  useTeamAgentsQuery: () => ({
    data: {
      agents: [{
        name: 'lead',
        description: 'Lead agent',
        model: 'openai:gpt-4.1',
        tools: [],
        skills: [],
        capabilities: {
          input: { vision: false, document_text: false, audio: false, video: false },
          output: { text: true, image: false, audio: false },
        },
        is_lead: true,
      }],
    },
    isLoading: false,
    refetch,
  }),
}))

mock.module('@/queries', () => ({
  useRegistryQuery: () => ({
    data: { providers: [], models: [{ id: 'openai:gpt-4.1' }, { id: 'openai:gpt-4.2' }] },
    isLoading: false,
  }),
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

  it('supports touch pointer selection in the model picker', () => {
    const onChange = mock(() => {})
    render(
      <SessionSettingsPanel
        open
        onClose={() => {}}
        onSessionModelSettingsChange={onChange}
      />,
    )

    const modelInput = screen.getByRole('combobox', { name: /search session model/i })
    fireEvent.change(modelInput, { target: { value: '4.2' } })
    const modelOption = screen
      .getAllByRole('button')
      .find((button) => button.textContent === 'openai:gpt-4.2')
    expect(modelOption).toBeTruthy()
    fireEvent.pointerEnter(modelOption!, { pointerType: 'touch' })
    fireEvent.pointerDown(modelOption!, { pointerType: 'touch' })
    fireEvent.click(modelOption!)
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(onChange).toHaveBeenCalledWith('openai:gpt-4.2', null, false)
  })

  it('supports touch pointer selection in the thinking picker', () => {
    const onChange = mock(() => {})
    render(
      <SessionSettingsPanel
        open
        onClose={() => {}}
        onSessionModelSettingsChange={onChange}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: /thinking level/i }))
    const highOption = screen.getAllByRole('option').find((option) => option.textContent === 'High')
    expect(highOption).toBeTruthy()
    fireEvent.pointerEnter(highOption!, { pointerType: 'touch' })
    fireEvent.pointerDown(highOption!, { pointerType: 'touch' })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(onChange).toHaveBeenCalledWith(null, 'high', false)
  })

  it('clears pending model picker close timers on refocus and unmount', () => {
    const originalClearTimeout = window.clearTimeout
    const clearTimeout = mock((...args: unknown[]) => originalClearTimeout(args[0] as number | undefined))
    window.clearTimeout = clearTimeout as typeof window.clearTimeout

    try {
      const view = render(
        <SessionSettingsPanel
          open
          onClose={() => {}}
          onSessionModelSettingsChange={() => {}}
        />,
      )
      const modelInput = screen.getByRole('combobox', { name: /search session model/i })

      fireEvent.focus(modelInput)
      fireEvent.blur(modelInput)
      fireEvent.focus(modelInput)
      fireEvent.blur(modelInput)
      view.unmount()

      expect(clearTimeout).toHaveBeenCalledTimes(2)
    } finally {
      window.clearTimeout = originalClearTimeout
    }
  })
})
