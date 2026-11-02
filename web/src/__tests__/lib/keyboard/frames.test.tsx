/**
 * Keys from embedded pages (Preview, MCP apps): the frame forwards app
 * chords it did not handle, and the host replays them on the iframe so
 * layers and regions apply as if the key was pressed in the app.
 */
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { act, cleanup, render } from '@testing-library/react'
import { useRef } from 'react'

import { getPlatform } from '@/hooks/use-platform'
import { chordOf, APP_SHORTCUTS } from '@/lib/app-shortcuts'
import { _resetKeyboardForTests, registerShortcut } from '@/lib/keyboard/dispatcher'
import { FRAME_KEYS_NS, frameKeyForwarderScript, frameKeymap, useFrameKeys } from '@/lib/keyboard/frames'

afterEach(() => {
  cleanup()
  _resetKeyboardForTests()
  document.body.innerHTML = ''
})

const mac = getPlatform().os === 'macos'
const CLOSE_TAB = { key: 'w', code: 'KeyW', ctrlKey: !mac, metaKey: mac }

type FrameWindow = Window & typeof globalThis & { eval: (code: string) => void }

function loadForwarder(escape = true, keymap = frameKeymap('linux')) {
  const iframe = document.body.appendChild(document.createElement('iframe'))
  const frame = iframe.contentWindow as FrameWindow
  frame.eval(frameKeyForwarderScript({ ...keymap, escape }))
  const received: Record<string, unknown>[] = []
  const onMessage = (event: MessageEvent) => { if (event.data?.ns === FRAME_KEYS_NS) received.push(event.data) }
  window.addEventListener('message', onMessage)
  const press = (init: KeyboardEventInit, handle = false) => {
    const target = frame.document.body
    if (handle) target.addEventListener('keydown', (e) => e.preventDefault(), { once: true })
    const event = new frame.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
    target.dispatchEvent(event)
    return event
  }
  const settle = () => new Promise((resolve) => setTimeout(resolve, 10))
  return { press, received, settle, dispose: () => window.removeEventListener('message', onMessage) }
}

describe('frameKeymap', () => {
  it('lists the app chords with the platform modifier, plus extras', () => {
    const map = frameKeymap('macos', [{ key: 'C', code: 'KeyC', alt: true }])
    expect(map.mac).toBe(true)
    expect(map.chords).toContainEqual({ key: 'w', mod: true, shift: false, alt: false })
    expect(map.chords).toContainEqual({ key: 'c', code: 'KeyC', mod: false, shift: false, alt: true })
    expect(frameKeymap('windows').mac).toBe(false)
  })

  it('keeps the Control chords (⌃⌥ arrows) as Control on every OS', () => {
    const map = frameKeymap('macos')
    expect(map.chords).toContainEqual({ key: 'ArrowLeft', mod: false, ctrl: true, shift: false, alt: true })
    // The app has no terminal key: ⌃` stays with the page.
    expect(map.chords.some((chord) => chord.code === 'Backquote')).toBe(false)
  })
})

describe('frame key forwarder', () => {
  it('forwards app chords and unhandled Escape the page left alone', async () => {
    const { press, received, settle, dispose } = loadForwarder()
    expect(press({ key: 'w', code: 'KeyW', ctrlKey: true }).defaultPrevented).toBe(true)
    press({ key: 'Escape' })
    await settle()
    expect(received.map((m) => m.key)).toEqual(['w', 'Escape'])
    expect(received[0]).toMatchObject({ type: 'key', ctrlKey: true, code: 'KeyW' })
    dispose()
  })

  it('forwards Control chords on macOS (⌃⌥←, ⌃Tab), but not with ⌘ held too', async () => {
    const { press, received, settle, dispose } = loadForwarder(false, frameKeymap('macos', [{ key: 'Tab', ctrl: true }]))
    expect(press({ key: 'ArrowLeft', ctrlKey: true, altKey: true }).defaultPrevented).toBe(true)
    expect(press({ key: 'Tab', ctrlKey: true }).defaultPrevented).toBe(true)
    expect(press({ key: 'ArrowLeft', ctrlKey: true, altKey: true, metaKey: true }).defaultPrevented).toBe(false)
    // ⌘W is still ⌘W, and Ctrl+W is not it on macOS.
    expect(press({ key: 'w', code: 'KeyW', ctrlKey: true }).defaultPrevented).toBe(false)
    await settle()
    expect(received.map((m) => m.key)).toEqual(['ArrowLeft', 'Tab'])
    dispose()
  })

  it('leaves keys the page handled, and keys that are not app chords', async () => {
    const { press, received, settle, dispose } = loadForwarder(false)
    // Excalidraw's ⌘D duplicates; the page claims it first.
    expect(press({ key: 'd', ctrlKey: true }, true).defaultPrevented).toBe(true)
    expect(press({ key: 'c', ctrlKey: true }).defaultPrevented).toBe(false)
    expect(press({ key: 'Escape' }).defaultPrevented).toBe(false)
    await settle()
    expect(received).toHaveLength(0)
    dispose()
  })

  it('leaves chords without ⌘/Ctrl to text fields in the page', async () => {
    const iframe = document.body.appendChild(document.createElement('iframe'))
    const frame = iframe.contentWindow as FrameWindow
    frame.eval(frameKeyForwarderScript(frameKeymap('linux', [{ key: 'C', code: 'KeyC', alt: true }])))
    const field = frame.document.body.appendChild(frame.document.createElement('input'))
    const altC = () => new frame.KeyboardEvent('keydown', { key: 'ç', code: 'KeyC', altKey: true, bubbles: true, cancelable: true })
    const inField = altC()
    field.dispatchEvent(inField)
    const onPage = altC()
    frame.document.body.dispatchEvent(onPage)
    expect(inField.defaultPrevented).toBe(false)
    expect(onPage.defaultPrevented).toBe(true)
  })
})

describe('useFrameKeys', () => {
  function Host({ onFrame }: { onFrame: (frame: HTMLIFrameElement) => void }) {
    const ref = useRef<HTMLIFrameElement>(null)
    useFrameKeys(ref)
    return <iframe ref={(node) => { ref.current = node; if (node) onFrame(node) }} title="app" />
  }

  function forward(frame: HTMLIFrameElement, data: Record<string, unknown>, source: unknown = frame.contentWindow) {
    act(() => {
      window.dispatchEvent(new MessageEvent('message', {
        data: { ns: FRAME_KEYS_NS, v: 1, type: 'key', ...data },
        source: source as MessageEventSource,
      }))
    })
  }

  it('replays a key from its own focused frame through the dispatcher', () => {
    const close = mock(() => {})
    registerShortcut(chordOf(APP_SHORTCUTS.closeTab), close)
    let frame!: HTMLIFrameElement
    render(<Host onFrame={(node) => { frame = node }} />)
    frame.focus()
    forward(frame, { key: 'w', code: 'KeyW', ctrlKey: true, metaKey: true })
    // Wrong platform modifier combination: ⌘+Ctrl never matches.
    expect(close).not.toHaveBeenCalled()
    forward(frame, CLOSE_TAB)
    expect(close).toHaveBeenCalledTimes(1)
  })

  it('ignores keys from other windows or while the frame is not focused', () => {
    const close = mock(() => {})
    registerShortcut(chordOf(APP_SHORTCUTS.closeTab), close)
    let frame!: HTMLIFrameElement
    render(<><Host onFrame={(node) => { frame = node }} /><button type="button">elsewhere</button></>)
    frame.focus()
    forward(frame, CLOSE_TAB, window)
    ;(document.querySelector('button') as HTMLButtonElement).focus()
    forward(frame, CLOSE_TAB)
    expect(close).not.toHaveBeenCalled()
  })
})
