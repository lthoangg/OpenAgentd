/**
 * What `useSkippableTimers` promises the tests that use it: a held timer can
 * be run early, and one nobody skips still fires on time.
 */
import { afterEach, describe, expect, it } from 'bun:test'

import { useSkippableTimers } from './fake-timers'

describe('useSkippableTimers', () => {
  let timers: ReturnType<typeof useSkippableTimers>
  afterEach(() => timers.restore())

  it('runs the timers due within a skip, in due order, with the ones they schedule', () => {
    timers = useSkippableTimers({ atLeast: 100 })
    const ran: string[] = []
    setTimeout(() => ran.push('2.5 s'), 2500)
    setTimeout(() => {
      ran.push('0.8 s')
      setTimeout(() => ran.push('0.8 s + 1 s'), 1000)
      setTimeout(() => ran.push('0.8 s + 5 s'), 5000)
    }, 800)
    setTimeout(() => ran.push('4 s'), 4000)

    timers.skip(3000)
    expect(ran).toEqual(['0.8 s', '0.8 s + 1 s', '2.5 s'])
    timers.skip(1000)
    expect(ran).toEqual(['0.8 s', '0.8 s + 1 s', '2.5 s', '4 s'])
  })

  it('does not run a cleared timer, and passes arguments on', () => {
    timers = useSkippableTimers({ atLeast: 100 })
    const ran: unknown[] = []
    clearTimeout(setTimeout(() => ran.push('cleared'), 500))
    setTimeout((a: string, b: number) => ran.push([a, b]), 500, 'a', 1)
    timers.skip(500)
    expect(ran).toEqual([['a', 1]])
  })

  it('still fires a timer nobody skips, held or not, and only once', async () => {
    timers = useSkippableTimers({ atLeast: 100 })
    const ran: string[] = []
    setTimeout(() => ran.push('short'), 10)
    setTimeout(() => ran.push('held'), 120)
    await new Promise((resolve) => setTimeout(resolve, 300))
    timers.skip(1000)
    expect(ran).toEqual(['short', 'held'])
  })

  it('drops what is still held on restore', async () => {
    timers = useSkippableTimers({ atLeast: 100 })
    const ran: string[] = []
    setTimeout(() => ran.push('held'), 120)
    timers.restore()
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(ran).toEqual([])
  })
})
