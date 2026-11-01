import { afterEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import userEvent from '@testing-library/user-event'

import { CommandCenterButton } from '@/components/AgentChatView/CommandCenterButton'

afterEach(cleanup)

const classes = (el: Element) => (el.getAttribute('class') ?? '').split(/\s+/)

describe('CommandCenterButton', () => {
  it('names itself "Command palette (shortcut)"', () => {
    render(<CommandCenterButton onClick={() => {}} />)

    expect(screen.getByRole('button', { name: /^Command palette \(.+\)$/ })).toBeInTheDocument()
    expect(screen.queryByText(/Search or run a command/)).not.toBeInTheDocument()
  })

  it('shows a search pill with the label and the shortcut from md up, and only the icon below', () => {
    render(<CommandCenterButton onClick={() => {}} />)
    const button = screen.getByRole('button', { name: /^Command palette/ })
    const label = screen.getByText('Command palette')
    const hint = button.querySelector('kbd') as HTMLElement

    // Below md: a 28px icon button. From md: a full-width pill.
    expect(classes(button)).toContain('w-7')
    expect(classes(button)).toContain('md:w-full')
    expect(classes(button)).toContain('md:justify-start')
    for (const el of [label, hint]) {
      expect(classes(el)).toContain('hidden')
      expect(classes(el)).toContain('md:inline')
      // The label no longer waits for lg.
      expect(classes(el).some((c) => c.startsWith('lg:'))).toBe(false)
    }
    expect(button.querySelector('svg')).not.toBeNull()
    expect(hint.textContent).toBe(button.getAttribute('aria-label')?.match(/\((.+)\)$/)?.[1])
  })

  it('is a filled pill, not a bordered one', () => {
    render(<CommandCenterButton onClick={() => {}} />)
    const button = screen.getByRole('button', { name: /^Command palette/ })
    const hint = button.querySelector('kbd') as HTMLElement

    expect(classes(button)).toContain('md:bg-(--bg-key)')
    for (const el of [button, hint]) {
      expect(classes(el).filter((c) => /^(?:[\w-]+:)*border(?:-[trblxy])?(?:-\d)?$/.test(c))).toEqual([])
    }
  })

  it('keeps a 36px hit area on touch, without shrinking the pill on a tablet', () => {
    render(<CommandCenterButton onClick={() => {}} />)
    const button = screen.getByRole('button', { name: /^Command palette/ })

    expect(classes(button)).toContain('pointer-coarse:h-9')
    expect(classes(button)).toContain('pointer-coarse:min-w-9')
    // ``pointer-coarse:`` sorts after ``md:``: a coarse width would beat ``md:w-full``.
    expect(classes(button).filter((c) => /^pointer-coarse:(?:size|w)-/.test(c))).toEqual([])
    expect(classes(button)).toContain('md:w-full')
  })

  it('opens the palette on click, and names it in its tooltip', async () => {
    const user = userEvent.setup()
    const onClick = mock(() => {})
    render(<CommandCenterButton onClick={onClick} />)
    const button = screen.getByRole('button', { name: /^Command palette/ })

    await user.hover(button)
    expect(await screen.findByRole('tooltip')).toHaveTextContent(/^Command palette \(.+\)/)
    await user.click(button)
    expect(onClick).toHaveBeenCalledTimes(1)
  })
})
