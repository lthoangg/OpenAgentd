import '@testing-library/jest-dom'

import { afterEach, beforeEach, expect, it, mock } from 'bun:test'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { setApiBaseUrl } from '@/api/base-url'

let installError: Error | null = null
const installTypeScriptLsp = mock(async () => {
  if (installError) throw installError
  return {
    downloads_enabled: true,
    python: { ty: true, ruff: true },
    typescript: { state: 'ready' as const, detail: null, language_server_version: '1.2.3', typescript_version: '5.8.2' },
  }
})
mock.module('@/api/client', () => ({ installTypeScriptLsp }))
mock.module('lucide-react', () => new Proxy({}, { get: () => () => null }))

import { LspInstallPrompt } from '@/components/LspInstallPrompt'
import { useLspInstallStore } from '@/stores/useLspInstallStore'

beforeEach(() => {
  setApiBaseUrl('http://127.0.0.1:4001')
  installTypeScriptLsp.mockClear()
  installError = null
  useLspInstallStore.setState({ request: { workspace: '/project', languageServerVersion: '1.2.3', typeScriptVersion: '5.8.2' } })
})

afterEach(cleanup)

it('asks before installing TypeScript tooling on the backend and installs after consent', async () => {
  render(<LspInstallPrompt />)

  expect(screen.getByRole('dialog')).toHaveTextContent('Install TypeScript language tools?')
  expect(screen.getByText(/installed on the backend/i)).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: /install on backend/i }))

  await waitFor(() => expect(installTypeScriptLsp).toHaveBeenCalledTimes(1))
  expect(await screen.findByText(/ready/i)).toBeInTheDocument()
})

it('does not carry completed install state into a later backend request', async () => {
  render(<LspInstallPrompt />)
  fireEvent.click(screen.getByRole('button', { name: /install on backend/i }))
  expect(await screen.findByText(/ready/i)).toBeInTheDocument()

  act(() => {
    setApiBaseUrl('http://127.0.0.1:4002')
    useLspInstallStore.getState().dismiss()
    useLspInstallStore.getState().requestInstall({
      workspace: '/project',
      languageServerVersion: '1.2.3',
      typeScriptVersion: '5.8.2',
    })
  })

  expect(await screen.findByRole('button', { name: /install on backend/i })).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: /^close$/i })).toBeNull()
})

it('keeps the prompt open and shows an install failure', async () => {
  installError = new Error('download failed')
  render(<LspInstallPrompt />)

  fireEvent.click(screen.getByRole('button', { name: /install on backend/i }))

  expect(await screen.findByRole('alert')).toHaveTextContent('download failed')
  expect(screen.getByRole('dialog')).toBeInTheDocument()
})

it('dismisses without installing', () => {
  render(<LspInstallPrompt />)

  fireEvent.click(screen.getByRole('button', { name: /not now/i }))

  expect(installTypeScriptLsp).not.toHaveBeenCalled()
  expect(useLspInstallStore.getState().request).toBeNull()
  expect(screen.queryByRole('dialog')).toBeNull()
})

it('uses narrow-layout-safe dialog markup', () => {
  render(<LspInstallPrompt />)

  expect(screen.getByRole('dialog')).toHaveAttribute('data-swipe-ignore')
})
