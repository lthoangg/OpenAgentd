import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ReactNode } from 'react'

import type { SecretEntry } from '@/api/question-types'

mock.module('@tanstack/react-router', () => ({
  Link: ({ children }: { children: ReactNode }) => children,
}))
mock.module('@/hooks/use-mobile', () => ({ useIsMobile: () => false }))

let secrets: SecretEntry[] = []
const listSecrets = mock(async () => ({ secrets }))
const saveSecret = mock(async (...args: unknown[]) => ({ name: String(args[0]), id: 'new' }))
const deleteSecret = mock(async (..._args: unknown[]) => {})

const real = await import('@/api/client')
mock.module('@/api/client', () => ({
  ...real,
  listSecrets,
  saveSecret,
  deleteSecret,
  getCodingWorkspaceTree: async () => ({ repositories: [], groups: [] }),
}))

const { SecretsSettingsPage } = await import('@/components/settings/pages/settings.secrets')

const clientA: SecretEntry = {
  name: 'STRIPE_SECRET_KEY',
  id: 'v1',
  all: false,
  projects: [{ key: '/work/client-a', name: 'client-a' }],
  updated: '2025-03-04T10:00:00Z',
  source: 'chat',
}
const clientB: SecretEntry = {
  name: 'STRIPE_SECRET_KEY',
  id: 'v2',
  all: false,
  projects: [
    { key: '/work/client-b', name: 'client-b' },
    { key: '/work/gone', name: 'gone', missing: true },
  ],
  updated: '2025-03-05T10:00:00Z',
  source: 'settings',
}

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <SecretsSettingsPage />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  secrets = []
  listSecrets.mockClear()
  saveSecret.mockClear()
  deleteSecret.mockClear()
  saveSecret.mockImplementation(async (...args: unknown[]) => ({ name: String(args[0]), id: 'new' }))
})

afterEach(() => {
  cleanup()
  localStorage.clear()
})

describe('SecretsSettingsPage', () => {
  it('is titled Secrets, and says what to do when there are none', async () => {
    renderPage()
    expect(await screen.findByRole('heading', { level: 1, name: 'Secrets' })).toBeTruthy()
    expect(await screen.findByText('No secrets yet')).toBeTruthy()
    expect(screen.getByText(/When a task needs an API key/)).toBeTruthy()
    expect(screen.getByRole('button', { name: /Add secret/ })).toBeTruthy()
  })

  it('shows one row per value, even for the same name', async () => {
    secrets = [clientA, clientB, { name: 'OPENAI_API_KEY', id: 'v3', all: true, projects: [] }]
    renderPage()
    await screen.findByText('OPENAI_API_KEY')
    expect(screen.getAllByText('STRIPE_SECRET_KEY')).toHaveLength(2)
    expect(screen.getByText(/Used in: client-a/)).toBeTruthy()
    expect(screen.getByText(/Used in: client-b, gone/)).toBeTruthy()
    expect(screen.getByText(/gone: folder missing/)).toBeTruthy()
    expect(screen.getByText(/Used in: All projects/)).toBeTruthy()
    expect(screen.getByText(/from chat/)).toBeTruthy()
    expect(screen.getByText(/in Settings/)).toBeTruthy()
  })

  it('edits a value: sends id and value only, then forgets the value', async () => {
    secrets = [clientA]
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: /^Edit STRIPE_SECRET_KEY/ }))
    const dialog = await screen.findByRole('dialog', { name: 'Edit STRIPE_SECRET_KEY' })

    const field = within(dialog).getByLabelText('New value') as HTMLInputElement
    expect(field.type).toBe('password')
    expect(field.autocomplete).toBe('off')
    expect(field.value).toBe('')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Show' }))
    expect(field.type).toBe('text')
    fireEvent.change(field, { target: { value: 'sk_live_topsecret' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(saveSecret).toHaveBeenCalledTimes(1))
    expect(saveSecret).toHaveBeenCalledWith('STRIPE_SECRET_KEY', { id: 'v1', value: 'sk_live_topsecret' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(document.body.innerHTML).not.toContain('sk_live_topsecret')
    expect(JSON.stringify(Object.entries(localStorage))).not.toContain('sk_live_topsecret')
  })

  it('edits the projects without sending a value', async () => {
    secrets = [clientA]
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: /^Edit STRIPE_SECRET_KEY/ }))
    const dialog = await screen.findByRole('dialog')
    expect((within(dialog).getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(within(dialog).getByLabelText('Folder path'), { target: { value: '/work/client-c' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add folder' }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
    await waitFor(() => expect(saveSecret).toHaveBeenCalledTimes(1))
    expect(saveSecret).toHaveBeenCalledWith('STRIPE_SECRET_KEY', {
      id: 'v1',
      projects: ['/work/client-a', '/work/client-c'],
    })
  })

  it('shows a server error inline and keeps the dialog open', async () => {
    secrets = [clientA]
    saveSecret.mockImplementation(async () => {
      throw new Error("'PATH' changes how commands run")
    })
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: /^Edit STRIPE_SECRET_KEY/ }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.change(within(dialog).getByLabelText('New value'), { target: { value: 'abc' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }))
    expect((await within(dialog).findByRole('alert')).textContent).toContain("'PATH' changes how commands run")
    expect(screen.getByRole('dialog')).toBeTruthy()
  })

  it('validates the name when adding, and saves from Settings', async () => {
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: /Add secret/ }))
    const dialog = await screen.findByRole('dialog', { name: 'Add secret' })
    const save = within(dialog).getByRole('button', { name: 'Save' }) as HTMLButtonElement

    expect(within(dialog).getByText('UPPER_SNAKE_CASE, as your code reads it')).toBeTruthy()
    fireEvent.change(within(dialog).getByLabelText('Value'), { target: { value: 'v-123' } })
    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'stripe key' } })
    expect(within(dialog).getByLabelText('Name').getAttribute('aria-invalid')).toBe('true')
    expect(within(dialog).queryByText('UPPER_SNAKE_CASE, as your code reads it')).toBeNull()
    expect(save.disabled).toBe(true)
    fireEvent.click(save)
    expect(saveSecret).not.toHaveBeenCalled()

    fireEvent.change(within(dialog).getByLabelText('Name'), { target: { value: 'STRIPE_KEY' } })
    expect(save.disabled).toBe(false)
    fireEvent.click(save)
    await waitFor(() => expect(saveSecret).toHaveBeenCalledTimes(1))
    expect(saveSecret).toHaveBeenCalledWith('STRIPE_KEY', { value: 'v-123', projects: ['*'], source: 'settings' })
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(document.body.innerHTML).not.toContain('v-123')
  })

  it('asks before deleting, then deletes that value', async () => {
    secrets = [clientA, clientB]
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: 'Delete STRIPE_SECRET_KEY for client-a' }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('Delete STRIPE_SECRET_KEY for client-a?')).toBeTruthy()
    expect(within(dialog).getByText(/Commands that use it will stop working/)).toBeTruthy()
    expect(deleteSecret).not.toHaveBeenCalled()

    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(deleteSecret).toHaveBeenCalledWith('STRIPE_SECRET_KEY', 'v1'))
  })

  it('does not delete when cancelled', async () => {
    secrets = [clientA]
    renderPage()
    fireEvent.click(await screen.findByRole('button', { name: /^Delete STRIPE_SECRET_KEY/ }))
    const dialog = await screen.findByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(deleteSecret).not.toHaveBeenCalled()
  })
})
