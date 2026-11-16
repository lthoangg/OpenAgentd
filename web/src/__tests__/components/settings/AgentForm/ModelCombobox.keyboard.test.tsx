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
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

mock.module('lucide-react', () => new Proxy({}, { get: () => () => null }))

import { ModelCombobox } from '@/components/settings/AgentForm/ModelCombobox'
import { queryKeys } from '@/queries/keys'

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
    // No providers list loaded: the id stands in for the display name.
    expect(chip?.textContent).toBe('openai')
    // A provider's name is a word, not an identifier: the UI font.
    expect(chip?.className).not.toContain('font-mono')

    cleanupOuter()
  })
})

describe('ModelCombobox — provider display names', () => {
  const MIXED = [
    { id: 'anthropic:sonnet', provider: 'anthropic', model: 'sonnet', vision: false },
    { id: 'openai:gpt-4o', provider: 'openai', model: 'gpt-4o', vision: false },
    { id: 'openai:o3-mini', provider: 'openai', model: 'o3-mini', vision: false },
  ]

  function renderWithProviders(options = MIXED) {
    const client = new QueryClient()
    client.setQueryData(queryKeys.settings.providers(), {
      providers: [
        { id: 'anthropic', label: 'Claude' },
        { id: 'openai', label: 'OpenAI' },
      ],
      has_any_configured: true,
    })
    return render(
      <QueryClientProvider client={client}>
        <ModelCombobox value="" options={options} onChange={() => undefined} ariaLabel="Search session model" />
      </QueryClientProvider>,
    )
  }

  it("heads each group with the provider's display name and lists only the model in its rows", async () => {
    renderWithProviders()
    await userEvent.click(input())

    const headings = screen.getAllByRole('presentation').filter((node) => node.tagName === 'LI')
    expect(headings.map((h) => h.textContent)).toEqual(['Claude', 'OpenAI'])
    // UI font: it is a name, not an id.
    expect(headings[0].className).not.toContain('font-mono')
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(['sonnet', 'gpt-4o', 'o3-mini'])
    // The row's title still carries the whole id.
    expect(screen.getByRole('option', { name: 'gpt-4o' }).getAttribute('title')).toBe('openai:gpt-4o')
  })

  it('names the provider on each ranked result by its display name', async () => {
    renderWithProviders()
    await userEvent.click(input())
    await userEvent.keyboard('sonnet')

    const [option] = screen.getAllByRole('option')
    expect(option.querySelector('[data-slot="chip"]')?.textContent).toBe('Claude')
  })

  it('still matches a typed "openai:" to that provider\'s models', async () => {
    renderWithProviders()
    await userEvent.click(input())
    await userEvent.keyboard('openai:')

    expect(screen.getAllByRole('option').map((o) => o.getAttribute('title'))).toEqual(['openai:gpt-4o', 'openai:o3-mini'])
  })

  it('falls back to the id for a provider the list does not name', async () => {
    renderWithProviders([{ id: 'zzz:model-1', provider: 'zzz', model: 'model-1', vision: false }])
    await userEvent.click(input())

    const headings = screen.getAllByRole('presentation').filter((node) => node.tagName === 'LI')
    expect(headings.map((h) => h.textContent)).toEqual(['zzz'])
  })
})
