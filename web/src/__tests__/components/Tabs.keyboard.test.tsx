import { afterEach, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'

mock.module('lucide-react', () => new Proxy({}, { get: () => () => null }))
afterEach(cleanup)

it('moves focus and selection with arrows, skipping disabled tabs', () => {
  render(<Tabs defaultValue="one"><TabsList>
    <TabsTrigger value="one">One</TabsTrigger>
    <TabsTrigger value="disabled" disabled>Disabled</TabsTrigger>
    <TabsTrigger value="two">Two</TabsTrigger>
  </TabsList><TabsContent value="one">First</TabsContent><TabsContent value="two">Second</TabsContent></Tabs>)
  const first = screen.getByRole('tab', { name: 'One' })
  const second = screen.getByRole('tab', { name: 'Two' })
  first.focus()
  fireEvent.keyDown(first, { key: 'ArrowRight' })
  expect(document.activeElement).toBe(second)
  expect(second.getAttribute('aria-selected')).toBe('true')
  expect(screen.getByRole('tabpanel').textContent).toBe('Second')
  fireEvent.keyDown(second, { key: 'Home' })
  expect(document.activeElement).toBe(first)
})

it('fills the active tab with the selection fill, never a border colour', () => {
  render(<Tabs defaultValue="one"><TabsList size="sm">
    <TabsTrigger value="one">One</TabsTrigger>
    <TabsTrigger value="two">Two</TabsTrigger>
  </TabsList></Tabs>)
  const active = screen.getByRole('tab', { name: 'One' }).className
  expect(active).toContain('data-active:bg-(--color-fill-selected)')
  expect(active).toContain('data-active:text-(--color-text-on-selected)')
  expect(active).not.toMatch(/data-active:border-/)
})
