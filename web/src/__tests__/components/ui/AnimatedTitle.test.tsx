import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { act, cleanup, render, screen } from '@testing-library/react'
import { useRef } from 'react'

import { AnimatedTitle, useTitleWash } from '@/components/ui/animated-title'
import { _resetAutoTitlesForTests, markAutoTitle } from '@/lib/auto-title'
import { useFakeTimers } from '../../fake-timers'

let timers: ReturnType<typeof useFakeTimers> | null = null
beforeEach(() => _resetAutoTitlesForTests())
afterEach(() => {
  cleanup()
  timers?.restore()
  timers = null
})

function title(text: string) {
  return <AnimatedTitle text={text} sessionId="s1" />
}

describe('AnimatedTitle', () => {
  it('writes in a title the server sent, while the old one lifts out', () => {
    const view = render(title('New session'))
    timers = useFakeTimers()

    markAutoTitle('s1', 'Fix the jumpy transcript')
    act(() => view.rerender(title('Fix the jumpy transcript')))

    const incoming = screen.getByText('Fix the jumpy transcript')
    expect(incoming.className).toContain('oa-title-reveal')
    const leaving = screen.getByText('New session')
    expect(leaving.className).toContain('oa-title-out')
    expect(leaving.getAttribute('aria-hidden')).toBe('true')

    act(() => timers!.tick(300))
    expect(screen.queryByText('New session')).toBeNull()
  })

  it('swaps a title the user typed without motion', () => {
    const view = render(title('New session'))
    act(() => view.rerender(title('My own name')))

    expect(screen.getByText('My own name').className).not.toContain('oa-title-reveal')
    expect(screen.queryByText('New session')).toBeNull()
  })

  it('writes in a first title that mounts as it lands', () => {
    markAutoTitle('s1', 'First title')
    render(title('First title'))
    expect(screen.getByText('First title').className).toContain('oa-title-reveal')
  })

  it('does not animate a title marked long ago (a list load or session switch)', () => {
    markAutoTitle('s1', 'Old title', Date.now() - 10_000)
    const view = render(title('Before'))
    act(() => view.rerender(title('Old title')))
    expect(screen.getByText('Old title').className).not.toContain('oa-title-reveal')
  })
})

describe('useTitleWash', () => {
  function Row({ text }: { text: string }) {
    const ref = useRef<HTMLDivElement>(null)
    useTitleWash(ref, 's1', text)
    return <div ref={ref} data-testid="row" style={{ '--accent-blue-soft': '#DCEEFB' } as React.CSSProperties}>{text}</div>
  }

  it('washes the row once when its title lands from the server, not on a typed rename', () => {
    const animate = mock(() => ({}) as Animation)
    const view = render(<Row text="New session" />)
    ;(screen.getByTestId('row') as HTMLElement).animate = animate as unknown as HTMLElement['animate']

    act(() => view.rerender(<Row text="Typed name" />))
    expect(animate).not.toHaveBeenCalled()

    markAutoTitle('s1', 'Server name')
    act(() => view.rerender(<Row text="Server name" />))
    expect(animate).toHaveBeenCalledTimes(1)
    const [, options] = animate.mock.calls[0] as unknown as [Keyframe[], KeyframeAnimationOptions]
    expect(options.duration).toBe(2000)
  })
})
