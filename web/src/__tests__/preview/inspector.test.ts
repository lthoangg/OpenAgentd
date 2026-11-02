/**
 * The preview inspector (`appv3/crates/preview/assets/inspector.js`) that the
 * backend adds to previewed pages, run inside a Happy DOM iframe so it sees
 * a parent window like the review dock.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'

const CODE = readFileSync(new URL('../../../../appv3/crates/preview/assets/inspector.js', import.meta.url), 'utf8')
const NS = 'openagentd-preview'

interface Internals {
  selectorFor: (el: Element) => string
  describe: (el: Element) => Record<string, unknown>
  flush: () => void
  getMode: () => string
  runCommand: (envelope: { id: string; command: Record<string, unknown> }) => Promise<void>
  cursorState: () => { visible: boolean; x: number | null; y: number | null; label: string }
  setCursorTiming: (timing: { move?: number; idle?: number }) => void
}

type FrameWindow = Window & typeof globalThis & { eval: (code: string) => void; __openagentdPreviewInternals: Internals }

let frame: FrameWindow
let received: Record<string, unknown>[]
let posted: { url: string; body: string }[]
let replies: { id: string; ok: boolean; result?: { text?: string; element?: Record<string, unknown> }; error?: string }[]
// The agent long poll: the first GET gets `nextCommand` (if any), later ones hang.
let nextCommand: Record<string, unknown> | null
const onMessage = (event: MessageEvent) => {
  if (event.data?.ns === NS) received.push(event.data)
}

function sendFromParent(data: Record<string, unknown>, source: unknown = frame.parent) {
  frame.dispatchEvent(new frame.MessageEvent('message', { data: { ns: NS, v: 1, ...data }, source: source as MessageEventSource }))
}

beforeEach(() => {
  received = []
  posted = []
  replies = []
  nextCommand = null
  window.addEventListener('message', onMessage)
  const iframe = document.createElement('iframe')
  document.body.appendChild(iframe)
  frame = iframe.contentWindow as FrameWindow
  frame.fetch = (async (url: string, init?: RequestInit) => {
    if (String(url) === '/__openagentd/agent') {
      if (init?.method === 'POST') {
        replies.push(JSON.parse(String(init.body)))
        return new Response(null, { status: 204 })
      }
      if (nextCommand) {
        const body = JSON.stringify(nextCommand)
        nextCommand = null
        return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return new Promise<Response>(() => {})
    }
    posted.push({ url: String(url), body: String(init?.body) })
    return new Response(null, { status: 204 })
  }) as typeof fetch
  frame.document.body.innerHTML = [
    '<main>',
    '<section class="pricing"><button class="cta">Start   free</button><button>Other</button></section>',
    '<div id="uniq"><span>x</span></div>',
    '<p data-testid="note">n</p>',
    '</main>',
  ].join('')
  frame.eval(CODE)
})

afterEach(() => {
  window.removeEventListener('message', onMessage)
  document.body.innerHTML = ''
})

const settle = () => new Promise((resolve) => setTimeout(resolve, 20))
const internals = () => frame.__openagentdPreviewInternals

describe('preview inspector', () => {
  it('reports ready to the dock', async () => {
    await settle()
    expect(received.some((m) => m.type === 'ready' && m.status === 'ok')).toBe(true)
  })

  it('names its document on every ready, and says when the page starts to leave', async () => {
    sendFromParent({ type: 'hello' })
    await settle()
    const docs = received.filter((m) => m.type === 'ready').map((m) => m.doc)
    expect(docs.length).toBe(2)
    expect(typeof docs[0]).toBe('string')
    expect(docs[1]).toBe(docs[0])
    frame.dispatchEvent(new frame.Event('beforeunload'))
    await settle()
    expect(received.some((m) => m.type === 'leaving')).toBe(true)
  })

  it('builds short, stable selectors', () => {
    const doc = frame.document
    const buttons = doc.querySelectorAll('button')
    expect(internals().selectorFor(buttons[1])).toBe('body > main > section > button:nth-of-type(2)')
    expect(internals().selectorFor(doc.querySelector('#uniq span') as Element)).toBe('#uniq > span')
    expect(internals().selectorFor(doc.querySelector('p') as Element)).toBe('p[data-testid="note"]')
    const d = internals().describe(buttons[0])
    expect(d.tag).toBe('button')
    expect(d.classes).toEqual(['cta'])
    expect(d.text).toBe('Start free')
    expect(d.html).toBe('<button class="cta">')
  })

  it('picks elements only in inspect mode and keeps the click from the page', async () => {
    const button = frame.document.querySelector('button.cta') as HTMLButtonElement
    let pageClicks = 0
    button.addEventListener('click', () => pageClicks++)

    button.click()
    expect(pageClicks).toBe(1)

    sendFromParent({ type: 'set-mode', mode: 'inspect' }, {})
    expect(internals().getMode()).toBe('browse')
    sendFromParent({ type: 'set-mode', mode: 'inspect' })
    expect(internals().getMode()).toBe('inspect')

    button.click()
    await settle()
    expect(pageClicks).toBe(1)
    const select = received.find((m) => m.type === 'select') as { element: { selector: string } } | undefined
    expect(select?.element.selector).toBe('body > main > section > button:nth-of-type(1)')

    frame.dispatchEvent(new frame.KeyboardEvent('keydown', { key: 'Escape' }))
    await settle()
    expect(internals().getMode()).toBe('browse')
    expect(received.some((m) => m.type === 'mode' && m.mode === 'browse')).toBe(true)
  })

  it('forwards Alt+C to the dock unless the user is typing', async () => {
    frame.document.body.insertAdjacentHTML('beforeend', '<input id="field">')
    const press = (target: EventTarget) => {
      const event = new frame.KeyboardEvent('keydown', { key: 'ç', code: 'KeyC', altKey: true, bubbles: true, cancelable: true })
      target.dispatchEvent(event)
      return event
    }
    expect(press(frame.document.body).defaultPrevented).toBe(true)
    await settle()
    expect(received.filter((m) => m.type === 'shortcut' && m.name === 'toggle-design')).toHaveLength(1)
    press(frame.document.getElementById('field') as HTMLElement)
    await settle()
    expect(received.filter((m) => m.type === 'shortcut')).toHaveLength(1)
  })

  it('forwards the close-tab shortcut so it never reaches the native Close Window', async () => {
    frame.document.body.insertAdjacentHTML('beforeend', '<input id="field">')
    // Cmd+W on macOS, Ctrl+W elsewhere, matching the dock's own handler.
    const mac = /Mac|iPhone|iPad|iPod/.test(frame.navigator.platform || frame.navigator.userAgent)
    const press = (target: EventTarget, extra: KeyboardEventInit = {}) => {
      const event = new frame.KeyboardEvent('keydown', { key: 'w', code: 'KeyW', metaKey: mac, ctrlKey: !mac, bubbles: true, cancelable: true, ...extra })
      target.dispatchEvent(event)
      return event
    }
    const closes = () => received.filter((m) => m.type === 'shortcut' && m.name === 'close-tab')
    expect(press(frame.document.body).defaultPrevented).toBe(true)
    // Also from a text field: the dock closes its tab from fields too.
    expect(press(frame.document.getElementById('field') as HTMLElement).defaultPrevented).toBe(true)
    await settle()
    expect(closes()).toHaveLength(2)

    // Other combinations stay with the page.
    expect(press(frame.document.body, { shiftKey: true }).defaultPrevented).toBe(false)
    expect(press(frame.document.body, { metaKey: !mac, ctrlKey: mac }).defaultPrevented).toBe(false)
    expect(press(frame.document.body, { metaKey: false, ctrlKey: false }).defaultPrevented).toBe(false)
    await settle()
    expect(closes()).toHaveLength(2)
  })

  describe('with the dock keymap', () => {
    const KEYS_NS = 'openagentd-keys'
    let keys: Record<string, unknown>[]
    const onKeys = (event: MessageEvent) => { if (event.data?.ns === KEYS_NS) keys.push(event.data) }
    const keymap = {
      mac: false,
      escape: true,
      chords: [
        { key: 'w', mod: true, shift: false, alt: false },
        { key: 'k', mod: true, shift: false, alt: false },
        { key: 'c', code: 'KeyC', mod: false, shift: false, alt: true },
      ],
    }
    const press = (target: EventTarget, init: KeyboardEventInit) => {
      const event = new frame.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init })
      target.dispatchEvent(event)
      return event
    }

    beforeEach(() => {
      keys = []
      window.addEventListener('message', onKeys)
      sendFromParent({ type: 'keymap', keymap })
    })
    afterEach(() => window.removeEventListener('message', onKeys))

    it('forwards the app chords the page left alone, instead of the fixed shortcuts', async () => {
      expect(press(frame.document.body, { key: 'k', ctrlKey: true }).defaultPrevented).toBe(true)
      press(frame.document.body, { key: 'w', code: 'KeyW', ctrlKey: true })
      press(frame.document.body, { key: 'ç', code: 'KeyC', altKey: true })
      await settle()
      expect(keys.map((m) => m.key)).toEqual(['k', 'w', 'ç'])
      expect(received.filter((m) => m.type === 'shortcut')).toHaveLength(0)
    })

    it('keeps keys the page handled, and Alt chords typed in a field', async () => {
      frame.document.body.insertAdjacentHTML('beforeend', '<input id="field">')
      frame.document.body.addEventListener('keydown', (e) => { if (e.key === 'k') e.preventDefault() }, { once: true })
      press(frame.document.body, { key: 'k', ctrlKey: true })
      expect(press(frame.document.getElementById('field') as HTMLElement, { key: 'ç', code: 'KeyC', altKey: true }).defaultPrevented).toBe(false)
      await settle()
      expect(keys).toHaveLength(0)
    })

    it('forwards unhandled Escape, but Escape leaves inspect mode first', async () => {
      press(frame.document.body, { key: 'Escape' })
      sendFromParent({ type: 'set-mode', mode: 'inspect' })
      press(frame.document.body, { key: 'Escape' })
      await settle()
      expect(keys.map((m) => m.key)).toEqual(['Escape'])
      expect(internals().getMode()).toBe('browse')
    })

    it('forwards Control chords on macOS (⌃`, ⌃⌥←), from fields too, but not with ⌘', async () => {
      sendFromParent({
        type: 'keymap',
        keymap: {
          mac: true,
          escape: false,
          chords: [
            { key: 'w', mod: true, shift: false, alt: false },
            { key: '`', code: 'Backquote', mod: false, ctrl: true, shift: false, alt: false },
            { key: 'ArrowLeft', mod: false, ctrl: true, shift: false, alt: true },
          ],
        },
      })
      frame.document.body.insertAdjacentHTML('beforeend', '<input id="field">')
      const field = frame.document.getElementById('field') as HTMLElement
      expect(press(frame.document.body, { key: '`', code: 'Backquote', ctrlKey: true }).defaultPrevented).toBe(true)
      expect(press(field, { key: 'ArrowLeft', ctrlKey: true, altKey: true }).defaultPrevented).toBe(true)
      expect(press(frame.document.body, { key: '`', code: 'Backquote', ctrlKey: true, metaKey: true }).defaultPrevented).toBe(false)
      expect(press(frame.document.body, { key: 'w', code: 'KeyW', ctrlKey: true }).defaultPrevented).toBe(false)
      expect(press(frame.document.body, { key: 'w', code: 'KeyW', metaKey: true }).defaultPrevented).toBe(true)
      await settle()
      expect(keys.map((m) => m.key)).toEqual(['`', 'ArrowLeft', 'w'])
    })
  })

  it('forwards console output to the dock and the backend', async () => {
    frame.console.error('boom', { a: 1 })
    frame.console.warn(new Error('careful'))
    internals().flush()
    await settle()
    const batch = received.find((m) => m.type === 'console') as { entries: { level: string; message: string }[] } | undefined
    expect(batch?.entries.map((e) => e.level)).toEqual(['error', 'warn'])
    expect(batch?.entries[0].message).toBe('boom {"a":1}')
    expect(batch?.entries[1].message).toContain('careful')
    expect(posted).toHaveLength(1)
    expect(posted[0].url).toBe('/__openagentd/console')
    expect(JSON.parse(posted[0].body).entries).toHaveLength(2)
  })
})

describe('preview inspector — agent commands', () => {
  let seq = 0
  async function run(command: Record<string, unknown>) {
    const id = `c${++seq}`
    await internals().runCommand({ id, command })
    const reply = replies.find((r) => r.id === id)
    if (!reply) throw new Error(`no reply for ${id}`)
    return reply
  }

  beforeEach(() => {
    frame.document.body.innerHTML = [
      '<h1>Pricing</h1>',
      '<p>Billed <b>yearly</b></p>',
      '<div style="display:none"><button>Hidden</button></div>',
      '<form id="f"><label for="email">Email</label><input id="email" name="email">',
      '<select name="plan"><option value="s">Starter</option><option value="p">Pro</option></select>',
      '<input type="checkbox" aria-label="Agree">',
      '<button type="submit" class="cta">Start free</button></form>',
      '<a href="/about">About us</a>',
    ].join('')
    // The cursor jumps instead of gliding, so commands run at once.
    internals().setCursorTiming({ move: 0 })
  })

  it('outlines the page with refs on controls, skipping hidden parts', async () => {
    const reply = await run({ action: 'snapshot' })
    expect(reply.ok).toBe(true)
    const text = reply.result?.text ?? ''
    expect(text.split('\n')[0]).toMatch(/^Page: /)
    expect(text).toContain('Viewport 1024×768, scrolled 0 of 0px')
    expect(text).toContain('heading(1) "Pricing"')
    expect(text).toContain('text "Billed yearly"')
    expect(text).toContain('[e1] input[text] "Email"')
    expect(text).toContain('[e2] select "plan" value="s" options=["Starter", "Pro"]')
    expect(text).toContain('[e3] input[checkbox] "Agree" unchecked')
    expect(text).toContain('[e4] button "Start free"')
    expect(text).toContain('[e5] link "About us" -> /about')
    expect(text).not.toContain('Hidden')
    expect(received.some((m) => m.type === 'agent' && m.action === 'snapshot')).toBe(true)
  })

  it('clicks, fills, checks, selects, and submits with Enter', async () => {
    const doc = frame.document
    let clicks = 0
    let inputs = 0
    let submits = 0
    doc.querySelector('button.cta')?.addEventListener('click', (e) => { clicks++; e.preventDefault() })
    doc.querySelector('#email')?.addEventListener('input', () => inputs++)
    doc.querySelector('form')?.addEventListener('submit', (e) => { submits++; e.preventDefault() })
    await run({ action: 'snapshot' })

    // Design mode is on, but the agent's own events still reach the page.
    sendFromParent({ type: 'set-mode', mode: 'inspect' })
    const clicked = await run({ action: 'click', ref: 'e4' })
    expect(clicked.result?.text).toMatch(/^Clicked <button> "Start free"\. Page is now \S+\.$/)
    expect(clicks).toBe(1)

    expect((await run({ action: 'fill', ref: 'e1', value: 'a@b.co' })).ok).toBe(true)
    expect((doc.querySelector('#email') as HTMLInputElement).value).toBe('a@b.co')
    expect(inputs).toBe(1)
    await run({ action: 'fill', ref: 'e2', value: 'Pro' })
    expect((doc.querySelector('select') as HTMLSelectElement).value).toBe('p')
    await run({ action: 'fill', ref: 'e3', value: 'true' })
    expect((doc.querySelector('input[type=checkbox]') as HTMLInputElement).checked).toBe(true)

    await run({ action: 'press', ref: 'e1', key: 'Enter' })
    expect(submits).toBe(1)
  })

  it('reports bad refs, bad selectors, and foreign navigation as errors', async () => {
    expect(await run({ action: 'click', ref: 'e9' })).toMatchObject({ ok: false, error: expect.stringContaining('No element e9') })
    expect(await run({ action: 'click', selector: '#nope' })).toMatchObject({ ok: false, error: expect.stringContaining('No element matches #nope') })
    expect(await run({ action: 'navigate', to: 'https://example.com/' })).toMatchObject({ ok: false, error: expect.stringContaining('within the preview') })
    expect(await run({ action: 'fill', selector: 'h1', value: 'x' })).toMatchObject({ ok: false, error: expect.stringContaining('not a form field') })
    expect(await run({ action: 'dance' })).toMatchObject({ ok: false, error: 'Unknown action dance.' })
  })

  it('shows a labeled cursor on the acted-on element and fades it when idle', async () => {
    await run({ action: 'snapshot' })
    // Reading the page alone does not bring the cursor up.
    expect(internals().cursorState().visible).toBe(false)

    await run({ action: 'click', ref: 'e3' })
    const r = (frame.document.querySelector('input[type=checkbox]') as HTMLElement).getBoundingClientRect()
    expect(internals().cursorState()).toEqual({ visible: true, x: r.left + r.width / 2, y: r.top + r.height / 2, label: 'Clicking' })

    // The reply waits 250 ms for the page to settle, longer than this idle time.
    internals().setCursorTiming({ idle: 30 })
    await run({ action: 'fill', ref: 'e1', value: 'x' })
    expect(internals().cursorState()).toMatchObject({ visible: false, label: 'Typing' })
  })

  it('waits for text and inspects elements', async () => {
    setTimeout(() => { frame.document.body.insertAdjacentHTML('beforeend', '<p>Saved!</p>') }, 150)
    const waited = await run({ action: 'wait', text: 'Saved!', timeout_ms: 2000 })
    expect(waited.result?.text).toMatch(/^Found "Saved!" after \d+ ms\.$/)
    const timedOut = await run({ action: 'wait', selector: '.never', timeout_ms: 150 })
    expect(timedOut.error).toContain('Timed out after 150 ms')
    const inspected = await run({ action: 'inspect', selector: 'button.cta' })
    expect(inspected.result?.element?.selector).toBe('#f > button')
    expect(String(inspected.result?.element?.outerHTML)).toContain('Start free')
  })

  it('picks commands up from the long poll and posts the result', async () => {
    const iframe = document.createElement('iframe')
    document.body.appendChild(iframe)
    const second = iframe.contentWindow as FrameWindow
    second.document.body.innerHTML = '<button>Go</button>'
    second.fetch = frame.fetch
    nextCommand = { id: 'poll-1', command: { action: 'snapshot' } }
    second.eval(CODE)
    await new Promise((resolve) => setTimeout(resolve, 50))
    const reply = replies.find((r) => r.id === 'poll-1')
    expect(reply?.ok).toBe(true)
    expect(reply?.result?.text).toContain('[e1] button "Go"')
  })
})

describe('preview inspector — React 19 sources', () => {
  const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  function vlq(n: number): string {
    let v = n < 0 ? (-n << 1) | 1 : n << 1
    let out = ''
    do {
      let digit = v & 31
      v >>>= 5
      if (v) digit |= 32
      out += B64[digit]
    } while (v)
    return out
  }
  // Generated line 3, column 5 (the JSX call) maps to Pricing.tsx line 42.
  const map = { version: 3, sources: ['Pricing.tsx'], mappings: `;;${vlq(0)}${vlq(0)}${vlq(10)}${vlq(0)},${vlq(4)}${vlq(0)}${vlq(31)}${vlq(2)}` }
  const withMap = `import x from "/x";\n\nexport const a = jsxDEV("button")\n//# sourceMappingURL=data:application/json;base64,${btoa(JSON.stringify(map))}`

  /** A same-origin frame (the inspector only follows frames from its own origin). */
  async function loadFrame(modules: Record<string, string>) {
    const happyDOM = (window as unknown as { happyDOM: { settings: { fetch: { interceptor: unknown } } } }).happyDOM
    happyDOM.settings.fetch.interceptor = {
      beforeAsyncRequest: async ({ request }: { request: Request }) =>
        request.url.includes('/frame-page') ? new Response('<!doctype html><html><head></head><body></body></html>', { headers: { 'content-type': 'text/html' } }) : undefined,
    }
    const iframe = document.createElement('iframe')
    iframe.src = `${window.location.origin}/frame-page`
    document.body.appendChild(iframe)
    await new Promise((resolve) => iframe.addEventListener('load', resolve))
    happyDOM.settings.fetch.interceptor = null
    const win = iframe.contentWindow as FrameWindow
    const fetched: string[] = []
    win.fetch = (async (url: string, init?: RequestInit) => {
      const u = String(url)
      if (u.endsWith('/__openagentd/agent')) {
        if (init?.method === 'POST') {
          replies.push(JSON.parse(String(init.body)))
          return new Response(null, { status: 204 })
        }
        return new Promise<Response>(() => {})
      }
      fetched.push(u)
      const path = new URL(u).pathname
      return path in modules ? new Response(modules[path]) : new Response('', { status: 404 })
    }) as typeof fetch
    win.eval(CODE)
    return { win, fetched }
  }

  function reactButton(win: Window, stack: string) {
    const button = win.document.createElement('button')
    button.textContent = 'Start free'
    function Pricing() {}
    Object.assign(button, { '__reactFiber$abc': { type: 'button', _debugStack: { stack }, return: { type: Pricing, return: null } } })
    win.document.body.appendChild(button)
  }

  async function inspectSource(win: FrameWindow) {
    const id = `src-${Math.random()}`
    await (win.__openagentdPreviewInternals as Internals).runCommand({ id, command: { action: 'inspect', selector: 'button' } })
    return replies.find((r) => r.id === id)?.result?.element?.source
  }

  it('maps the JSX call site through the module source map (V8 stacks)', async () => {
    const { win, fetched } = await loadFrame({ '/src/Pricing.tsx': withMap })
    const origin = window.location.origin
    reactButton(win, `Error: react-stack-top-frame\n    at exports.jsxDEV (${origin}/node_modules/.vite/deps/react_jsx-dev-runtime.js?v=1:250:30)\n    at Pricing (${origin}/src/Pricing.tsx?t=1:3:5)`)
    expect(await inspectSource(win)).toEqual({ file: '/src/Pricing.tsx', line: 42, component: 'Pricing' })
    // The dependency frame is skipped, and the module is fetched once.
    expect(fetched).toEqual([`${origin}/src/Pricing.tsx?t=1`])
    await inspectSource(win)
    expect(fetched).toHaveLength(1)
  })

  it('reads Safari and Firefox stacks, and falls back to the file without a map', async () => {
    const { win } = await loadFrame({ '/src/Plain.tsx': 'export const a = 1\n' })
    reactButton(win, `jsxDEV@${window.location.origin}/node_modules/.vite/deps/react.js:1:1\nPricing@${window.location.origin}/src/Plain.tsx?t=2:3:5`)
    expect(await inspectSource(win)).toEqual({ file: '/src/Plain.tsx', line: null, component: 'Pricing' })
  })

  it('ignores frames from other origins', async () => {
    const { win, fetched } = await loadFrame({})
    reactButton(win, 'Error\n    at Pricing (https://cdn.example.com/app.js:3:5)')
    expect(await inspectSource(win)).toEqual({ file: null, line: null, component: 'Pricing' })
    expect(fetched).toEqual([])
  })
})
