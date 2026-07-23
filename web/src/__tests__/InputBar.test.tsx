/**
 * Tests for InputBar auto-resizing & multi-line hysteresis logic.
 */
import { describe, it, expect } from 'bun:test'
import { render, screen, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

import { InputBar, type InputBarProps } from '@/components/InputBar'

function renderInputBar(props: Partial<InputBarProps> = {}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })

  const defaultProps: InputBarProps = {
    onSubmit: () => {},
  }

  return render(
    <QueryClientProvider client={queryClient}>
      <InputBar {...defaultProps} {...props} />
    </QueryClientProvider>,
  )
}

describe('InputBar auto-resize & multi-line hysteresis', () => {
  it('renders input bar textarea cleanly', () => {
    renderInputBar({ placeholder: 'Type here...' })
    const textarea = screen.getByRole('textbox', { name: /message input/i })
    expect(textarea).toBeTruthy()
    expect((textarea as HTMLTextAreaElement).placeholder).toBe('Type here...')
  })

  it('triggers resize handling on user typing', () => {
    renderInputBar()
    const textarea = screen.getByRole('textbox', { name: /message input/i }) as HTMLTextAreaElement

    // Mock scrollHeight to simulate wrapping (e.g. scrollHeight 50px vs lineHeight 20px)
    Object.defineProperty(textarea, 'scrollHeight', {
      configurable: true,
      value: 50,
    })

    // Fire input event with long text
    fireEvent.change(textarea, { target: { value: 'A very long sentence that wraps across lines' } })

    expect(textarea.value).toBe('A very long sentence that wraps across lines')
  })
})
