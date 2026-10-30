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
let removeOuterEscape: (() => void) | null = null

beforeEach(() => {
  escapes = 0
})

afterEach(() => {
  // Even when an assertion throws, the document-level listener must not leak
  // into the next test.
  removeOuterEscape?.()
  removeOuterEscape = null
  cleanup()
})

function renderBox(onChange = mock(() => undefined), value = '') {
  const onOuterEscape = (e: KeyboardEvent) => {
    if (e.key === 'Escape') escapes += 1
  }
  document.addEventListener('keydown', onOuterEscape)
  removeOuterEscape = () => document.removeEventListener('keydown', onOuterEscape)
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
    // The row shows the short model id; the full id rides in its title
    const row = document.getElementById(id!)
    expect(row?.getAttribute('role')).toBe('option')
    expect(row?.textContent).toBe('o3-mini')
    expect(row?.getAttribute('title')).toBe('openai:o3-mini')

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

describe('ModelCombobox — option rows', () => {
  it('groups rows under a provider heading while the query is empty', async () => {
    const { cleanupOuter } = renderBox()
    await userEvent.click(input())

    const options = screen.getAllByRole('option')
    expect(options.map((o) => o.textContent)).toEqual(['gpt-4oVision', 'o3-mini'])
    // One non-option heading for the provider, before its first row
    const headings = screen.getAllByRole('presentation').filter((node) => node.tagName === 'LI')
    expect(headings.map((h) => h.textContent)).toEqual(['openai'])
    expect(headings[0].nextElementSibling?.contains(options[0])).toBe(true)
    // Option ids are unchanged by the heading
    expect(options[0].id.endsWith('-option-0')).toBe(true)
    expect(options[1].id.endsWith('-option-1')).toBe(true)
    // No per-row provider chip while headings carry the provider
    expect(options[0].querySelector('[data-slot="chip"][data-tone]')?.textContent).toBe('Vision')
    expect(options[0].querySelectorAll('[data-slot="chip"]')).toHaveLength(1)

    cleanupOuter()
  })

  it('titles each row with its full id and marks vision models with a Vision chip', async () => {
    const { cleanupOuter } = renderBox()
    await userEvent.click(input())

    const gpt = screen.getByRole('option', { name: /gpt-4o/ })
    expect(gpt.getAttribute('title')).toBe('openai:gpt-4o')
    expect(gpt.textContent).toContain('Vision')
    expect(screen.getByRole('option', { name: /o3-mini/ }).textContent).not.toContain('Vision')

    cleanupOuter()
  })

  it('drops the headings and shows a provider chip on each row once a query is typed', async () => {
    const { cleanupOuter } = renderBox()
    await userEvent.click(input())
    await userEvent.keyboard('o3')

    const options = screen.getAllByRole('option')
    expect(options).toHaveLength(1)
    expect(options[0].getAttribute('title')).toBe('openai:o3-mini')
    expect(screen.queryAllByRole('presentation').filter((node) => node.tagName === 'LI')).toHaveLength(0)
    const chip = options[0].querySelector('[data-slot="chip"]')
    expect(chip?.textContent).toBe('openai')
    expect(chip?.className).toContain('font-mono')

    cleanupOuter()
  })
})
