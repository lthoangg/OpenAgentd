/**
 * ModelCombobox — keyboard operation and layered Escape.
 *
 * The option list is portalled outside any modal focus trap, so the input keeps
 * focus and drives the list by key. Escape must dismiss the list *without*
 * reaching the enclosing modal, otherwise cancelling a search closes the whole
 * panel.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

mock.module('lucide-react', () => new Proxy({}, { get: () => () => null }))

import { ModelCombobox } from '@/components/settings/AgentForm/ModelCombobox'

const OPTIONS = [
  { id: 'openai:gpt-4o', provider: 'openai', model: 'gpt-4o', vision: true },
  { id: 'openai:o3-mini', provider: 'openai', model: 'o3-mini', vision: false },
]

let escapes: number

beforeEach(() => {
  escapes = 0
})

afterEach(cleanup)

function renderBox(onChange = mock(() => undefined), value = '') {
  const onOuterEscape = (e: KeyboardEvent) => {
    if (e.key === 'Escape') escapes += 1
  }
  document.addEventListener('keydown', onOuterEscape)
  const result = render(
    <ModelCombobox
      value={value}
      options={OPTIONS}
      onChange={onChange}
      ariaLabel="Search session model"
    />,
  )
  return { ...result, onChange, cleanupOuter: () => document.removeEventListener('keydown', onOuterEscape) }
}

const input = () => screen.getByRole('combobox', { name: 'Search session model' })

describe('ModelCombobox — keyboard', () => {
  it('publishes the highlighted option through aria-activedescendant', async () => {
    const { cleanupOuter } = renderBox()

    await userEvent.click(input())
    await userEvent.keyboard('{ArrowDown}')

    const id = input().getAttribute('aria-activedescendant')
    expect(id).toBeTruthy()
    expect(document.getElementById(id!)?.textContent).toContain('openai:o3-mini')

    cleanupOuter()
  })

  it('drops aria-activedescendant when the list is closed', async () => {
    const { cleanupOuter } = renderBox()

    await userEvent.click(input())
    expect(input().getAttribute('aria-activedescendant')).toBeTruthy()

    await userEvent.keyboard('{Escape}')
    expect(input().getAttribute('aria-activedescendant')).toBeNull()

    cleanupOuter()
  })

  it('keeps the first Escape from reaching an enclosing modal', async () => {
    const { cleanupOuter } = renderBox()

    await userEvent.click(input())
    await userEvent.keyboard('{Escape}')

    // The list consumed it: an enclosing modal must stay open.
    expect(escapes).toBe(0)

    // With the list closed, Escape belongs to the modal again.
    await userEvent.keyboard('{Escape}')
    expect(escapes).toBe(1)

    cleanupOuter()
  })
})
