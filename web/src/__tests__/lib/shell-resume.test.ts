import { afterEach, describe, expect, it } from 'bun:test'
import { noteShellResume, shellResumed, watchShellResume } from '@/lib/shell-resume'

let stop: (() => void) | null = null
afterEach(() => {
  stop?.()
  stop = null
})

describe('shellResumed', () => {
  it('resolves at once where no shell reports its resume', async () => {
    noteShellResume(new Promise(() => {}))
    await shellResumed()
  })

  it('waits for the answer noted in the same event', async () => {
    stop = watchShellResume()
    let answer!: () => void
    let done = false
    // The page asks first; the shell's listener notes its poke after it.
    const waiting = shellResumed().then(() => { done = true })
    noteShellResume(new Promise<void>((resolve) => { answer = resolve }))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(done).toBe(false)
    answer()
    await waiting
    expect(done).toBe(true)
  })

  it('goes on after the cap when the shell does not answer', async () => {
    stop = watchShellResume()
    noteShellResume(new Promise(() => {}))
    await shellResumed(5)
  })

  it('does not wait for a poke that failed', async () => {
    stop = watchShellResume()
    noteShellResume(Promise.reject(new Error('no shell')))
    await shellResumed()
  })
})
