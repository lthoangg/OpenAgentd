/**
 * The Server dialog stays out of the startup bundle: nothing of it mounts
 * until it is first opened, then it loads and stays mounted, so closing it
 * can still fade out.
 */
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, render, screen } from '@testing-library/react'

const rendered: boolean[] = []
mock.module('@/components/AppBackendDialog', () => ({
  AppBackendDialog: ({ open }: { open: boolean }) => {
    rendered.push(open)
    return open ? <div role="dialog" aria-label="Server" /> : null
  },
}))

const { AppBackendDialog } = await import('@/components/LazyAppBackendDialog')

afterEach(cleanup)

describe('LazyAppBackendDialog', () => {
  it('mounts nothing until opened, then loads the dialog and keeps it mounted', async () => {
    const { rerender } = render(<AppBackendDialog open={false} onOpenChange={() => {}} />)
    expect(rendered).toEqual([])

    rerender(<AppBackendDialog open onOpenChange={() => {}} />)
    expect(await screen.findByRole('dialog', { name: 'Server' })).toBeTruthy()

    rerender(<AppBackendDialog open={false} onOpenChange={() => {}} />)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(rendered.at(-1)).toBe(false)
  })
})
