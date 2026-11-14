import '@testing-library/jest-dom'

import { afterEach, beforeEach, expect, it, mock } from 'bun:test'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { setApiBaseUrl } from '@/api/base-url'

let installError: Error | null = null
// A test holds the install open by putting a promise here.
let installGate: Promise<void> | null = null
const installTypeScriptLsp = mock(async () => {
  if (installGate) await installGate
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
import { useToastStore } from '@/stores/useToastStore'

beforeEach(() => {
  setApiBaseUrl('http://127.0.0.1:4001')
  installTypeScriptLsp.mockClear()
  installError = null
  installGate = null
  useToastStore.setState({ toasts: [] })
  useLspInstallStore.setState({ request: { workspace: '/project', languageServerVersion: '1.2.3', typeScriptVersion: '5.8.2' } })
})

afterEach(cleanup)

const toasts = () => useToastStore.getState().toasts

it('asks in one line, naming the workspace, and installs after consent', async () => {
  render(<LspInstallPrompt />)

  const line = screen.getByRole('dialog', { name: 'Install TypeScript language tools' })
  expect(line).toHaveTextContent('Install TypeScript tools for project?')
  expect(screen.getAllByRole('button').map((button) => button.textContent)).toEqual(['Later', 'Install'])
  fireEvent.click(screen.getByRole('button', { name: 'Install' }))

  await waitFor(() => expect(installTypeScriptLsp).toHaveBeenCalledTimes(1))
  // Done: the line leaves and a toast says so.
  await waitFor(() => expect(toasts().map((t) => t.title)).toEqual(['TypeScript tools are ready']))
  expect(useLspInstallStore.getState().request).toBeNull()
})

it('keeps where the tools go, the folder and the versions as the line\'s detail', () => {
  render(<LspInstallPrompt />)

  const detail = screen.getByText('Install TypeScript tools for project?').closest('[title]')?.getAttribute('title') ?? ''
  expect(detail).toContain('on the computer the agent runs on')
  expect(detail).toContain('/project')
  expect(detail).toContain('Language server 1.2.3, TypeScript 5.8.2')
})

it('says "Installing TypeScript tools…" with nothing to press while it installs', async () => {
  let finish: () => void = () => {}
  installGate = new Promise((resolve) => { finish = resolve })
  render(<LspInstallPrompt />)

  fireEvent.click(screen.getByRole('button', { name: 'Install' }))

  expect(await screen.findByText('Installing TypeScript tools…')).toBeInTheDocument()
  expect(screen.queryByRole('button')).toBeNull()
  await act(async () => { finish() })
})

it('does not carry a finished install into a later request from another computer', async () => {
  render(<LspInstallPrompt />)
  fireEvent.click(screen.getByRole('button', { name: 'Install' }))
  await waitFor(() => expect(useLspInstallStore.getState().request).toBeNull())

  act(() => {
    setApiBaseUrl('http://127.0.0.1:4002')
    useLspInstallStore.getState().requestInstall({
      workspace: '/project',
      languageServerVersion: '1.2.3',
      typeScriptVersion: '5.8.2',
    })
  })

  expect(await screen.findByRole('button', { name: 'Install' })).toBeInTheDocument()
})

it('keeps the line with Retry and says why in a toast when the install fails', async () => {
  installError = new Error('The download was refused by the registry.')
  render(<LspInstallPrompt />)

  fireEvent.click(screen.getByRole('button', { name: 'Install' }))

  await waitFor(() => expect(toasts().map((t) => t.title)).toEqual(["Couldn't install TypeScript tools"]))
  expect(toasts()[0].description).toBe('The download was refused by the registry.')
  expect(screen.getByRole('dialog')).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
})

it('dismisses without installing', () => {
  render(<LspInstallPrompt />)

  fireEvent.click(screen.getByRole('button', { name: 'Later' }))

  expect(installTypeScriptLsp).not.toHaveBeenCalled()
  expect(useLspInstallStore.getState().request).toBeNull()
  expect(screen.queryByRole('dialog')).toBeNull()
})

it('uses narrow-layout-safe dialog markup', () => {
  render(<LspInstallPrompt />)

  expect(screen.getByRole('dialog')).toHaveAttribute('data-swipe-ignore')
})

it('renders as a non-blocking line that does not interfere with chat', () => {
  const { container } = render(<LspInstallPrompt />)

  // Placement belongs to the shared FloatingNotices column; the line itself
  // only has to stay click-through outside its panel.
  const aside = container.querySelector('aside')
  expect(aside).toHaveClass('pointer-events-none')
  expect(screen.getByRole('dialog')).toHaveClass('pointer-events-auto')

  // No blocking modal backdrop overlay
  expect(container.querySelector('[data-slot="dialog-overlay"]')).toBeNull()
})

it('has no pill and no drag handle', () => {
  render(<LspInstallPrompt />)

  expect(screen.queryByRole('button', { name: /minimize|expand|drag/i })).toBeNull()
})
