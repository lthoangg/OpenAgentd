import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

let platformOs = 'ios'
let isTauri = true
let pickResult: unknown = null
let pickShouldReject = false
const pickCalls: Array<{ command: string; args: Record<string, unknown> }> = []

const realPlatform = await import('@/hooks/use-platform')
mock.module('@/hooks/use-platform', () => ({
  ...realPlatform,
  usePlatform: () => ({ isTauri, os: platformOs, isMacOverlay: false, isFullscreen: false }),
  getPlatform: () => ({ isTauri, os: platformOs, isMacOverlay: false, isFullscreen: false }),
}))

mock.module('@tauri-apps/api/core', () => ({
  invoke: (command: string, args: Record<string, unknown>) => {
    pickCalls.push({ command, args })
    return pickShouldReject ? Promise.reject(new Error('no picker')) : Promise.resolve(pickResult)
  },
}))

const { NativeSelect } = await import('@/components/ui/native-select')

const OPTIONS = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
]

function renderSelect(onValueChange: (value: string) => void = () => {}, value = 'light') {
  return render(
    <NativeSelect
      title="Theme"
      value={value}
      onValueChange={onValueChange}
      options={OPTIONS}
      fallback={<div data-testid="fallback">own select</div>}
    />,
  )
}

beforeEach(() => {
  platformOs = 'ios'
  isTauri = true
  pickResult = null
  pickShouldReject = false
  pickCalls.length = 0
})

afterEach(cleanup)

describe('NativeSelect', () => {
  it('renders the caller’s own select outside the mobile shell', () => {
    isTauri = false
    renderSelect()
    expect(screen.getByTestId('fallback')).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('renders the caller’s own select on desktop platforms', () => {
    platformOs = 'macos'
    renderSelect()
    expect(screen.getByTestId('fallback')).toBeTruthy()
  })

  it('is a labelled listbox button showing the current choice in the mobile shell', () => {
    renderSelect()
    const button = screen.getByRole('button')
    expect(button.getAttribute('aria-haspopup')).toBe('listbox')
    expect(button.getAttribute('aria-label')).toBe('Theme: Light')
    expect(button.textContent).toBe('Light')
    expect(screen.queryByTestId('fallback')).toBeNull()
  })

  it('opens the native picker with the options and current value, and applies the choice', async () => {
    pickResult = 'dark'
    const chosen: string[] = []
    renderSelect((v) => chosen.push(v))
    fireEvent.click(screen.getByRole('button'))
    await waitFor(() => expect(chosen).toEqual(['dark']))
    expect(pickCalls).toEqual([
      {
        command: 'pick_one',
        args: {
          title: 'Theme',
          options: [
            { id: 'light', label: 'Light' },
            { id: 'dark', label: 'Dark' },
          ],
          selected: 'light',
        },
      },
    ])
  })

  it('changes nothing when the picker is dismissed or the current value is picked again', async () => {
    const chosen: string[] = []
    renderSelect((v) => chosen.push(v))
    fireEvent.click(screen.getByRole('button'))
    await waitFor(() => expect(pickCalls).toHaveLength(1))
    // Let the first pick settle: a tap while one is open is ignored.
    await new Promise((resolve) => setTimeout(resolve, 0))
    pickResult = 'light'
    fireEvent.click(screen.getByRole('button'))
    await waitFor(() => expect(pickCalls).toHaveLength(2))
    expect(chosen).toEqual([])
    expect(screen.queryByTestId('fallback')).toBeNull()
  })

  it('swaps in the caller’s own select when the native picker fails', async () => {
    pickShouldReject = true
    renderSelect()
    fireEvent.click(screen.getByRole('button'))
    expect(await screen.findByTestId('fallback')).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('shows the placeholder when the value matches no option', () => {
    render(
      <NativeSelect
        title="Theme"
        value="sepia"
        placeholder="Choose…"
        onValueChange={() => {}}
        options={OPTIONS}
        fallback={null}
      />,
    )
    expect(screen.getByRole('button').textContent).toBe('Choose…')
  })
})
