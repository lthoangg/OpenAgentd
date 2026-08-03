/**
 * Dropdown — keyboard operation.
 *
 * The panel is portalled to document.body, outside any modal focus trap, so
 * focus deliberately stays on the trigger and the active option is tracked with
 * `aria-activedescendant`. Moving focus into the portal would put it beyond the
 * trap's reach and strand keyboard users.
 */
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

mock.module('lucide-react', () => new Proxy({}, { get: () => () => null }))

import { Dropdown, DropdownItem } from '@/components/ui/dropdown'

afterEach(cleanup)

function renderSelect(value = '', onValueChange = mock(() => undefined)) {
  const result = render(
    <Dropdown value={value} onValueChange={onValueChange} trigger="Choose…" aria-label="Level">
      <DropdownItem value="low">Low</DropdownItem>
      <DropdownItem value="medium">Medium</DropdownItem>
      <DropdownItem value="high">High</DropdownItem>
    </Dropdown>,
  )
  return { ...result, onValueChange }
}

const trigger = () => screen.getByRole('button', { name: 'Level' })

/** The option currently pointed at by aria-activedescendant. */
function activeOptionText() {
  const id = trigger().getAttribute('aria-activedescendant')
  if (!id) return null
  return document.getElementById(id)?.textContent ?? null
}

describe('Dropdown — keyboard', () => {
  it('opens on ArrowDown and points at the first option', async () => {
    renderSelect()
    trigger().focus()

    await userEvent.keyboard('{ArrowDown}')

    expect(trigger().getAttribute('aria-expanded')).toBe('true')
    expect(activeOptionText()).toBe('Low')
  })

  it('opens on Enter', async () => {
    renderSelect()
    trigger().focus()

    await userEvent.keyboard('{Enter}')

    expect(trigger().getAttribute('aria-expanded')).toBe('true')
  })

  it('opens pointing at the current value, not the first option', async () => {
    renderSelect('high')
    trigger().focus()

    await userEvent.keyboard('{ArrowDown}')

    expect(activeOptionText()).toBe('High')
  })

  it('moves the active option with the arrow keys', async () => {
    renderSelect()
    trigger().focus()

    await userEvent.keyboard('{ArrowDown}{ArrowDown}')
    expect(activeOptionText()).toBe('Medium')

    await userEvent.keyboard('{ArrowDown}')
    expect(activeOptionText()).toBe('High')

    await userEvent.keyboard('{ArrowUp}')
    expect(activeOptionText()).toBe('Medium')
  })

  it('stops at the ends instead of wrapping', async () => {
    renderSelect()
    trigger().focus()

    await userEvent.keyboard('{ArrowDown}{ArrowUp}{ArrowUp}')
    expect(activeOptionText()).toBe('Low')

    await userEvent.keyboard('{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}')
    expect(activeOptionText()).toBe('High')
  })

  it('jumps to the first and last option with Home and End', async () => {
    renderSelect()
    trigger().focus()

    await userEvent.keyboard('{ArrowDown}{End}')
    expect(activeOptionText()).toBe('High')

    await userEvent.keyboard('{Home}')
    expect(activeOptionText()).toBe('Low')
  })

  it('selects the active option with Enter and closes', async () => {
    const { onValueChange } = renderSelect()
    trigger().focus()

    await userEvent.keyboard('{ArrowDown}{ArrowDown}{Enter}')

    expect(onValueChange).toHaveBeenCalledWith('medium')
    expect(trigger().getAttribute('aria-expanded')).toBe('false')
  })

  it('selects the active option with Space', async () => {
    const { onValueChange } = renderSelect()
    trigger().focus()

    await userEvent.keyboard('{ArrowDown}{ArrowDown}{ArrowDown}[Space]')

    expect(onValueChange).toHaveBeenCalledWith('high')
  })

  it('returns focus to the trigger after selecting', async () => {
    renderSelect()
    trigger().focus()

    await userEvent.keyboard('{ArrowDown}{Enter}')

    expect(document.activeElement).toBe(trigger())
  })

  it('closes on Escape without selecting', async () => {
    const { onValueChange } = renderSelect()
    trigger().focus()

    await userEvent.keyboard('{ArrowDown}{ArrowDown}{Escape}')

    expect(trigger().getAttribute('aria-expanded')).toBe('false')
    expect(onValueChange).not.toHaveBeenCalled()
  })

  it('keeps Escape from reaching an outer layer while the menu is open', async () => {
    const outerEscape = mock(() => undefined)
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') outerEscape()
    })
    renderSelect()
    trigger().focus()

    await userEvent.keyboard('{ArrowDown}')
    await userEvent.keyboard('{Escape}')
    // First Escape belongs to the menu: an enclosing modal must not close.
    expect(outerEscape).not.toHaveBeenCalled()

    // Second Escape has no menu to close, so it passes through.
    await userEvent.keyboard('{Escape}')
    expect(outerEscape).toHaveBeenCalledTimes(1)
  })

  it('drops the active-option pointer when closed', async () => {
    renderSelect()
    trigger().focus()

    await userEvent.keyboard('{ArrowDown}')
    expect(trigger().getAttribute('aria-activedescendant')).toBeTruthy()

    await userEvent.keyboard('{Escape}')
    expect(trigger().getAttribute('aria-activedescendant')).toBeNull()
  })

  it('skips a disabled option when navigating', async () => {
    const onValueChange = mock(() => undefined)
    render(
      <Dropdown value="" onValueChange={onValueChange} trigger="Choose…" aria-label="Level">
        <DropdownItem value="low">Low</DropdownItem>
        <DropdownItem value="medium" disabled>Medium</DropdownItem>
        <DropdownItem value="high">High</DropdownItem>
      </Dropdown>,
    )
    trigger().focus()

    await userEvent.keyboard('{ArrowDown}{ArrowDown}')

    expect(activeOptionText()).toBe('High')
  })

  it('still works as an action menu with no value prop', async () => {
    const onSelect = mock(() => undefined)
    render(
      <Dropdown trigger="Actions" aria-label="Actions">
        <DropdownItem onSelect={onSelect}>Rename</DropdownItem>
        <DropdownItem>Delete</DropdownItem>
      </Dropdown>,
    )
    const actions = screen.getByRole('button', { name: 'Actions' })
    actions.focus()

    await userEvent.keyboard('{ArrowDown}{Enter}')

    expect(onSelect).toHaveBeenCalled()
  })
})
