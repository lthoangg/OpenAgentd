import { afterEach, describe, expect, it } from 'bun:test'
import { cleanup, render, screen } from '@testing-library/react'
import { FolderPlus } from 'lucide-react'
import { EmptyState } from '@/components/ui/empty-state'

afterEach(cleanup)

describe('EmptyState', () => {
  it('keeps its default rendering: a centred chip, a 20px icon and an h2 title', () => {
    const { container } = render(<EmptyState icon={FolderPlus} title="No workspaces yet" body="Open a folder." />)

    expect(container.querySelector('[data-empty-state]')).toBeNull()
    expect(container.firstElementChild?.className).toContain('p-10')
    expect(screen.getByRole('heading', { level: 2, name: 'No workspaces yet' })).toBeTruthy()
    expect(container.querySelector('svg')?.getAttribute('width')).toBe('20')
    expect(container.querySelector('.h-12.w-12')).toBeTruthy()
  })

  describe('compact', () => {
    it('lays out at row scale: a 12px icon beside a text-xs title, left-aligned, with no chip box or padding', () => {
      const { container } = render(<EmptyState compact icon={FolderPlus} title="No folders here" className="px-2 py-3" />)

      const root = container.firstElementChild as HTMLElement
      expect(root.getAttribute('data-empty-state')).toBe('compact')
      expect(root.className).toContain('items-start')
      // The caller sets the inset; the primitive adds none and does not fill.
      expect(root.className).toContain('px-2 py-3')
      expect(root.className).not.toContain('p-10')
      expect(root.className).not.toContain('h-full')
      expect(container.querySelector('.h-12')).toBeNull()
      expect(container.querySelector('svg')?.getAttribute('width')).toBe('12')
      const title = screen.getByText('No folders here')
      expect(title.className).toContain('text-xs')
      // Not a heading: a dense list has no outline to put one in.
      expect(screen.queryByRole('heading')).toBeNull()
    })

    it('puts the body and the action beneath the title', () => {
      render(<EmptyState compact icon={FolderPlus} title="No workspaces yet" body="Open a folder." action={<button type="button">Open workspace…</button>} />)

      const title = screen.getByText('No workspaces yet')
      const body = screen.getByText('Open a folder.')
      const action = screen.getByRole('button', { name: 'Open workspace…' })
      expect(title.compareDocumentPosition(body) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
      expect(body.compareDocumentPosition(action) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
      expect(body.className).toContain('text-meta')
    })

    it('tints the icon for an error', () => {
      const { container } = render(<EmptyState compact tone="error" icon={FolderPlus} title="Couldn't load workspaces." />)
      expect(container.querySelector('svg')?.getAttribute('class')).toContain('text-(--color-error)')
    })
  })
})
