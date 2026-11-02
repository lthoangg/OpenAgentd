/**
 * A popover places itself before the frame that shows it. It mounts hidden
 * (it must measure itself to know where to go); placed in a passive effect,
 * its state update waited for a scheduler task, and content that focuses a
 * field on the next frame (the run picker's model search) found it still
 * hidden in WebKit, so the focus was lost and typing did nothing.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'

import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'

const actEnv = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
let root: Root | null = null
let host: HTMLElement | null = null
let previousActEnv: boolean | undefined

afterEach(() => {
  flushSync(() => root?.unmount())
  host?.remove()
  root = null
  host = null
  actEnv.IS_REACT_ACT_ENVIRONMENT = previousActEnv
})

function Harness({ open }: { open: boolean }) {
  return (
    <Popover open={open}>
      <PopoverTrigger>Open</PopoverTrigger>
      <PopoverContent aria-label="Picker">
        <input aria-label="Search" />
      </PopoverContent>
    </Popover>
  )
}

describe('PopoverContent placement', () => {
  it('is visible as soon as the update that opens it commits, with no scheduler task in between', () => {
    // Real scheduling, not act(): act would flush the deferred work too.
    previousActEnv = actEnv.IS_REACT_ACT_ENVIRONMENT
    actEnv.IS_REACT_ACT_ENVIRONMENT = false
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    flushSync(() => root?.render(<Harness open={false} />))

    flushSync(() => root?.render(<Harness open />))

    const content = document.querySelector<HTMLElement>('[data-slot="popover-content"]')
    expect(content).not.toBeNull()
    expect(content?.style.visibility).toBe('visible')
    const search = document.querySelector<HTMLInputElement>('input[aria-label="Search"]')
    search?.focus()
    expect(document.activeElement).toBe(search)
  })
})
