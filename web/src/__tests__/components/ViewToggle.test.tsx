import { describe, it, expect, mock, afterEach } from 'bun:test'
import { render, screen, cleanup } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ViewToggle } from '@/components/ui/view-toggle'

afterEach(cleanup)

describe('ViewToggle', () => {
  it('renders a single toggle button', () => {
    const onValueChange = mock()
    render(<ViewToggle value="agent" onValueChange={onValueChange} />)

    const buttons = screen.getAllByRole('button')
    expect(buttons).toHaveLength(1)
    expect(screen.queryByRole('radiogroup')).toBeNull()
  })

  it('shows switch to split view when in agent view and toggles on click', async () => {
    const user = userEvent.setup()
    const onValueChange = mock()
    render(<ViewToggle value="agent" onValueChange={onValueChange} />)

    const button = screen.getByRole('button', { name: 'Switch to split view' })
    expect(button).toBeTruthy()
    await user.hover(button)
    expect((await screen.findByRole('tooltip')).textContent).toContain('Switch to split view')

    await user.click(button)
    expect(onValueChange).toHaveBeenCalledTimes(1)
    expect(onValueChange).toHaveBeenCalledWith('split')
  })

  it('shows switch to agent view when in split view and toggles on click', async () => {
    const user = userEvent.setup()
    const onValueChange = mock()
    render(<ViewToggle value="split" onValueChange={onValueChange} />)

    const button = screen.getByRole('button', { name: 'Switch to agent view' })
    expect(button).toBeTruthy()
    await user.hover(button)
    expect((await screen.findByRole('tooltip')).textContent).toContain('Switch to agent view')

    await user.click(button)
    expect(onValueChange).toHaveBeenCalledTimes(1)
    expect(onValueChange).toHaveBeenCalledWith('agent')
  })

  it('applies custom className', () => {
    const onValueChange = mock()
    render(<ViewToggle value="agent" onValueChange={onValueChange} className="custom-class" />)

    const button = screen.getByRole('button')
    expect(button.classList.contains('custom-class')).toBe(true)
  })

  it('renders with compact layout when compact prop is true', () => {
    const onValueChange = mock()
    render(<ViewToggle value="agent" onValueChange={onValueChange} compact />)

    const button = screen.getByRole('button')
    expect(button.className).toContain('h-5')
    expect(button.className).toContain('w-5')
    expect(button.className).toContain('rounded-xs')
  })
})
