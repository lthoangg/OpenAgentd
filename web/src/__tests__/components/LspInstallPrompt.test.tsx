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
  expect(screen.getByText(/installed on the server/i)).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: /^install$/i }))

  await waitFor(() => expect(installTypeScriptLsp).toHaveBeenCalledTimes(1))
  expect(await screen.findByText(/ready/i)).toBeInTheDocument()
})

it('does not carry completed install state into a later backend request', async () => {
  render(<LspInstallPrompt />)
  fireEvent.click(screen.getByRole('button', { name: /^install$/i }))
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

  expect(await screen.findByRole('button', { name: /^install$/i })).toBeInTheDocument()
  expect(screen.queryByRole('button', { name: /^close$/i })).toBeNull()
})

it('keeps the prompt open and shows an install failure', async () => {
  installError = new Error('download failed')
  render(<LspInstallPrompt />)

  fireEvent.click(screen.getByRole('button', { name: /^install$/i }))

  expect(await screen.findByRole('alert')).toHaveTextContent('download failed')
  expect(screen.getByRole('dialog')).toBeInTheDocument()
})

it('dismisses without installing', () => {
  render(<LspInstallPrompt />)

  fireEvent.click(screen.getByRole('button', { name: /^later$/i }))

  expect(installTypeScriptLsp).not.toHaveBeenCalled()
  expect(useLspInstallStore.getState().request).toBeNull()
  expect(screen.queryByRole('dialog')).toBeNull()
})

it('uses narrow-layout-safe dialog markup', () => {
  render(<LspInstallPrompt />)

  expect(screen.getByRole('dialog')).toHaveAttribute('data-swipe-ignore')
})

it('renders as a non-blocking floating card that does not interfere with chat', () => {
  const { container } = render(<LspInstallPrompt />)

  // Placement belongs to the shared FloatingNotices column; the card itself
  // only has to stay click-through outside its panel.
  const aside = container.querySelector('aside')
  expect(aside).toHaveClass('pointer-events-none')

  const dialog = screen.getByRole('dialog')
  expect(dialog).toHaveClass('pointer-events-auto')

  // No blocking modal backdrop overlay
  expect(container.querySelector('[data-slot="dialog-overlay"]')).toBeNull()
})

it('provides a drag handle with double-click reset', () => {
  render(<LspInstallPrompt />)

  const dragHandle = screen.getByRole('button', { name: /drag typescript tools notification/i })
  expect(dragHandle).toBeInTheDocument()
  fireEvent.doubleClick(dragHandle)
})

it('minimizes into a compact pill and expands back', () => {
  render(<LspInstallPrompt />)

  const minimizeBtn = screen.getByRole('button', { name: /minimize/i })
  fireEvent.click(minimizeBtn)

  expect(screen.getByText('TypeScript tools')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: /expand/i })).toBeInTheDocument()
  expect(screen.queryByText(/TypeScript language tools are needed for this workspace/i)).toBeNull()

  const expandBtn = screen.getByRole('button', { name: /expand/i })
  fireEvent.click(expandBtn)

  expect(screen.getByText(/TypeScript language tools are needed for this workspace/i)).toBeInTheDocument()

  // Can also minimize and expand via the pill button
  fireEvent.click(screen.getByRole('button', { name: /minimize/i }))
  expect(screen.queryByText(/TypeScript language tools are needed for this workspace/i)).toBeNull()

  const pillBtn = screen.getByRole('button', { name: 'TypeScript tools' })
  fireEvent.click(pillBtn)
  expect(screen.getByText(/TypeScript language tools are needed for this workspace/i)).toBeInTheDocument()
})

it('allows installing from the minimized pill', async () => {
  render(<LspInstallPrompt />)

  const minimizeBtn = screen.getByRole('button', { name: /minimize/i })
  fireEvent.click(minimizeBtn)

  const quickInstallBtn = screen.getByRole('button', { name: /^install$/i })
  fireEvent.click(quickInstallBtn)

  await waitFor(() => expect(installTypeScriptLsp).toHaveBeenCalledTimes(1))
  expect(await screen.findByText('Tools ready')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: /^close$/i })).toBeInTheDocument()
})

it('dismisses when Later is clicked from expanded view', () => {
  render(<LspInstallPrompt />)

  const laterBtn = screen.getByRole('button', { name: /^later$/i })
  fireEvent.click(laterBtn)

  expect(installTypeScriptLsp).not.toHaveBeenCalled()
  expect(useLspInstallStore.getState().request).toBeNull()
  expect(screen.queryByRole('dialog')).toBeNull()
})

it('dismisses when Later is clicked from minimized view', () => {
  render(<LspInstallPrompt />)

  const minimizeBtn = screen.getByRole('button', { name: /minimize/i })
  fireEvent.click(minimizeBtn)

  const laterBtn = screen.getByRole('button', { name: /^later$/i })
  fireEvent.click(laterBtn)

  expect(installTypeScriptLsp).not.toHaveBeenCalled()
  expect(useLspInstallStore.getState().request).toBeNull()
  expect(screen.queryByRole('dialog')).toBeNull()
})
