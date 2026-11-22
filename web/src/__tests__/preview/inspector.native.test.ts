/**
 * The preview inspector in the desktop app's native view of a public site:
 * the top document, with no dock to post to and no preview listener to
 * poll. It queues what it has to say for the app to collect, and takes
 * commands through `window.__openagentdNativeBridge`.
 */
import { beforeEach, describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { Window } from 'happy-dom'

const CODE = readFileSync(new URL('../../../../appv3/crates/preview/assets/inspector.js', import.meta.url), 'utf8')

interface Bridge {
  drain: () => string
  run: (json: string) => boolean
  dock: (json: string) => boolean
}
type Page = Window & { __openagentdNative?: boolean; __openagentdNativeBridge?: Bridge; __openagentdPreviewInternals?: { flush: () => void; getMode: () => string } }

let page: Page
let fetched: string[]

function load(native: boolean): void {
  page = new Window({ url: 'https://shop.example/cart?step=2' }) as Page
  fetched = []
  page.fetch = ((url: string) => {
    fetched.push(String(url))
    return new Promise(() => {})
  }) as unknown as typeof page.fetch
  page.document.body.innerHTML = '<main><button class="pay">Pay now</button><input type="password" value="hunter2"></main>'
  if (native) page.__openagentdNative = true
  page.eval(CODE)
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 30))
const drained = (): Record<string, unknown>[] => {
  const text = page.__openagentdNativeBridge?.drain() ?? ''
  return text ? (JSON.parse(text) as Record<string, unknown>[]) : []
}

beforeEach(() => load(true))

describe('preview inspector in a native view', () => {
  it('does nothing in a top document the app did not mark', () => {
    load(false)
    expect(page.__openagentdNativeBridge).toBeUndefined()
    expect(page.__openagentdPreviewInternals).toBeUndefined()
  })

  it('queues its messages for the app and hands them over once', async () => {
    await settle()
    const first = drained()
    expect(first.some((m) => m.type === 'ready' && m.ns === 'openagentd-preview' && m.path === '/cart?step=2')).toBe(true)
    expect(drained()).toEqual([])
    expect(page.__openagentdNativeBridge?.drain()).toBe('')
  })

  it('never asks the site for a preview listener', async () => {
    page.console.error('boom')
    page.__openagentdPreviewInternals?.flush()
    await settle()
    expect(fetched).toEqual([])
    const entries = drained().filter((m) => m.type === 'console').flatMap((m) => m.entries as { level: string; message: string }[])
    expect(entries.map((e) => `${e.level}:${e.message}`)).toEqual(['error:boom'])
  })

  it("leaves the app shell's own refusals out of the page's console", async () => {
    page.console.warn('IPC custom protocol failed, Tauri will now use the postMessage interface instead TypeError: Load failed')
    page.console.error('Unhandled promise rejection: notification.is_permission_granted not allowed on window "browser/main/shop", webview "browser/main/shop"')
    page.console.error('checkout failed: card not allowed on window display')
    page.__openagentdPreviewInternals?.flush()
    await settle()
    const entries = drained().filter((m) => m.type === 'console').flatMap((m) => m.entries as { message: string }[])
    expect(entries.map((e) => e.message)).toEqual(['checkout failed: card not allowed on window display'])
  })

  it("runs the agent's command and queues the result", async () => {
    await settle()
    drained()
    expect(page.__openagentdNativeBridge?.run(JSON.stringify({ id: 'c1', command: { action: 'snapshot' } }))).toBe(true)
    await settle()
    const reply = drained().find((m) => m.type === 'agent-reply')?.reply as { id: string; ok: boolean; result: { text: string } }
    expect(reply.id).toBe('c1')
    expect(reply.ok).toBe(true)
    expect(reply.result.text).toContain('button "Pay now"')
    // A password's value never reaches the agent.
    expect(reply.result.text).not.toContain('hunter2')
  })

  it('takes dock commands, and refuses text that is not JSON', () => {
    expect(page.__openagentdNativeBridge?.dock(JSON.stringify({ type: 'set-mode', mode: 'inspect' }))).toBe(true)
    expect(page.__openagentdPreviewInternals?.getMode()).toBe('inspect')
    expect(page.__openagentdNativeBridge?.dock('{not json')).toBe(false)
    expect(page.__openagentdNativeBridge?.run('{not json')).toBe(false)
  })
})
