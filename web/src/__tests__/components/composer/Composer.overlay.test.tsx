/**
 * The docked composer tells the workbench center how tall it is, so a
 * Review panel overlaying a narrow chat can stop above it.
 */
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, render } from '@testing-library/react'

mock.module('@/hooks/use-mobile', () => ({ useIsMobile: () => false }))

const { Composer } = await import('@/components/composer/Composer')

afterEach(cleanup)

describe('Composer height for the Review panel overlay', () => {
  it('publishes --composer-h on the workbench center, and clears it when gone', () => {
    const { container, unmount } = render(
      <div data-workbench-center="">
        <Composer onSubmit={() => {}} />
      </div>,
    )
    const center = container.querySelector('[data-workbench-center]') as HTMLElement
    expect(center.style.getPropertyValue('--composer-h')).toMatch(/^\d+px$/)
    unmount()
    expect(center.style.getPropertyValue('--composer-h')).toBe('')
  })
})
