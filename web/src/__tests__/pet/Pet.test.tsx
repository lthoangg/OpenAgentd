import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'
import { DEFAULT_PET_SETTINGS, type PetBubble, type PetSettings, type PetView } from '@/pet/state'
import { useFakeTimers } from '../fake-timers'

type Call = [string, Record<string, unknown> | undefined]
let calls: Call[] = []
let view: PetView
let closeMenu: () => void = () => {}
const handlers = new Map<string, (event: { payload: unknown }) => void>()

mock.module('@tauri-apps/api/core', () => ({
  invoke: async (cmd: string, args?: Record<string, unknown>) => {
    calls.push([cmd, args])
    if (cmd === 'pet_state') return view
    // The shell answers once the menu closes.
    if (cmd === 'pet_menu') return new Promise<void>((resolve) => (closeMenu = resolve))
    return undefined
  },
}))

mock.module('@tauri-apps/api/event', () => ({
  listen: async (event: string, handler: (event: { payload: unknown }) => void) => {
    handlers.set(event, handler)
    return () => handlers.delete(event)
  },
}))

const { Pet } = await import('@/pet/Pet')

// Stay put, so no walking animation runs in the tests.
const settings = (patch: Partial<PetSettings> = {}): PetSettings => ({ ...DEFAULT_PET_SETTINGS, enabled: true, movement: 'still', ...patch })

function emit(event: string, payload: unknown) {
  act(() => handlers.get(event)?.({ payload }))
}

const bubble = (patch: Partial<PetBubble> = {}): PetBubble => ({
  id: 'n1',
  kind: 'assistant_done',
  tone: 'done',
  sessionId: 's1',
  title: 'Done · web',
  body: 'Fix the flaky login test',
  ...patch,
})

const fits = () => calls.filter(([cmd]) => cmd === 'pet_fit').map(([, args]) => args as { rects: unknown[]; capture: boolean })
const petEl = () => screen.getByRole('img', { name: /Desktop pet/ })
/** The pet's top-left corner, from its transform. */
function petAt() {
  const match = /translate\(([-\d.]+)px, ([-\d.]+)px\)/.exec(petEl().style.transform)
  return { x: Number(match?.[1]), y: Number(match?.[2]) }
}

async function mount(next: Partial<PetView> = {}) {
  view = { ...view, ...next }
  render(<Pet />)
  await waitFor(() => expect(handlers.has('pet-notification')).toBe(true))
}

beforeEach(() => {
  calls = []
  handlers.clear()
  view = { settings: settings(), status: { running: 0, needsInput: 0 }, shown: true }
})
afterEach(cleanup)

describe('Pet', () => {
  it('draws nothing while the pet is off or hidden', async () => {
    await mount({ settings: settings({ enabled: false }) })
    expect(screen.queryByRole('img')).toBeNull()
    emit('pet-state', { ...view, settings: settings(), shown: false })
    expect(screen.queryByRole('img')).toBeNull()
  })

  it('shows the pet and tells the shell where it can be clicked', async () => {
    await mount()
    await waitFor(() => expect(petEl()).toBeInTheDocument())
    await waitFor(() => expect(fits().at(-1)?.rects).toHaveLength(1))
    expect(fits().at(-1)?.capture).toBe(false)
  })

  it('works while an agent runs and raises an alert when one waits on you', async () => {
    await mount()
    await waitFor(() => expect(petEl()).toBeInTheDocument())
    emit('pet-state', { ...view, status: { running: 1, needsInput: 0 } })
    expect(petEl()).toHaveClass('pet--work')
    emit('pet-state', { ...view, status: { running: 1, needsInput: 1 } })
    expect(petEl()).toHaveClass('pet--alert')
    expect(petEl()).toHaveAttribute('aria-label', 'Desktop pet: an agent needs your answer')
  })

  it('shows a notification in its bubble and opens the session from it', async () => {
    await mount()
    await waitFor(() => expect(petEl()).toBeInTheDocument())
    emit('pet-notification', bubble())
    expect(screen.getByText('Finished')).toBeInTheDocument()
    expect(screen.getByText('Fix the flaky login test')).toBeInTheDocument()
    expect(petEl()).toHaveClass('pet--hop')
    await waitFor(() => expect(fits().at(-1)?.rects).toHaveLength(2))

    fireEvent.click(screen.getByRole('button', { name: 'Open' }))
    expect(calls).toContainEqual(['pet_open', { notificationId: 'n1' }])
    expect(screen.queryByText('Fix the flaky login test')).toBeNull()
  })

  it('asks for an answer and keeps the question until it is answered', async () => {
    await mount()
    await waitFor(() => expect(petEl()).toBeInTheDocument())
    emit('pet-state', { ...view, status: { running: 0, needsInput: 1 } })
    emit('pet-notification', bubble({ id: 'q1', kind: 'input_needed', tone: 'input', title: 'Needs input · api', body: 'Keep the v1 endpoints?' }))
    expect(screen.getByRole('button', { name: 'Answer' })).toBeInTheDocument()
    emit('pet-state', { ...view, status: { running: 1, needsInput: 0 } })
    expect(screen.queryByText('Keep the v1 endpoints?')).toBeNull()
  })

  it('dismisses a bubble without opening it', async () => {
    await mount()
    await waitFor(() => expect(petEl()).toBeInTheDocument())
    emit('pet-notification', bubble())
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(screen.queryByText('Fix the flaky login test')).toBeNull()
    expect(calls.some(([cmd]) => cmd === 'pet_open')).toBe(false)
  })

  it('lists what it missed behind a badge, opened by clicking the badge', async () => {
    await mount()
    await waitFor(() => expect(petEl()).toBeInTheDocument())
    emit('pet-notification', bubble({ id: 'a', title: 'First' }))
    emit('pet-notification', bubble({ id: 'b', title: 'Second' }))
    const badge = screen.getByRole('button', { name: '1 unread' })
    expect(badge).toHaveClass('pet-badge')
    fireEvent.pointerDown(badge, { button: 0, clientX: 10 })
    fireEvent.click(badge)
    expect(screen.getByText('1 unread')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'First' }))
    expect(calls).toContainEqual(['pet_open', { notificationId: 'a' }])
  })

  it('is only poked by a click on its body: it hops and meows, opening nothing', async () => {
    await mount()
    await waitFor(() => expect(petEl()).toBeInTheDocument())
    emit('pet-notification', bubble({ id: 'a', title: 'First' }))
    emit('pet-notification', bubble({ id: 'b', title: 'Second' }))
    fireEvent.pointerDown(petEl(), { button: 0, clientX: 10, clientY: 10 })
    fireEvent.pointerUp(petEl(), { clientX: 10, clientY: 10 })
    expect(screen.queryByText('1 unread')).toBeNull()
    expect(petEl()).toHaveClass('pet--hop')
    expect(screen.getByText('Meow!')).toBeInTheDocument()
    expect(calls.filter(([cmd]) => cmd !== 'pet_fit' && cmd !== 'pet_state')).toEqual([])
  })

  it('opens its menu on a right-click, listing what it missed', async () => {
    await mount()
    await waitFor(() => expect(petEl()).toBeInTheDocument())
    emit('pet-notification', bubble({ id: 'a', title: 'First' }))
    emit('pet-notification', bubble({ id: 'b', title: 'Second' }))
    const shown = fireEvent.contextMenu(petEl(), { clientX: 30, clientY: 40 })
    expect(shown).toBe(false)
    expect(calls).toContainEqual(['pet_menu', { x: 30, y: 40, unread: [{ id: 'a', title: 'First' }] }])
    expect(screen.queryByText('Meow!')).toBeNull()
  })

  it('never shows the browser menu over its bubbles', async () => {
    await mount()
    await waitFor(() => expect(petEl()).toBeInTheDocument())
    emit('pet-notification', bubble())
    expect(fireEvent.contextMenu(screen.getByText('Fix the flaky login test'))).toBe(false)
    expect(calls.some(([cmd]) => cmd === 'pet_menu')).toBe(false)
  })

  it('drops a notification opened from the menu, and clears them all on request', async () => {
    await mount()
    await waitFor(() => expect(petEl()).toBeInTheDocument())
    emit('pet-notification', bubble({ id: 'a', title: 'First' }))
    emit('pet-notification', bubble({ id: 'b', title: 'Second' }))
    emit('pet-notification', bubble({ id: 'c', title: 'Third' }))
    expect(screen.getByRole('button', { name: '2 unread' })).toBeInTheDocument()
    emit('pet-menu-action', { action: 'dismiss', id: 'a' })
    expect(screen.getByRole('button', { name: '1 unread' })).toBeInTheDocument()
    emit('pet-menu-action', { action: 'clear' })
    expect(screen.queryByRole('button', { name: /unread/ })).toBeNull()
    expect(screen.queryByText('Third')).toBeNull()
  })

  it('takes every click while dragged and reports where it was dropped', async () => {
    await mount()
    await waitFor(() => expect(petEl()).toBeInTheDocument())
    fireEvent.pointerDown(petEl(), { button: 0, clientX: 100, clientY: 700 })
    fireEvent.pointerMove(petEl(), { clientX: 160, clientY: 700 })
    await waitFor(() => expect(fits().at(-1)?.capture).toBe(true))
    fireEvent.pointerUp(petEl(), { clientX: 160, clientY: 700 })
    const drop = calls.find(([cmd]) => cmd === 'pet_drag_end')
    expect(drop?.[1]?.x).toEqual(expect.any(Number))
    expect(drop?.[1]?.y).toEqual(expect.any(Number))
    await waitFor(() => expect(fits().at(-1)?.capture).toBe(false))
  })

  it('can be dragged up the screen and reports the height its feet were dropped at', async () => {
    await mount()
    await waitFor(() => expect(petEl()).toBeInTheDocument())
    const bottom = window.innerHeight
    fireEvent.pointerDown(petEl(), { button: 0, clientX: 100, clientY: bottom - 10 })
    fireEvent.pointerMove(petEl(), { clientX: 100, clientY: bottom - 310 })
    fireEvent.pointerUp(petEl(), { clientX: 100, clientY: bottom - 310 })
    const drop = calls.find(([cmd]) => cmd === 'pet_drag_end')
    expect(drop?.[1]?.y).toBe(bottom - 300)
    expect(petEl().style.transform).toContain(`${bottom - 300 - 48}px`)
  })

  it('opens its bubble below when it stands near the top of the screen', async () => {
    await mount({ settings: settings({ position: { display: '', x: 0.5, y: 0 } }) })
    await waitFor(() => expect(petEl()).toBeInTheDocument())
    emit('pet-notification', bubble())
    expect(screen.getByRole('status')).toHaveClass('pet-bubble--below')
  })

  it('opens its bubble above when it stands on the bottom edge', async () => {
    await mount()
    await waitFor(() => expect(petEl()).toBeInTheDocument())
    emit('pet-notification', bubble())
    expect(screen.getByRole('status')).not.toHaveClass('pet-bubble--below')
  })

  it('draws the chosen colour and size', async () => {
    await mount({ settings: settings({ size: 'large', colour: 'blue' }) })
    await waitFor(() => expect(petEl()).toBeInTheDocument())
    expect(petEl().style.width).toBe(`${64 * 1.4}px`)
    expect(petEl().querySelector('rect[fill="#5AA8E2"]')).not.toBeNull()
  })

  it('draws the chosen character, which answers a poke in its own voice', async () => {
    await mount({ settings: settings({ character: 'duck' }) })
    await waitFor(() => expect(petEl()).toBeInTheDocument())
    expect(petEl()).toHaveClass('pet--duck')
    fireEvent.pointerDown(petEl(), { button: 0, clientX: 10 })
    fireEvent.pointerUp(petEl(), { clientX: 10 })
    expect(screen.getByText('Quack!')).toBeInTheDocument()
  })

  it('stands still while its right-click menu is open', async () => {
    await mount({ settings: settings({ movement: 'playful' }) })
    await waitFor(() => expect(petEl()).toBeInTheDocument())
    const timers = useFakeTimers()
    try {
      // Fresh settings restart its sit timer on the fake clock.
      emit('pet-state', { ...view, settings: settings({ movement: 'playful' }) })
      act(() => timers.tick(4000))
      expect(petEl()).toHaveClass('pet--walk')

      fireEvent.contextMenu(petEl(), { clientX: 10, clientY: 10 })
      expect(calls.some(([cmd]) => cmd === 'pet_menu')).toBe(true)
      expect(petEl()).toHaveClass('pet--sit')
      act(() => timers.tick(10_000))
      expect(petEl()).toHaveClass('pet--sit')

      await act(async () => closeMenu())
      act(() => timers.tick(4000))
      expect(petEl()).toHaveClass('pet--walk')
    } finally {
      timers.restore()
    }
  })

  it('runs about now and then when chaotic', async () => {
    await mount({ settings: settings({ movement: 'chaotic' }) })
    await waitFor(() => expect(petEl()).toBeInTheDocument())
    const timers = useFakeTimers()
    try {
      // Fresh settings restart its timers on the fake clock.
      emit('pet-state', { ...view, settings: settings({ movement: 'chaotic' }) })
      expect(petEl()).not.toHaveClass('pet--zoom')
      act(() => timers.tick(120_000))
      expect(petEl()).toHaveClass('pet--zoom')
    } finally {
      timers.restore()
    }
  })

  it('celebrates a finished turn by running about once its bubble is gone', async () => {
    await mount({ settings: settings({ movement: 'playful' }) })
    await waitFor(() => expect(petEl()).toBeInTheDocument())
    const timers = useFakeTimers()
    try {
      emit('pet-notification', bubble())
      expect(petEl()).not.toHaveClass('pet--zoom')
      fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
      act(() => timers.tick(2000))
      expect(petEl()).toHaveClass('pet--zoom')
    } finally {
      timers.restore()
    }
  })

  it('never runs about when calm', async () => {
    await mount({ settings: settings({ movement: 'calm' }) })
    await waitFor(() => expect(petEl()).toBeInTheDocument())
    const timers = useFakeTimers()
    try {
      emit('pet-notification', bubble())
      fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
      act(() => timers.tick(300_000))
      expect(petEl()).not.toHaveClass('pet--zoom')
    } finally {
      timers.restore()
    }
  })

  it('turns to look at the pointer nearby', async () => {
    await mount()
    await waitFor(() => expect(petEl()).toBeInTheDocument())
    const { x, y } = petAt()
    emit('pet-pointer', { x: x - 80, y })
    expect(petEl()).toHaveClass('pet--left')
    emit('pet-pointer', { x: x + 150, y })
    expect(petEl()).not.toHaveClass('pet--left')
  })

  it('pounces at a pointer that rests beside it', async () => {
    await mount({ settings: settings({ movement: 'calm' }) })
    await waitFor(() => expect(petEl()).toBeInTheDocument())
    const timers = useFakeTimers()
    try {
      const { x, y } = petAt()
      emit('pet-pointer', { x: x + 100, y: y + 10 })
      expect(petEl()).not.toHaveClass('pet--hop')
      act(() => timers.tick(1500))
      expect(petEl()).toHaveClass('pet--hop')
    } finally {
      timers.restore()
    }
  })

  it('only watches the pointer when told to stay put', async () => {
    await mount()
    await waitFor(() => expect(petEl()).toBeInTheDocument())
    const timers = useFakeTimers()
    try {
      const { x, y } = petAt()
      emit('pet-pointer', { x: x + 100, y: y + 10 })
      act(() => timers.tick(5000))
      expect(petEl()).not.toHaveClass('pet--hop')
    } finally {
      timers.restore()
    }
  })

  it('jumps onto an open window, rides along when it moves, and falls when it closes', async () => {
    const random = Math.random
    Math.random = () => 0
    await mount({ settings: settings({ movement: 'playful' }) })
    await waitFor(() => expect(petEl()).toBeInTheDocument())
    const ground = petAt()
    const timers = useFakeTimers()
    try {
      emit('pet-windows', [{ id: 1, x: 100, y: 400, width: 500, height: 300 }])
      // Fresh settings restart its sit timer on the fake clock.
      emit('pet-state', { ...view, settings: settings({ movement: 'playful' }) })
      act(() => timers.tick(1000))
      expect(petAt().y).toBe(400 - 48)
      expect(petAt().x).toBeGreaterThanOrEqual(100)
      expect(petAt().x).toBeLessThanOrEqual(600 - 64)
      expect(petEl()).toHaveClass('pet--jump')

      const onWindow = petAt().x
      emit('pet-windows', [{ id: 1, x: 150, y: 450, width: 500, height: 300 }])
      expect(petAt()).toEqual({ x: onWindow + 50, y: 450 - 48 })

      emit('pet-windows', [])
      expect(petAt().y).toBe(ground.y)
    } finally {
      timers.restore()
      Math.random = random
    }
  })

  it('stays on the ground when climbing is off', async () => {
    const random = Math.random
    Math.random = () => 0
    await mount({ settings: settings({ movement: 'playful', climb: false }) })
    await waitFor(() => expect(petEl()).toBeInTheDocument())
    const ground = petAt()
    const timers = useFakeTimers()
    try {
      emit('pet-windows', [{ id: 1, x: 100, y: 400, width: 500, height: 300 }])
      emit('pet-state', { ...view, settings: settings({ movement: 'playful', climb: false }) })
      act(() => timers.tick(1000))
      expect(petAt().y).toBe(ground.y)
    } finally {
      timers.restore()
      Math.random = random
    }
  })
})
