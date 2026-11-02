import '@testing-library/jest-dom'

import { afterEach, beforeAll, beforeEach, expect, it, mock } from 'bun:test'
import { cleanup, render, screen, within } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

mock.module('lucide-react', () => new Proxy({}, { get: () => () => null }))
mock.module('@/api/client', () => ({ installTypeScriptLsp: async () => ({}) }))
// The real card needs the Tauri updater bridge; only its placement matters here.
mock.module('@/components/UpdateCard', () => ({
  UpdateCard: () => <aside data-testid="update-card">Update available</aside>,
}))

import { FloatingNotices } from '@/components/FloatingNotices'
import { prefetchSurfaces } from '@/lib/lazy-surface'

// The viewer and notices load lazily; load them before the tests render.
beforeAll(async () => {
  await prefetchSurfaces()
})
import { useLspInstallStore } from '@/stores/useLspInstallStore'
import { useToastStore } from '@/stores/useToastStore'

beforeEach(() => {
  useToastStore.setState({ toasts: [{ id: 't-1', tone: 'info', title: 'Saved', durationMs: 60_000 }] })
  useLspInstallStore.setState({ request: { workspace: '/project', languageServerVersion: '1.2.3', typeScriptVersion: '5.8.2' } })
})

afterEach(() => {
  cleanup()
  useToastStore.setState({ toasts: [] })
  useLspInstallStore.setState({ request: null })
})

it('stacks toasts, the TypeScript tools prompt and the update card in one column', () => {
  const { container } = render(<FloatingNotices />)

  const column = container.querySelector('[data-floating-notices]') as HTMLElement
  expect(column).not.toBeNull()
  expect(within(column).getByText('Saved')).toBeInTheDocument()
  expect(within(column).getByRole('dialog', { name: 'Install TypeScript language tools' })).toBeInTheDocument()
  expect(within(column).getByTestId('update-card')).toBeInTheDocument()
})

it('positions the column once, so the cards cannot overlap each other', () => {
  const { container } = render(<FloatingNotices />)

  const column = container.querySelector('[data-floating-notices]') as HTMLElement
  expect(column).toHaveClass('fixed')
  const lspCard = screen.getByRole('dialog').closest('aside') as HTMLElement
  expect(lspCard).not.toHaveClass('fixed')
})

it('hangs the column from the top right under the header, not from the bottom where the composer sits', () => {
  const { container } = render(<FloatingNotices />)
  const column = container.querySelector('[data-floating-notices]') as HTMLElement
  const classes = column.className.split(/\s+/)

  expect(classes).toContain('mobile-safe-floating')
  expect(classes.some((c) => /(?:^|:)bottom-/.test(c))).toBe(false)
  // Items hug the right edge; the column itself is click-through around them.
  expect(classes).toContain('items-end')
  expect(classes).toContain('pointer-events-none')

  const css = readFileSync(fileURLToPath(new URL('../../index.css', import.meta.url)), 'utf8')
  const rules = [...css.matchAll(/\.mobile-safe-floating\s*\{([^}]*)\}/g)].map((m) => m[1])
  // One rule, with safe areas on every side that has an inset, and no bottom anchor.
  expect(rules).toHaveLength(1)
  expect(rules[0]).toContain('top: calc(env(safe-area-inset-top, 0px) + var(--spacing-app-header) + 0.5rem)')
  expect(rules[0]).toContain('right: max(1rem, env(safe-area-inset-right, 0px))')
  expect(rules[0]).toContain('left: max(1rem, env(safe-area-inset-left, 0px))')
  expect(rules[0]).not.toMatch(/bottom\s*:/)
})

it('lists toasts first, then the tools prompt and the update card', () => {
  const { container } = render(<FloatingNotices />)
  const column = container.querySelector('[data-floating-notices]') as HTMLElement
  const order = [
    screen.getByText('Saved'),
    screen.getByRole('dialog', { name: 'Install TypeScript language tools' }),
    screen.getByTestId('update-card'),
  ]

  const positions = order.map((el) => Array.from(column.querySelectorAll('*')).indexOf(el))
  expect(positions).toEqual([...positions].sort((a, b) => a - b))
})

it('puts the newest toast nearest the top edge', () => {
  useToastStore.setState({
    toasts: [
      { id: 't-old', tone: 'info', title: 'Older', durationMs: 60_000 },
      { id: 't-new', tone: 'info', title: 'Newest', durationMs: 60_000 },
    ],
  })
  const { container } = render(<FloatingNotices />)
  const column = container.querySelector('[data-floating-notices]') as HTMLElement

  const titles = within(column).getAllByRole('status').map((el) => el.textContent)
  expect(titles[0]).toContain('Newest')
  expect(titles[1]).toContain('Older')
})
