import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import '@testing-library/jest-dom'
import {
  DEFAULT_PET_SETTINGS,
  DUST_MS,
  FRAME_SETTLE_MS,
  FRAME_SHRINK_AFTER_MS,
  FRAME_WAIT_MS,
  JUMP_CROUCH_MS,
  JUMP_LOOK_MS,
  LADDER_FOLD_MS,
  LADDER_GROW_MS,
  LAND_MS,
  climbMs,
  fallMs,
  jumpMs,
  type PetBubble,
  type PetSettings,
  type PetView,
} from '@/pet/state'
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

// Stay put, so no walking animation runs in the tests, and no ladders (a
// test of those turns them on).
const settings = (patch: Partial<PetSettings> = {}): PetSettings => ({ ...DEFAULT_PET_SETTINGS, enabled: true, movement: 'still', toys: false, ...patch })

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
/** How long a leap from one top-left corner to another takes. */
const leapMs = (from: { x: number; y: number }, to: { x: number; y: number }) => jumpMs(Math.hypot(to.x - from.x, to.y - from.y))
const petEl = () => document.querySelector('.pet') as HTMLElement
const bubbleEl = () => document.querySelector('.pet-bubble') as HTMLElement
const question = (patch: Partial<PetBubble> = {}): PetBubble =>
  bubble({ id: 'q1', kind: 'input_needed', tone: 'input', title: 'Needs you · api', body: 'Keep the v1 endpoints?', ...patch })
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
    expect(screen.getByRole('img', { name: 'Desktop pet: an agent needs you' })).toBeInTheDocument()
  })

  // A role="img" around the badge made a live button unreachable for
  // assistive technology; what the pet is doing is now a region of its own.
  it('keeps what it says apart from what can be pressed', async () => {
    await mount()
    await waitFor(() => expect(petEl()).toBeInTheDocument())
    emit('pet-state', { ...view, status: { running: 0, needsInput: 1 } })
    emit('pet-notification', question({ questionId: 'qid-1' }))
    emit('pet-notification', bubble({ id: 'a', title: 'First' }))
    for (const region of screen.getAllByRole('status')) expect(within(region).queryAllByRole('button')).toEqual([])
    expect(within(bubbleEl()).getByRole('status')).toHaveTextContent('Keep the v1 endpoints?')
    expect(petEl().querySelector('[role="img"] button')).toBeNull()
    expect(screen.getByRole('button', { name: '1 unread' })).not.toHaveAttribute('role', 'img')
  })

  it('folds its laptop away before a walk, carries it, and opens it again when it stops', async () => {
    const busy = { running: 1, needsInput: 0 }
    await mount({ settings: settings({ movement: 'calm' }), status: busy })
    await waitFor(() => expect(petEl()).toBeInTheDocument())
    const laptop = () => petEl().querySelector('.pet-laptop')
    const timers = useFakeTimers()
    // The longest sit, so the fold starts right at the end of the window.
    const random = Math.random
    Math.random = () => 0.999
    try {
      // Fresh settings restart its timers on the fake clock.
      emit('pet-state', { ...view, settings: settings({ movement: 'calm' }), status: busy })
      expect(petEl()).toHaveClass('pet--work')
      expect(laptop()?.className).toBe('pet-laptop')

      // Works at least twice the calm pause before folding up.
      act(() => timers.tick(7_900))
      expect(petEl()).not.toHaveClass('pet--folding')
      act(() => timers.tick(12_100))
      expect(petEl()).toHaveClass('pet--folding')
      expect(laptop()).toHaveClass('pet-laptop--folding')
      expect(petEl()).toHaveClass('pet--work')

      act(() => timers.tick(2000))
      expect(petEl()).toHaveClass('pet--walk')
      expect(petEl()).toHaveClass('pet--busy')
      expect(laptop()).toHaveClass('pet-laptop--carried')

      // Told to stay put mid-walk: it sets the laptop down and opens it.
      emit('pet-state', { ...view, settings: settings({ movement: 'still' }), status: busy })
      expect(petEl()).toHaveClass('pet--work')
      expect(petEl()).toHaveClass('pet--unfolding')
      expect(laptop()).toHaveClass('pet-laptop--unfolding')
      act(() => timers.tick(2000))
      expect(petEl()).not.toHaveClass('pet--unfolding')
      expect(laptop()?.className).toBe('pet-laptop')
    } finally {
      Math.random = random
      timers.restore()
    }
  })

  it('works sitting still at its laptop when told to stay put', async () => {
    await mount({ status: { running: 1, needsInput: 0 } })
    await waitFor(() => expect(petEl()).toBeInTheDocument())
    const timers = useFakeTimers()
    try {
      emit('pet-state', { ...view, status: { running: 1, needsInput: 0 } })
      act(() => timers.tick(120_000))
      expect(petEl()).toHaveClass('pet--work')
      expect(petEl()).not.toHaveClass('pet--folding')
      expect(petEl().querySelector('.pet-laptop')?.className).toBe('pet-laptop')
    } finally {
      timers.restore()
    }
  })

  it('never runs about on its own while an agent runs', async () => {
    const busy = { running: 1, needsInput: 0 }
    await mount({ settings: settings({ movement: 'chaotic' }), status: busy })
    await waitFor(() => expect(petEl()).toBeInTheDocument())
    const timers = useFakeTimers()
    try {
      emit('pet-state', { ...view, settings: settings({ movement: 'chaotic' }), status: busy })
      act(() => timers.tick(240_000))
      expect(petEl()).not.toHaveClass('pet--zoom')
    } finally {
      timers.restore()
    }
  })

  it('shows a notification in its bubble and opens the session from it', async () => {
    await mount()
    await waitFor(() => expect(petEl()).toBeInTheDocument())
    emit('pet-notification', bubble())
    expect(screen.getByText('Done')).toBeInTheDocument()
    expect(screen.getByText('Fix the flaky login test')).toBeInTheDocument()
    expect(petEl()).toHaveClass('pet--hop')
    await waitFor(() => expect(fits().at(-1)?.rects).toHaveLength(2))

    fireEvent.click(screen.getByRole('button', { name: 'Open Done · web' }))
    expect(calls).toContainEqual(['pet_open', { notificationId: 'n1' }])
    expect(screen.queryByText('Fix the flaky login test')).toBeNull()
  })

  it('asks for an answer and keeps the question until it is answered', async () => {
    await mount()
    await waitFor(() => expect(petEl()).toBeInTheDocument())
    emit('pet-state', { ...view, status: { running: 0, needsInput: 1 } })
    emit('pet-notification', question())
    expect(screen.getByText('Needs you', { selector: '.pet-chip' })).toBeInTheDocument()
    emit('pet-state', { ...view, status: { running: 1, needsInput: 0 } })
    expect(screen.queryByText('Keep the v1 endpoints?')).toBeNull()
  })

  // The pet only tells: a question is answered in the app, never from the bubble.
  it('shows a question with no buttons but Later, and opens its session on a click', async () => {
    await mount()
    await waitFor(() => expect(petEl()).toBeInTheDocument())
    emit('pet-state', { ...view, status: { running: 0, needsInput: 1 } })
    emit('pet-notification', question({ questionId: 'qid-1' }))
    expect(within(bubbleEl()).getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual(['Open Needs you · api', 'Later'])
    expect(screen.queryByRole('button', { name: 'Open to answer' })).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Open Needs you · api' }))
    expect(calls).toContainEqual(['pet_open', { notificationId: 'q1' }])
    expect(calls.some(([cmd]) => cmd === 'pet_answer')).toBe(false)
  })

  it('drops a question that was answered somewhere else', async () => {
    await mount()
    await waitFor(() => expect(petEl()).toBeInTheDocument())
    emit('pet-state', { ...view, status: { running: 0, needsInput: 2 } })
    emit('pet-notification', question({ sessionId: 'aa-bb' }))
    emit('pet-notification', question({ id: 'q2', sessionId: 'cc', body: 'Second?' }))
    expect(screen.getByText('Keep the v1 endpoints?')).toBeInTheDocument()
    emit('pet-question-answered', { sessionKey: 'aabb' })
    expect(screen.queryByText('Keep the v1 endpoints?')).toBeNull()
    expect(screen.getByText('Second?')).toBeInTheDocument()
  })

  it('dismisses a bubble without opening it', async () => {
    await mount()
    await waitFor(() => expect(petEl()).toBeInTheDocument())
    emit('pet-notification', bubble())
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(screen.queryByText('Fix the flaky login test')).toBeNull()
    expect(calls.some(([cmd]) => cmd === 'pet_open')).toBe(false)
    // Dismissed here is read everywhere: the notch and the sidebar clear it too.
    expect(calls).toContainEqual(['pet_dismiss', { notificationIds: ['n1'] }])
  })

  it('only hides a dismissed question: it still waits on you elsewhere', async () => {
    await mount()
    await waitFor(() => expect(petEl()).toBeInTheDocument())
    emit('pet-state', { ...view, status: { running: 0, needsInput: 1 } })
    emit('pet-notification', question({ body: 'Keep v1?' }))
    fireEvent.click(screen.getByRole('button', { name: 'Later' }))
    expect(screen.queryByText('Keep v1?')).toBeNull()
    expect(calls.some(([cmd]) => cmd === 'pet_dismiss')).toBe(false)
  })

  // × used to throw the question away: the pet still said "!" but showed no
  // bubble, no badge, and listed nothing.
  it('folds a question behind the badge on Later and brings it back from there', async () => {
    await mount()
    await waitFor(() => expect(petEl()).toBeInTheDocument())
    emit('pet-state', { ...view, status: { running: 0, needsInput: 1 } })
    emit('pet-notification', question({ body: 'Keep v1?', questionId: 'qid-1' }))
    fireEvent.click(screen.getByRole('button', { name: 'Later' }))
    expect(screen.queryByText('Keep v1?')).toBeNull()
    expect(petEl()).toHaveClass('pet--alert')

    const badge = screen.getByRole('button', { name: '1 needs you' })
    expect(badge).toHaveAttribute('data-needs-you')
    fireEvent.click(badge)
    expect(within(bubbleEl()).getByText('Needs you')).toBeInTheDocument()
    fireEvent.click(within(bubbleEl()).getByRole('button', { name: 'Needs you · api' }))
    expect(screen.getByText('Keep v1?')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Open Needs you · api' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /needs you/ })).toBeNull()
  })

  it('shows a newer question even after the older one was put off', async () => {
    await mount()
    await waitFor(() => expect(petEl()).toBeInTheDocument())
    emit('pet-state', { ...view, status: { running: 0, needsInput: 1 } })
    emit('pet-notification', question({ body: 'First?' }))
    fireEvent.click(screen.getByRole('button', { name: 'Later' }))
    emit('pet-notification', question({ id: 'q2', body: 'Second?' }))
    expect(screen.getByText('Second?')).toBeInTheDocument()
  })

  it('lists its questions before what it missed in its right-click menu', async () => {
    await mount()
    await waitFor(() => expect(petEl()).toBeInTheDocument())
    emit('pet-state', { ...view, status: { running: 0, needsInput: 1 } })
    emit('pet-notification', bubble({ id: 'a', title: 'First' }))
    emit('pet-notification', question({ title: 'Needs you · api' }))
    fireEvent.contextMenu(petEl(), { clientX: 30, clientY: 40 })
    expect(calls).toContainEqual(['pet_menu', { x: 30, y: 40, unread: [{ id: 'a', title: 'First' }], questions: [{ id: 'q1', title: 'Needs you · api' }] }])
  })

  it('drops the bubbles of a session read somewhere else, keeping its question', async () => {
    await mount()
    await waitFor(() => expect(petEl()).toBeInTheDocument())
    emit('pet-notification', bubble({ id: 'a', sessionId: 'aa-bb', title: 'First' }))
    emit('pet-notification', bubble({ id: 'b', sessionId: 'cc', title: 'Second' }))
    emit('pet-notification', bubble({ id: 'c', sessionId: 'AABB', title: 'Third' }))
    expect(screen.getByRole('button', { name: '2 unread' })).toBeInTheDocument()
    emit('pet-session-read', { sessionKey: 'aabb' })
    expect(screen.queryByText('Third')).toBeNull()
    expect(screen.getByRole('button', { name: '1 unread' })).toBeInTheDocument()
    expect(calls.some(([cmd]) => cmd === 'pet_dismiss')).toBe(false)
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
    expect(calls).toContainEqual(['pet_menu', { x: 30, y: 40, unread: [{ id: 'a', title: 'First' }], questions: [] }])
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
    expect(calls).toContainEqual(['pet_dismiss', { notificationIds: ['c', 'b'] }])
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
    expect(bubbleEl()).toHaveClass('pet-bubble--below')
  })

  it('opens its bubble above when it stands on the bottom edge', async () => {
    await mount()
    await waitFor(() => expect(petEl()).toBeInTheDocument())
    emit('pet-notification', bubble())
    expect(bubbleEl()).not.toHaveClass('pet-bubble--below')
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

  it('does not turn to follow the pointer nearby', async () => {
    await mount()
    await waitFor(() => expect(petEl()).toBeInTheDocument())
    const { x, y } = petAt()
    const before = petEl().classList.contains('pet--left')
    emit('pet-pointer', { x: x - 80, y })
    expect(petEl().classList.contains('pet--left')).toBe(before)
    emit('pet-pointer', { x: x + 150, y })
    expect(petEl().classList.contains('pet--left')).toBe(before)
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
      // It first looks up at the window, standing where it was.
      expect(petEl()).toHaveClass('pet--jump-look')
      expect(petAt()).toEqual(ground)
      act(() => timers.tick(JUMP_LOOK_MS))
      expect(petEl()).toHaveClass('pet--jump-crouch')
      expect(petEl()).not.toHaveClass('pet--jump-look')
      expect(petAt()).toEqual(ground)
      act(() => timers.tick(JUMP_CROUCH_MS))
      // Then it leaps: the page stands at the window, the leap draws the way.
      expect(petEl()).toHaveClass('pet--jump-leap')
      expect(petAt().y).toBe(400 - 48)
      expect(petAt().x).toBeGreaterThanOrEqual(100)
      expect(petAt().x).toBeLessThanOrEqual(600 - 64)
      const onWindow = petAt().x
      act(() => timers.tick(leapMs(ground, petAt())))
      // It lands with the fall's squash and a puff of dust.
      expect(petEl()).toHaveClass('pet--land')
      expect(petEl()).not.toHaveClass('pet--jump-leap')
      expect(document.querySelector('.pet-dust')).not.toBeNull()
      expect(petAt()).toEqual({ x: onWindow, y: 400 - 48 })
      emit('pet-windows', [{ id: 1, x: 150, y: 450, width: 500, height: 300 }])
      expect(petAt()).toEqual({ x: onWindow + 50, y: 450 - 48 })

      emit('pet-windows', [])
      expect(petAt().y).toBe(ground.y)
      // It does not just appear on the ground: it falls.
      expect(petEl()).toHaveClass('pet--fall')
      expect(petEl()).toHaveClass('pet--moving')
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

// Jumps, ladders and falls: the pet changes height on its own.
describe('Pet changing height', () => {
  const ledgeWindow = { id: 1, x: 100, y: 400, width: 500, height: 300 }
  const playful = (patch: Partial<PetSettings> = {}) => settings({ movement: 'playful', toys: true, ...patch })
  const ladder = () => document.querySelector('.pet-ladder')
  const dust = () => document.querySelector('.pet-dust')
  /** Through the rest of a jump that has started from `from`: crouch, leap, land. */
  const jumpThrough = (timers: ReturnType<typeof useFakeTimers>, from: { x: number; y: number }) => {
    act(() => timers.tick(JUMP_LOOK_MS))
    act(() => timers.tick(JUMP_CROUCH_MS))
    act(() => timers.tick(leapMs(from, petAt())))
    act(() => timers.tick(LAND_MS))
  }

  /** What the leap's animations were given, and whether they were cancelled. */
  type Leap = { frames: Array<{ transform: string }>; options: KeyframeAnimationOptions; cancelled: boolean }
  /** Stand in for the Web Animations API, which the test DOM may not have. */
  function recordLeaps(): { leaps: Leap[]; restore: () => void } {
    const leaps: Leap[] = []
    const proto = HTMLElement.prototype as unknown as { animate?: unknown }
    const before = proto.animate
    proto.animate = function (frames: Array<{ transform: string }>, options: KeyframeAnimationOptions) {
      const leap: Leap = { frames, options, cancelled: false }
      leaps.push(leap)
      return { cancel: () => (leap.cancelled = true) }
    }
    return { leaps, restore: () => (proto.animate = before) }
  }
  /** The x and y of a keyframe's translate. */
  const frameAt = (frame: { transform: string }) => {
    const match = /translate\(([-\d.e]+)px, ([-\d.e]+)px\)/.exec(frame.transform)
    return { x: Number(match?.[1]), y: Number(match?.[2]) }
  }

  /**
   * Mount a pet and run `body`, with nothing left to the wall clock: the
   * fake timers are installed before the pet mounts (so none of its timers
   * is real and can fire early on a slow machine), animation frames never
   * run, the shell's answers are flushed as promises (no `waitFor`, which
   * polls on timers), and every random roll is `roll`.
   */
  async function scene(next: Partial<PetView>, body: (timers: ReturnType<typeof useFakeTimers>, ground: { x: number; y: number }) => void | Promise<void>, roll = 0) {
    const random = Math.random
    const { requestAnimationFrame: raf, cancelAnimationFrame: cancelRaf } = globalThis
    Math.random = () => roll
    globalThis.requestAnimationFrame = (() => 0) as typeof requestAnimationFrame
    globalThis.cancelAnimationFrame = (() => {}) as typeof cancelAnimationFrame
    const timers = useFakeTimers()
    try {
      view = { ...view, ...next }
      render(<Pet />)
      // The mocked shell calls resolve as promises: let them, a turn at a time.
      for (let turn = 0; turn < 50 && !(handlers.has('pet-notification') && document.querySelector('.pet')); turn += 1) {
        await act(async () => {
          await Promise.resolve()
        })
      }
      expect(petEl()).toBeInTheDocument()
      const ground = petAt()
      // Fresh settings restart its sit timer on the fake clock.
      emit('pet-state', { ...view, ...next })
      await body(timers, ground)
    } finally {
      timers.restore()
      globalThis.requestAnimationFrame = raf
      globalThis.cancelAnimationFrame = cancelRaf
      Math.random = random
    }
  }

  it('grows a ladder to a tall window, climbs it, and folds it away', async () => {
    await scene({ settings: playful() }, (timers, ground) => {
      emit('pet-windows', [ledgeWindow])
      // A sit later the ladder grows from the ground; the pet waits.
      emit('pet-state', { ...view, settings: playful() })
      act(() => timers.tick(1000))
      expect(ladder()).toHaveClass('pet-ladder--up')
      expect(petEl()).toHaveClass('pet--sit')
      expect(petAt().y).toBe(ground.y)
      const rails = ladder() as HTMLElement
      expect(Number.parseFloat(rails.style.top) + Number.parseFloat(rails.style.height)).toBe(ground.y + 48)

      // Then it climbs, stepping, with the move timed by the height.
      act(() => timers.tick(LADDER_GROW_MS))
      expect(petEl()).toHaveClass('pet--climb')
      expect(petAt().y).toBe(400 - 48)
      expect(petEl().style.getPropertyValue('--pet-move-ms')).toBe(`${climbMs(400 - 48 - ground.y)}ms`)
      expect(ladder()).not.toHaveClass('pet-ladder--fold')

      // At the top the ladder folds away, and the pet stands on the window.
      act(() => timers.tick(climbMs(400 - 48 - ground.y)))
      expect(ladder()).toHaveClass('pet-ladder--fold')
      expect(petEl()).not.toHaveClass('pet--climb')
      act(() => timers.tick(LADDER_FOLD_MS))
      expect(ladder()).toBeNull()
      expect(petEl()).not.toHaveClass('pet--moving')
      expect(petAt().y).toBe(400 - 48)
    })
  })

  it('climbs a ladder down again from a tall window', async () => {
    await scene({ settings: playful() }, (timers, ground) => {
      emit('pet-windows', [ledgeWindow])
      emit('pet-state', { ...view, settings: playful() })
      // One step at a time: each lets the page render before the next timer.
      act(() => timers.tick(1000))
      act(() => timers.tick(LADDER_GROW_MS))
      act(() => timers.tick(climbMs(400 - 48 - ground.y)))
      act(() => timers.tick(LADDER_FOLD_MS))
      expect(ladder()).toBeNull()
      expect(petAt().y).toBe(400 - 48)

      act(() => timers.tick(1000))
      expect(ladder()).toHaveClass('pet-ladder--down')
      act(() => timers.tick(LADDER_GROW_MS))
      expect(petEl()).toHaveClass('pet--climb')
      expect(petAt().y).toBe(ground.y)
      act(() => timers.tick(climbMs(ground.y - (400 - 48))))
      act(() => timers.tick(LADDER_FOLD_MS))
      expect(ladder()).toBeNull()
      expect(petEl()).not.toHaveClass('pet--climb')
    })
  })

  it('takes a short jump, not a ladder, to a low window or with ladders off', async () => {
    await scene({ settings: playful({ toys: false }) }, (timers, ground) => {
      emit('pet-windows', [ledgeWindow])
      emit('pet-state', { ...view, settings: playful({ toys: false }) })
      act(() => timers.tick(1000))
      expect(ladder()).toBeNull()
      expect(petEl()).toHaveClass('pet--jump-look')
      jumpThrough(timers, ground)
      expect(petAt().y).toBe(400 - 48)
      expect(petEl()).not.toHaveClass('pet--jump-leap')
    })
  })

  it('jumps in phases: looks up, crouches, leaps along an arc, lands in dust, then walks on', async () => {
    const stub = recordLeaps()
    try {
      await scene({ settings: playful({ toys: false }) }, (timers, ground) => {
        emit('pet-windows', [ledgeWindow])
        emit('pet-state', { ...view, settings: playful({ toys: false }) })
        act(() => timers.tick(1000))
        // Look: held and sitting, with the look class; nothing moves yet.
        expect(petEl()).toHaveClass('pet--jump-look')
        expect(petEl()).not.toHaveClass('pet--jump-down')
        expect(petEl()).toHaveClass('pet--sit')
        expect(stub.leaps).toHaveLength(0)
        expect(petAt()).toEqual(ground)
        act(() => timers.tick(JUMP_LOOK_MS - 1))
        expect(petEl()).toHaveClass('pet--jump-look')
        act(() => timers.tick(1))
        // Crouch.
        expect(petEl()).toHaveClass('pet--jump-crouch')
        expect(stub.leaps).toHaveLength(0)
        act(() => timers.tick(JUMP_CROUCH_MS))
        // Leap: one animation along the arc, linear in time, kept at its end.
        expect(petEl()).toHaveClass('pet--jump-leap')
        expect(stub.leaps).toHaveLength(1)
        const target = petAt()
        const [leap] = stub.leaps
        const ms = leapMs(ground, target)
        expect(leap.options).toMatchObject({ duration: ms, easing: 'linear', fill: 'forwards' })
        expect(leap.frames.length).toBeGreaterThanOrEqual(12)
        expect(frameAt(leap.frames[0])).toEqual(ground)
        expect(frameAt(leap.frames[leap.frames.length - 1])).toEqual(target)
        // It rises well above the window before it comes down onto it.
        expect(Math.min(...leap.frames.map((f) => frameAt(f).y))).toBeLessThan(target.y - 48 * 0.5)
        expect(leap.cancelled).toBe(false)
        act(() => timers.tick(ms - 1))
        expect(petEl()).toHaveClass('pet--jump-leap')
        expect(dust()).toBeNull()
        act(() => timers.tick(1))
        // Land: the squash and the dust; the animation is let go, the pet placed.
        expect(leap.cancelled).toBe(true)
        expect(petEl()).toHaveClass('pet--land')
        expect(petEl()).not.toHaveClass('pet--jump-leap')
        expect(petEl().style.transform).toBe(`translate(${target.x}px, ${target.y}px)`)
        expect(dust()).not.toBeNull()
        // Held until the landing is over.
        act(() => timers.tick(LAND_MS - 1))
        expect(petEl()).toHaveClass('pet--land')
        act(() => timers.tick(1))
        expect(petEl()).not.toHaveClass('pet--land')
        expect(petEl().className).not.toMatch(/pet--jump/)
        expect(petAt()).toEqual(target)
        act(() => timers.tick(DUST_MS - LAND_MS))
        expect(dust()).toBeNull()
      })
    } finally {
      stub.restore()
    }
  })

  it('jumps back down with a small hop up first, leaning forward rather than looking up', async () => {
    const stub = recordLeaps()
    try {
      await scene({ settings: playful({ toys: false }) }, async (timers, ground) => {
        emit('pet-windows', [ledgeWindow])
        emit('pet-state', { ...view, settings: playful({ toys: false }) })
        act(() => timers.tick(1000))
        jumpThrough(timers, ground)
        const up = petAt()
        expect(up.y).toBe(400 - 48)
        stub.leaps.length = 0
        // The walk that follows never ends here (no animation frames): a menu opened
        // and closed sits it down again, as the end of a walk does.
        fireEvent.contextMenu(petEl(), { clientX: 10, clientY: 10 })
        await act(async () => closeMenu())

        act(() => timers.tick(1000))
        expect(petEl()).toHaveClass('pet--jump-look')
        expect(petEl()).toHaveClass('pet--jump-down')
        act(() => timers.tick(JUMP_LOOK_MS))
        expect(petEl()).not.toHaveClass('pet--jump-down')
        act(() => timers.tick(JUMP_CROUCH_MS))
        expect(petAt().y).toBe(ground.y)
        const [leap] = stub.leaps
        const ys = leap.frames.map((f) => frameAt(f).y)
        expect(ys[0]).toBe(up.y)
        expect(ys[ys.length - 1]).toBe(ground.y)
        // Up first by about a third of the pet's height, then down.
        expect(Math.min(...ys)).toBeLessThan(up.y - 48 * 0.2)
        expect(Math.min(...ys)).toBeGreaterThanOrEqual(up.y - 48 * 0.35 - 0.001)
        act(() => timers.tick(leapMs(up, ground)))
        expect(petEl()).toHaveClass('pet--land')
        act(() => timers.tick(LAND_MS))
        expect(petAt()).toEqual(ground)
      })
    } finally {
      stub.restore()
    }
  })

  it('stops a jump where it is when it is grabbed: no later phase, no landing, the leap cancelled', async () => {
    const stub = recordLeaps()
    try {
      await scene({ settings: playful({ toys: false }) }, (timers, ground) => {
        emit('pet-windows', [ledgeWindow])
        emit('pet-state', { ...view, settings: playful({ toys: false }) })
        act(() => timers.tick(1000))
        act(() => timers.tick(JUMP_LOOK_MS + JUMP_CROUCH_MS))
        expect(petEl()).toHaveClass('pet--jump-leap')
        const [leap] = stub.leaps
        fireEvent.pointerDown(petEl(), { button: 0, clientX: 100, clientY: 100 })
        fireEvent.pointerMove(petEl(), { clientX: 140, clientY: 100 })
        expect(leap.cancelled).toBe(true)
        expect(petEl().className).not.toMatch(/pet--jump/)
        expect(petEl()).toHaveClass('pet--dragging')
        fireEvent.pointerUp(petEl(), { clientX: 140, clientY: 100 })
        // The old timers are gone: no landing puff from the jump that was cut off.
        act(() => timers.tick(leapMs(ground, petAt()) + 1000))
        expect(petEl().className).not.toMatch(/pet--jump/)
      })
    } finally {
      stub.restore()
    }
  })

  it('cancels its leap and its timers when it goes away mid-jump', async () => {
    const stub = recordLeaps()
    try {
      await scene({ settings: playful({ toys: false }) }, (timers) => {
        emit('pet-windows', [ledgeWindow])
        emit('pet-state', { ...view, settings: playful({ toys: false }) })
        act(() => timers.tick(1000))
        act(() => timers.tick(JUMP_LOOK_MS + JUMP_CROUCH_MS))
        expect(stub.leaps).toHaveLength(1)
        cleanup()
        expect(stub.leaps[0].cancelled).toBe(true)
        act(() => timers.tick(5000))
      })
    } finally {
      stub.restore()
    }
  })

  it('still lands where it jumps to when the page has no Web Animations API', async () => {
    const proto = HTMLElement.prototype as unknown as { animate?: unknown }
    const before = proto.animate
    proto.animate = undefined
    try {
      await scene({ settings: playful({ toys: false }) }, (timers, ground) => {
        emit('pet-windows', [ledgeWindow])
        emit('pet-state', { ...view, settings: playful({ toys: false }) })
        act(() => timers.tick(1000))
        jumpThrough(timers, ground)
        expect(petAt().y).toBe(400 - 48)
        expect(petEl().className).not.toMatch(/pet--jump/)
      })
    } finally {
      proto.animate = before
    }
  })

  it('falls and lands when its window goes away, in a puff of dust', async () => {
    await scene({ settings: playful({ toys: false }) }, (timers, ground) => {
      emit('pet-windows', [ledgeWindow])
      emit('pet-state', { ...view, settings: playful({ toys: false }) })
      act(() => timers.tick(1000))
      jumpThrough(timers, ground)
      expect(petAt().y).toBe(400 - 48)
      Math.random = () => 0.99
      emit('pet-windows', [])
      expect(petEl()).toHaveClass('pet--fall')
      expect(petAt().y).toBe(ground.y)
      act(() => timers.tick(fallMs(ground.y - (400 - 48))))
      expect(petEl()).toHaveClass('pet--land')
      expect(dust()).not.toBeNull()
      act(() => timers.tick(LAND_MS))
      expect(petEl()).toHaveClass('pet--sit')
    })
  })

  it('does nothing when told to stay put', async () => {
    await scene({ settings: playful({ movement: 'still' }) }, (timers, ground) => {
      emit('pet-windows', [ledgeWindow])
      emit('pet-state', { ...view, settings: playful({ movement: 'still' }) })
      act(() => timers.tick(240_000))
      expect(ladder()).toBeNull()
      expect(petAt()).toEqual(ground)
    })
  })

  it('gives a reduced-motion user no jump, ladder or fall', async () => {
    const matchMedia = window.matchMedia
    window.matchMedia = ((query: string) => ({ matches: true, media: query, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia
    try {
      await scene({ settings: playful() }, (timers, ground) => {
        emit('pet-windows', [ledgeWindow])
        emit('pet-state', { ...view, settings: playful() })
        act(() => timers.tick(240_000))
        expect(ladder()).toBeNull()
        expect(petEl()).not.toHaveClass('pet--moving')
        expect(petAt()).toEqual(ground)
        // Dropped in mid-air, it stays where it was dropped: nothing falls.
        const bottom = window.innerHeight
        fireEvent.pointerDown(petEl(), { button: 0, clientX: 100, clientY: bottom - 10 })
        fireEvent.pointerMove(petEl(), { clientX: 100, clientY: bottom - 310 })
        fireEvent.pointerUp(petEl(), { clientX: 100, clientY: bottom - 310 })
        expect(calls.find(([cmd]) => cmd === 'pet_drag_end')?.[1]?.y).toBe(bottom - 300)
        act(() => timers.tick(5000))
        expect(petEl()).not.toHaveClass('pet--fall')
        expect(petAt().y).toBe(bottom - 300 - 48)
      })
    } finally {
      window.matchMedia = matchMedia
    }
  })

  it('puts its ladder away for a bubble, and never starts one while a bubble is up', async () => {
    await scene({ settings: playful() }, (timers, ground) => {
      emit('pet-windows', [ledgeWindow])
      emit('pet-state', { ...view, settings: playful() })
      emit('pet-notification', bubble())
      act(() => timers.tick(5000))
      expect(ladder()).toBeNull()
      expect(petAt()).toEqual(ground)

      // A question waiting counts too, with its bubble put off for later.
      fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
      emit('pet-state', { ...view, settings: playful(), status: { running: 0, needsInput: 1 } })
      act(() => timers.tick(5000))
      expect(ladder()).toBeNull()
    })
  })

  it('cuts a ladder short when a bubble arrives', async () => {
    await scene({ settings: playful() }, (timers, ground) => {
      emit('pet-windows', [ledgeWindow])
      emit('pet-state', { ...view, settings: playful() })
      act(() => timers.tick(1000))
      expect(ladder()).not.toBeNull()
      emit('pet-notification', bubble())
      expect(ladder()).toBeNull()
      expect(petAt()).toEqual(ground)
      expect(bubbleEl()).toBeInTheDocument()
    })
  })

  it('never climbs a ladder while an agent runs', async () => {
    const busy = { running: 1, needsInput: 0 }
    await scene({ settings: playful(), status: busy }, (timers) => {
      emit('pet-windows', [ledgeWindow])
      emit('pet-state', { ...view, settings: playful(), status: busy })
      act(() => timers.tick(120_000))
      expect(ladder()).toBeNull()
    })
  })

  it('lets a drop in mid-air fall to the ground and report the ground', async () => {
    await scene({ settings: settings({ movement: 'calm' }) }, (timers, ground) => {
      const bottom = window.innerHeight
      fireEvent.pointerDown(petEl(), { button: 0, clientX: 100, clientY: bottom - 10 })
      fireEvent.pointerMove(petEl(), { clientX: 100, clientY: bottom - 310 })
      expect(petAt().y).toBe(bottom - 300 - 48)
      fireEvent.pointerUp(petEl(), { clientX: 100, clientY: bottom - 310 })
      // What is saved is where it lands, the ground; it falls there.
      expect(calls.find(([cmd]) => cmd === 'pet_drag_end')?.[1]?.y).toBe(bottom)
      expect(petEl()).toHaveClass('pet--fall')
      expect(petAt().y).toBe(ground.y)
      expect(dust()).toBeNull()
      act(() => timers.tick(fallMs(300)))
      expect(petEl()).toHaveClass('pet--land')
      expect(dust()).not.toBeNull()
      act(() => timers.tick(LAND_MS))
      expect(petEl()).toHaveClass('pet--sit')
      expect(petEl()).not.toHaveClass('pet--moving')
    })
  })

  it('lands a drop on the window edge below it, and saves the ground', async () => {
    await scene({ settings: settings({ movement: 'calm' }) }, (timers) => {
      emit('pet-windows', [ledgeWindow])
      const bottom = window.innerHeight
      const x = petAt().x
      expect(x).toBeGreaterThanOrEqual(ledgeWindow.x)
      expect(x).toBeLessThanOrEqual(ledgeWindow.x + ledgeWindow.width - 64)
      fireEvent.pointerDown(petEl(), { button: 0, clientX: x + 10, clientY: bottom - 10 })
      fireEvent.pointerMove(petEl(), { clientX: x + 10, clientY: bottom - 460 })
      fireEvent.pointerUp(petEl(), { clientX: x + 10, clientY: bottom - 460 })
      expect(calls.find(([cmd]) => cmd === 'pet_drag_end')?.[1]?.y).toBe(bottom)
      expect(petAt().y).toBe(400 - 48)
      act(() => timers.tick(5000))
      // It stands on the window: it rides along when the window moves.
      emit('pet-windows', [{ ...ledgeWindow, x: ledgeWindow.x + 40, y: 450 }])
      expect(petAt().y).toBe(450 - 48)
    })
  })

  it('keeps a drop where it was dropped when climbing is off', async () => {
    await scene({ settings: settings({ movement: 'calm', climb: false }) }, (timers) => {
      const bottom = window.innerHeight
      fireEvent.pointerDown(petEl(), { button: 0, clientX: 100, clientY: bottom - 10 })
      fireEvent.pointerMove(petEl(), { clientX: 100, clientY: bottom - 310 })
      fireEvent.pointerUp(petEl(), { clientX: 100, clientY: bottom - 310 })
      expect(calls.find(([cmd]) => cmd === 'pet_drag_end')?.[1]?.y).toBe(bottom - 300)
      expect(petAt().y).toBe(bottom - 300 - 48)
      act(() => timers.tick(5000))
      expect(petEl()).not.toHaveClass('pet--fall')
      expect(petAt().y).toBe(bottom - 300 - 48)
    })
  })

  it('does not move to where the shell echoes its own drop, mid-fall', async () => {
    await scene({ settings: settings({ movement: 'calm' }) }, (timers, ground) => {
      const bottom = window.innerHeight
      fireEvent.pointerDown(petEl(), { button: 0, clientX: 100, clientY: bottom - 10 })
      fireEvent.pointerMove(petEl(), { clientX: 100, clientY: bottom - 310 })
      const x = petAt().x
      fireEvent.pointerUp(petEl(), { clientX: 100, clientY: bottom - 310 })
      // The shell saves the drop and tells the page.
      const saved = { display: 'Built-in', x: x / window.innerWidth, y: 1 }
      emit('pet-state', { ...view, settings: settings({ movement: 'calm', position: saved }) })
      expect(petEl()).toHaveClass('pet--fall')
      expect(petAt()).toEqual({ x, y: ground.y })
    })
  })

  // The window is a lane of the work area, not all of it: the page draws the
  // work area ("area" pixels) through it, asks the shell for the lane it
  // needs, and hides the pet while the lane's top edge moves.
  describe('in a lane window', () => {
    const area = { width: 1024, height: 768 }
    const lane = { x: 0, y: 664, width: 1024, height: 104 }
    const full = { x: 0, y: 0, width: 1024, height: 768 }
    type Fit = { rects: Array<{ x: number; y: number; width: number; height: number }>; capture: boolean; frame?: { x: number; y: number; width: number; height: number } }
    const lastFit = () => fits().at(-1) as unknown as Fit
    const strip = () => document.querySelector('.pet-strip') as HTMLElement
    const shifting = () => strip().classList.contains('pet-strip--shifting')
    const inLane = (patch: Partial<PetSettings> = {}) => ({ settings: settings(patch), area, frame: lane })
    /** The shell's answer to a request for `frame`. */
    const moved = (frame: typeof lane) => emit('pet-frame', { area, frame })

    it('draws the work area offset by the window, so the pet stays where it is in area pixels', async () => {
      await scene(inLane(), () => {
        expect(strip().style.left).toBe('0px')
        expect(strip().style.top).toBe(`${-lane.y}px`)
        expect(strip().style.width).toBe('1024px')
        expect(strip().style.height).toBe('768px')
        expect(petAt().y).toBe(720)
        expect(shifting()).toBe(false)
      })
    })

    it('asks for a lane round the pet, and reports its hit areas in area pixels', async () => {
      await scene(inLane(), () => {
        // The window's own pixels: the pet is 56 below the lane's top.
        petEl().getBoundingClientRect = () => ({ left: 300, top: 56, width: 64, height: 48, right: 364, bottom: 104, x: 300, y: 56, toJSON: () => ({}) })
        moved(lane)
        emit('pet-state', { ...view, settings: settings() })
        const fit = lastFit()
        expect(fit.frame).toEqual(lane)
        expect(fit.rects[0]).toEqual({ x: 296, y: 664 + 56 - 4, width: 72, height: 56 })
        expect(fit.capture).toBe(false)
        // Far smaller than the work area.
        expect(fit.frame!.height).toBeLessThan(area.height / 5)
      })
    })

    it('keeps hit areas in area pixels when the lane has moved', async () => {
      await scene(inLane(), () => {
        petEl().getBoundingClientRect = () => ({ left: 300, top: 300, width: 64, height: 48, right: 364, bottom: 348, x: 300, y: 300, toJSON: () => ({}) })
        moved({ ...lane, y: 400, height: 368 })
        emit('pet-state', { ...view, settings: settings(), frame: { ...lane, y: 400, height: 368 } })
        expect(lastFit().rects[0].y).toBe(400 + 300 - 4)
      })
    })

    it('says nothing about a frame to a shell that does not place one', async () => {
      await scene({ settings: settings() }, () => {
        emit('pet-state', { ...view, settings: settings() })
        expect(lastFit().frame).toBeUndefined()
        expect(strip().style.top).toBe('0px')
      })
    })

    it('is the whole area while dragged, hiding the pet until the window has moved and settled', async () => {
      await scene(inLane(), (timers) => {
        // Pressed at the pet (window pixels), then moved a little up.
        fireEvent.pointerDown(petEl(), { button: 0, clientX: 310, clientY: 56 + 10 })
        fireEvent.pointerMove(petEl(), { clientX: 310, clientY: 56 - 50 })
        expect(lastFit().frame).toEqual(full)
        expect(lastFit().capture).toBe(true)
        expect(shifting()).toBe(true)

        // An answer about some other frame does not show the pet again.
        moved(lane)
        act(() => timers.tick(FRAME_SETTLE_MS + 10))
        expect(shifting()).toBe(true)

        moved(full)
        act(() => timers.tick(FRAME_SETTLE_MS - 1))
        expect(shifting()).toBe(true)
        act(() => timers.tick(1))
        expect(shifting()).toBe(false)
        expect(strip().style.top).toBe('0px')
      })
    })

    it('shows the pet again after a wait even if the shell never answers', async () => {
      await scene(inLane(), (timers) => {
        fireEvent.pointerDown(petEl(), { button: 0, clientX: 310, clientY: 66 })
        fireEvent.pointerMove(petEl(), { clientX: 310, clientY: 6 })
        expect(shifting()).toBe(true)
        act(() => timers.tick(FRAME_WAIT_MS))
        expect(shifting()).toBe(false)
      })
    })

    it('drags in area pixels, so the lane growing under the pointer does not move the pet', async () => {
      await scene(inLane(), (timers) => {
        fireEvent.pointerDown(petEl(), { button: 0, clientX: 310, clientY: 56 + 10 })
        fireEvent.pointerMove(petEl(), { clientX: 310, clientY: 56 - 20 })
        // The pointer is 30 up in the area: the pet followed.
        expect(petAt().y).toBe(720 - 30)
        // The window grew to the whole area (its origin is now the area's): the
        // same spot of the screen, read in the new window pixels.
        moved(full)
        act(() => timers.tick(FRAME_SETTLE_MS))
        fireEvent.pointerMove(petEl(), { clientX: 310, clientY: 664 + 56 - 20 - 100 })
        expect(petAt().y).toBe(720 - 130)
        fireEvent.pointerUp(petEl(), { clientX: 310, clientY: 664 + 56 - 20 - 100 })
        // Dropped: where its feet are, in area pixels.
        expect(calls.find(([cmd]) => cmd === 'pet_drag_end')?.[1]).toEqual({ x: petAt().x, y: 720 - 130 + 48 })
      })
    })

    it('keeps the big window a while after a drop, then shrinks it to a lane round the pet', async () => {
      await scene(inLane(), (timers) => {
        fireEvent.pointerDown(petEl(), { button: 0, clientX: 310, clientY: 66 })
        fireEvent.pointerMove(petEl(), { clientX: 310, clientY: 6 })
        moved(full)
        act(() => timers.tick(FRAME_SETTLE_MS))
        // Dropped higher up (stay put keeps it there).
        fireEvent.pointerMove(petEl(), { clientX: 310, clientY: 400 })
        fireEvent.pointerUp(petEl(), { clientX: 310, clientY: 400 })
        expect(lastFit().frame).toEqual(full)
        act(() => timers.tick(FRAME_SHRINK_AFTER_MS - 1))
        expect(lastFit().frame).toEqual(full)
        act(() => timers.tick(1))
        const top = petAt().y
        expect(lastFit().frame).toEqual({ x: 0, y: top - 56, width: 1024, height: 56 + 48 + 12 })
        // The window's corner moves: the pet is hidden until the shell answers.
        expect(shifting()).toBe(true)
      })
    })

    it('keeps a bigger window for a while after the need has gone, then shrinks it', async () => {
      await scene(inLane(), (timers) => {
        emit('pet-notification', bubble())
        const grown = lastFit().frame!
        expect(grown.y).toBeLessThan(lane.y)
        fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
        moved(grown)
        act(() => timers.tick(FRAME_SETTLE_MS))
        // The bubble is gone, but a bigger window is kept a while.
        expect(lastFit().frame).toEqual(grown)
        act(() => timers.tick(FRAME_SHRINK_AFTER_MS - FRAME_SETTLE_MS - 1))
        expect(lastFit().frame).toEqual(grown)
        act(() => timers.tick(FRAME_SETTLE_MS + 1))
        expect(lastFit().frame).toEqual(lane)
      })
    })

    it('gives a bubble room above the pet, and below it near the top of the screen', async () => {
      await scene(inLane(), () => {
        emit('pet-notification', bubble())
        const above = lastFit().frame!
        expect(above.y).toBeLessThanOrEqual(720 - 16 - 24 - 200)
        expect(above.y + above.height).toBe(768)
      })
      cleanup()
      calls = []
      handlers.clear()
      await scene({ settings: settings({ position: { display: '', x: 0.5, y: 0 } }), area, frame: { x: 0, y: 0, width: 1024, height: 120 } }, () => {
        emit('pet-notification', bubble())
        expect(bubbleEl()).toHaveClass('pet-bubble--below')
        const below = lastFit().frame!
        expect(below.y).toBe(0)
        expect(below.y + below.height).toBeGreaterThanOrEqual(48 + 16 + 24 + 200)
      })
    })

    it('opens its menu at the click in window pixels', async () => {
      await scene({ settings: settings(), area, frame: { x: 0, y: 664, width: 1024, height: 104 } }, () => {
        fireEvent.contextMenu(petEl(), { clientX: 30, clientY: 40 })
        expect(calls).toContainEqual(['pet_menu', { x: 30, y: 40, unread: [], questions: [] }])
      })
    })

    it('waits for a lane that holds the whole ladder before it grows one', async () => {
      const ledgeWindow = { id: 1, x: 100, y: 400, width: 500, height: 300 }
      await scene(inLane({ movement: 'playful', toys: true }), (timers) => {
        emit('pet-windows', [ledgeWindow])
        emit('pet-state', { ...view, settings: settings({ movement: 'playful', toys: true }) })
        act(() => timers.tick(1000))
        // It asked for the room (the climb to y 352) and has not grown a ladder yet.
        const ask = lastFit().frame!
        expect(ask.y).toBeLessThanOrEqual(400 - 48 - 56)
        expect(ask.y + ask.height).toBe(768)
        expect(document.querySelector('.pet-ladder')).toBeNull()
        expect(shifting()).toBe(true)

        // The window has moved: it waits for the page to have settled there.
        moved(ask)
        expect(document.querySelector('.pet-ladder')).toBeNull()
        act(() => timers.tick(FRAME_SETTLE_MS))
        expect(document.querySelector('.pet-ladder')).not.toBeNull()
        expect(shifting()).toBe(false)
        // From here on it sits long between moves.
        Math.random = () => 0.99

        // The lane keeps the whole climb until it is over, and shrinks after.
        act(() => timers.tick(LADDER_GROW_MS))
        expect(petAt().y).toBe(400 - 48)
        act(() => timers.tick(FRAME_SHRINK_AFTER_MS * 2))
        expect(lastFit().frame).toEqual(ask)
        // Over: the ladder folds, the pet sits, and a quiet spell later the lane shrinks to it.
        act(() => timers.tick(climbMs(400 - 48 - 720)))
        act(() => timers.tick(LADDER_FOLD_MS))
        act(() => timers.tick(FRAME_SHRINK_AFTER_MS))
        expect(lastFit().frame).toEqual({ x: 0, y: 352 - 56, width: 1024, height: 56 + 48 + 12 })
      })
    })

    it('starts after a short wait if the shell does not make the room', async () => {
      const ledgeWindow = { id: 1, x: 100, y: 400, width: 500, height: 300 }
      await scene(inLane({ movement: 'playful', toys: true }), (timers) => {
        emit('pet-windows', [ledgeWindow])
        emit('pet-state', { ...view, settings: settings({ movement: 'playful', toys: true }) })
        act(() => timers.tick(1000))
        expect(document.querySelector('.pet-ladder')).toBeNull()
        act(() => timers.tick(FRAME_WAIT_MS))
        expect(document.querySelector('.pet-ladder')).not.toBeNull()
      })
    })

    it('falls at once when the lane reaches the ground, and waits for room when it does not', async () => {
      const ledgeWindow = { id: 1, x: 100, y: 400, width: 500, height: 300 }
      await scene(inLane({ movement: 'playful', toys: false }), (timers, ground) => {
        emit('pet-windows', [ledgeWindow])
        emit('pet-state', { ...view, settings: settings({ movement: 'playful', toys: false }) })
        // It hops up (once the window has room for the whole jump).
        act(() => timers.tick(1000))
        const ask = lastFit().frame!
        // The lane holds the whole arc: the pet clears the window by most of its height.
        expect(ask.y).toBeLessThanOrEqual(400 - 48 - 0.6 * 48 - 56)
        Math.random = () => 0.99
        moved(ask)
        act(() => timers.tick(FRAME_SETTLE_MS))
        expect(petEl()).toHaveClass('pet--jump-look')
        act(() => timers.tick(JUMP_LOOK_MS + JUMP_CROUCH_MS))
        expect(petAt().y).toBe(400 - 48)
        act(() => timers.tick(leapMs(ground, petAt()) + LAND_MS))
        // The window still reaches the ground: it falls straight away.
        emit('pet-windows', [])
        expect(petEl()).toHaveClass('pet--fall')
        expect(petAt().y).toBe(ground.y)
      })
    })

    it('asks for more room, and falls when it has it, if the lane had shrunk to the pet up on its window', async () => {
      const ledgeWindow = { id: 1, x: 100, y: 400, width: 500, height: 300 }
      await scene(inLane({ movement: 'playful', toys: false }), (timers, ground) => {
        emit('pet-windows', [ledgeWindow])
        emit('pet-state', { ...view, settings: settings({ movement: 'playful', toys: false }) })
        act(() => timers.tick(1000))
        Math.random = () => 0.99
        moved(lastFit().frame!)
        act(() => timers.tick(FRAME_SETTLE_MS))
        act(() => timers.tick(JUMP_LOOK_MS + JUMP_CROUCH_MS))
        expect(petAt().y).toBe(400 - 48)
        act(() => timers.tick(leapMs(ground, petAt()) + LAND_MS))
        // Held still up there (its menu is open), the lane shrinks round it.
        fireEvent.contextMenu(petEl(), { clientX: 10, clientY: 10 })
        act(() => timers.tick(FRAME_SHRINK_AFTER_MS))
        const round = lastFit().frame!
        expect(round).toEqual({ x: 0, y: 352 - 56, width: 1024, height: 56 + 48 + 12 })
        moved(round)
        act(() => timers.tick(FRAME_SETTLE_MS))

        // Its window goes: the lane must reach down first.
        emit('pet-windows', [])
        const down = lastFit().frame!
        expect(down.y + down.height).toBe(768)
        expect(petEl()).not.toHaveClass('pet--fall')
        moved(down)
        act(() => timers.tick(FRAME_SETTLE_MS))
        expect(petEl()).toHaveClass('pet--fall')
        expect(petAt().y).toBe(ground.y)
      })
    })
  })
})
