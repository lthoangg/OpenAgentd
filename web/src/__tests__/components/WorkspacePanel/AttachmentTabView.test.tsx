/**
 * AttachmentTabView — a text attachment is read from its upload URL, so it
 * has a loading state: text lines (Rulebook 10), then the text itself.
 */
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { act, cleanup, render, screen } from '@testing-library/react'

mock.module('lucide-react', () => new Proxy({}, { get: () => () => null }))

import { AttachmentTabView } from '@/components/WorkspacePanel/AttachmentTabView'

const originalFetch = globalThis.fetch
afterEach(() => {
  cleanup()
  globalThis.fetch = originalFetch
})

describe('AttachmentTabView — text', () => {
  it('shows text lines named "Loading attachment" until the file arrives, then the text', async () => {
    let answer: (response: Response) => void = () => {}
    globalThis.fetch = mock(() => new Promise<Response>((resolve) => { answer = resolve })) as unknown as typeof fetch
    const { container } = render(<AttachmentTabView item={{ type: 'text', src: '/uploads/notes.txt', name: 'notes.txt' }} />)

    const loading = screen.getByRole('status', { name: 'Loading attachment' })
    expect(loading.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThanOrEqual(3)
    expect(container.textContent).not.toContain('Loading…')

    await act(async () => { answer(new Response('hello from the upload')) })
    expect(await screen.findByText('hello from the upload')).toBeTruthy()
    expect(screen.queryByRole('status', { name: 'Loading attachment' })).toBeNull()
  })

  it('shows text it already has at once, with nothing to load', () => {
    globalThis.fetch = mock(() => new Promise<Response>(() => {})) as unknown as typeof fetch
    render(<AttachmentTabView item={{ type: 'text', src: '/uploads/notes.txt', name: 'notes.txt', textContent: 'already here' }} />)

    expect(screen.getByText('already here')).toBeTruthy()
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('says when the file could not be loaded', async () => {
    globalThis.fetch = mock(async () => new Response('gone', { status: 404 })) as unknown as typeof fetch
    render(<AttachmentTabView item={{ type: 'text', src: '/uploads/notes.txt', name: 'notes.txt' }} />)

    expect(await screen.findByText('(failed to load)')).toBeTruthy()
    expect(screen.queryByRole('status')).toBeNull()
  })
})
