import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'
import { DEFAULT_PET_SETTINGS, type PetBubble, type PetSettings, type PetView } from '@/pet/state'

type Call = [string, Record<string, unknown> | undefined]
let calls: Call[] = []
let view: PetView
const handlers = new Map<string, (event: { payload: unknown }) => void>()

mock.module('@tauri-apps/api/core', () => ({
  invoke: async (cmd: string, args?: Record<string, unknown>) => {
    calls.push([cmd, args])
    if (cmd === 'pet_state') return view
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

  it('lists what it missed behind a badge, opened by clicking the pet', async () => {
    await mount()
    await waitFor(() => expect(petEl()).toBeInTheDocument())
    emit('pet-notification', bubble({ id: 'a', title: 'First' }))
    emit('pet-notification', bubble({ id: 'b', title: 'Second' }))
    expect(screen.getByText('1')).toHaveClass('pet-badge')
    fireEvent.pointerDown(petEl(), { button: 0, clientX: 10 })
    fireEvent.pointerUp(petEl(), { clientX: 10 })
    expect(screen.getByText('1 unread')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'First' }))
    expect(calls).toContainEqual(['pet_open', { notificationId: 'a' }])
  })

  it('takes every click while dragged and reports where it was dropped', async () => {
    await mount()
    await waitFor(() => expect(petEl()).toBeInTheDocument())
    fireEvent.pointerDown(petEl(), { button: 0, clientX: 100 })
    fireEvent.pointerMove(petEl(), { clientX: 160 })
    await waitFor(() => expect(fits().at(-1)?.capture).toBe(true))
    fireEvent.pointerUp(petEl(), { clientX: 160 })
    const drop = calls.find(([cmd]) => cmd === 'pet_drag_end')
    expect(drop?.[1]?.x).toEqual(expect.any(Number))
    await waitFor(() => expect(fits().at(-1)?.capture).toBe(false))
  })

  it('draws the chosen colour and size', async () => {
    await mount({ settings: settings({ size: 'large', colour: 'blue' }) })
    await waitFor(() => expect(petEl()).toBeInTheDocument())
    expect(petEl().style.width).toBe(`${64 * 1.4}px`)
    expect(petEl().querySelector('rect[fill="#5AA8E2"]')).not.toBeNull()
  })
})
