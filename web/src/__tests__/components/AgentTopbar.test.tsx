import { describe, expect, it, mock } from 'bun:test'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import '@testing-library/jest-dom'
import { ListTodo, PanelRight } from 'lucide-react'

mock.module('@tanstack/react-router', () => ({
  Link: ({ children }: { children: React.ReactNode }) => children,
}))

import { AgentTopbar } from '@/components/AgentTopbar'

describe('AgentTopbar', () => {
  it('renders only its actions: no token meter, the context ring lives on the run deck', () => {
    const { container } = render(
      <AgentTopbar
        todosAction={{ Icon: ListTodo, onClick: () => {}, ariaLabel: 'Tasks' }}
        filesAction={{ Icon: PanelRight, onClick: () => {}, ariaLabel: 'Review panel' }}
      />,
    )

    expect(Array.from(container.querySelectorAll('button')).map((b) => b.getAttribute('aria-label'))).toEqual(['Tasks', 'Review panel'])
    expect(screen.queryByRole('button', { name: /Input:/i })).not.toBeInTheDocument()
  })

  it('renders an empty cluster without actions', () => {
    const { container } = render(<AgentTopbar />)
    expect(container.querySelectorAll('button')).toHaveLength(0)
  })

  it('says what an action does in a tooltip and reflects its pressed state', async () => {
    const onClick = mock(() => {})
    render(
      <AgentTopbar
        filesAction={{ Icon: PanelRight, onClick, ariaLabel: 'Review panel', title: 'Show Review panel (Ctrl+D)', pressed: true }}
      />,
    )

    const button = screen.getByRole('button', { name: 'Review panel' })
    expect(button).toHaveAttribute('aria-pressed', 'true')
    const user = userEvent.setup()
    await user.hover(button)
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Show Review panel (Ctrl+D)')
    await user.click(button)
    expect(onClick).toHaveBeenCalledTimes(1)
  })
})
