import { describe, expect, it, mock } from 'bun:test'
import { render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'

mock.module('@tanstack/react-router', () => ({
  Link: ({ children }: { children: React.ReactNode }) => children,
}))

import { AgentTopbar } from '@/components/AgentTopbar'

describe('AgentTopbar', () => {
  it('renders the token meter when tokens is provided with zero usage', () => {
    render(
      <AgentTopbar
        tokens={{ input: 0, output: 0, cached: 0 }}
      />,
    )

    expect(screen.getByRole('button', { name: /Input: 0/i })).toBeInTheDocument()
  })

  it('renders the token meter when tokens has non-zero usage', () => {
    render(
      <AgentTopbar
        tokens={{ input: 1200, output: 300, cached: 100 }}
      />,
    )

    expect(screen.getByRole('button', { name: /Input: 1,200/i })).toBeInTheDocument()
  })

  it('hides the token meter when tokens is omitted', () => {
    render(<AgentTopbar />)

    expect(screen.queryByRole('button', { name: /Input:/i })).not.toBeInTheDocument()
  })

  it('does not render the token meter when isMobile is true', () => {
    render(
      <AgentTopbar
        isMobile={true}
        tokens={{ input: 0, output: 0 }}
      />,
    )

    expect(screen.queryByRole('button', { name: /Input:/i })).not.toBeInTheDocument()
  })
})
