/** On a phone, Stop answers the tap with a medium haptic: a firmer act than Send (Phone system). */
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

const haptics: string[] = []
mock.module('@/lib/haptics', () => ({
  softHapticFeedback: () => haptics.push('soft'),
  mediumHapticFeedback: () => haptics.push('medium'),
  selectionHapticFeedback: () => haptics.push('selection'),
  outcomeHapticFeedback: () => haptics.push('outcome'),
  haptic: () => haptics.push('haptic'),
}))
mock.module('@/hooks/use-mobile', () => ({ useIsMobile: () => false }))
mock.module('@/hooks/use-platform', () => ({
  usePlatform: () => ({ isTauri: false, os: 'macos', isMacOverlay: false }),
  getPlatform: () => ({ isTauri: false, os: 'macos', isMacOverlay: false }),
}))

const { InputComposer } = await import('@/components/InputComposer')

afterEach(() => {
  cleanup()
  haptics.length = 0
})

describe('InputComposer — Stop haptic', () => {
  it('buzzes once (medium) as Stop is tapped, then stops the turn', () => {
    const onStop = mock(() => {})
    render(<InputComposer onSubmit={() => {}} isStreaming onStop={onStop} />)
    fireEvent.click(screen.getByLabelText('Stop generation'))
    expect(haptics).toEqual(['medium'])
    expect(onStop).toHaveBeenCalledTimes(1)
  })
})
