/**
 * On a phone View options is a sheet: Group by as a segmented control and
 * Show details as a switch (mockup J8).
 */
import '@testing-library/jest-dom'
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'

mock.module('@/hooks/use-is-phone', () => ({ useIsPhone: () => true }))

const { SidebarViewMenu } = await import('@/components/Sidebar/SidebarViewMenu')
const { useSidebarViewStore } = await import('@/stores/useSidebarViewStore')

afterEach(() => {
  cleanup()
  useSidebarViewStore.getState().reset()
})

describe('SidebarViewMenu on a phone', () => {
  it('groups with a segmented control and shows details with a switch', () => {
    render(<SidebarViewMenu at={{ x: 0, y: 0 }} onDismiss={() => {}} />)
    const sheet = document.querySelector<HTMLElement>('[data-view-options-sheet]')!
    const group = within(sheet).getByRole('radiogroup', { name: 'Group by' })
    fireEvent.click(within(group).getByRole('radio', { name: 'Date' }))
    expect(useSidebarViewStore.getState().groupBy).toBe('date')

    const details = within(sheet).getByRole('switch', { name: 'Show details' })
    const before = useSidebarViewStore.getState().showDetails
    fireEvent.click(details)
    expect(useSidebarViewStore.getState().showDetails).toBe(!before)
  })

  it('resets and closes from its action row', () => {
    const onDismiss = mock(() => {})
    render(<SidebarViewMenu at={{ x: 0, y: 0 }} onDismiss={onDismiss} />)
    fireEvent.click(screen.getByRole('button', { name: 'Reset to defaults' }))
    expect(onDismiss).toHaveBeenCalled()
  })
})
