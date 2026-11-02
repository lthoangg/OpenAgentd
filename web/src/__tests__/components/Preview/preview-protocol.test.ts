import { describe, expect, it } from 'bun:test'

import { PREVIEW_NS, PREVIEW_VERSION, commandMessage, parsePageMessage } from '@/components/Preview/preview-protocol'

const ORIGIN = 'http://127.0.0.1:52011'
const frame = {} as Window

function event(data: unknown, overrides: Partial<{ origin: string; source: unknown }> = {}) {
  return { data, origin: overrides.origin ?? ORIGIN, source: (overrides.source ?? frame) as MessageEventSource }
}

const msg = (body: Record<string, unknown>) => ({ ns: PREVIEW_NS, v: PREVIEW_VERSION, ...body })

describe('parsePageMessage', () => {
  it('accepts messages from the frame at its origin', () => {
    expect(parsePageMessage(event(msg({ type: 'ready', path: '/a', title: 'A', status: 'ok' })), ORIGIN, frame)).toEqual({ type: 'ready', path: '/a', title: 'A', status: 'ok' })
    expect(parsePageMessage(event(msg({ type: 'mode', mode: 'browse' })), ORIGIN, frame)).toEqual({ type: 'mode', mode: 'browse' })
  })

  it("reads the page's document id on ready, and the page starting to leave", () => {
    expect(parsePageMessage(event(msg({ type: 'ready', path: '/', title: '', status: 'ok', doc: 'd1' })), ORIGIN, frame)).toEqual({ type: 'ready', path: '/', title: '', status: 'ok', doc: 'd1' })
    expect(parsePageMessage(event(msg({ type: 'leaving' })), ORIGIN, frame)).toEqual({ type: 'leaving' })
  })

  it('ignores other origins, other windows, and foreign payloads', () => {
    const ready = msg({ type: 'ready', path: '/' })
    expect(parsePageMessage(event(ready, { origin: 'http://evil.example' }), ORIGIN, frame)).toBeNull()
    expect(parsePageMessage(event(ready, { source: {} }), ORIGIN, frame)).toBeNull()
    expect(parsePageMessage(event(ready), ORIGIN, null)).toBeNull()
    expect(parsePageMessage(event({ ...ready, ns: 'other' }), ORIGIN, frame)).toBeNull()
    expect(parsePageMessage(event({ ...ready, v: 2 }), ORIGIN, frame)).toBeNull()
    expect(parsePageMessage(event('hello'), ORIGIN, frame)).toBeNull()
    expect(parsePageMessage(event(msg({ type: 'eval', code: 'x' })), ORIGIN, frame)).toBeNull()
  })

  it('normalizes element descriptors and console entries', () => {
    const selected = parsePageMessage(event(msg({
      type: 'select',
      element: { selector: 'main > button', tag: 'button', classes: ['cta', 3], rect: { x: 1, y: 'no' }, styles: { color: 'red', bad: 1 }, source: { file: 'src/A.tsx', line: 4 } },
    })), ORIGIN, frame)
    expect(selected?.type).toBe('select')
    if (selected?.type !== 'select') throw new Error('expected select')
    expect(selected.element.classes).toEqual(['cta'])
    expect(selected.element.rect).toEqual({ x: 1, y: 0, width: 0, height: 0 })
    expect(selected.element.styles).toEqual({ color: 'red' })
    expect(selected.element.source).toEqual({ file: 'src/A.tsx', line: 4, component: null })
    expect(parsePageMessage(event(msg({ type: 'select', element: { tag: 'a' } })), ORIGIN, frame)).toBeNull()

    const logs = parsePageMessage(event(msg({ type: 'console', entries: [{ level: 'error', message: 'boom' }, { level: 'weird', message: 'x' }, { message: 5 }] })), ORIGIN, frame)
    expect(logs).toEqual({ type: 'console', entries: [{ level: 'error', message: 'boom', url: '', ts: 0 }, { level: 'log', message: 'x', url: '', ts: 0 }] })
  })

  it('tags commands with the protocol namespace', () => {
    expect(commandMessage({ type: 'set-mode', mode: 'inspect' })).toEqual({ type: 'set-mode', mode: 'inspect', ns: PREVIEW_NS, v: PREVIEW_VERSION })
  })
})
