import { beforeEach, describe, expect, it } from 'bun:test'

import {
  KEEP_ALIVE_TTL_MS,
  isShownInTab,
  previewListenerKey,
  usePreviewKeepAliveStore,
} from '@/stores/usePreviewKeepAliveStore'

const WS = '/Users/me/project'
const URL_TARGET = { kind: 'url', url: 'http://localhost:5173/pricing' } as const
const URL_KEY = previewListenerKey(WS, URL_TARGET)
const get = () => usePreviewKeepAliveStore.getState()

beforeEach(() => get().reset())

describe('previewListenerKey', () => {
  it('is one per url origin, and one for all of a workspace\'s files', () => {
    expect(previewListenerKey(WS, { kind: 'url', url: 'http://localhost:5173/a' })).toBe(previewListenerKey(WS, { kind: 'url', url: 'localhost:5173/b?x=1' }))
    expect(previewListenerKey(WS, { kind: 'url', url: 'http://localhost:3000' })).not.toBe(URL_KEY)
    expect(previewListenerKey(WS, { kind: 'file', path: 'a.html' })).toBe(previewListenerKey(WS, { kind: 'file', path: 'docs/b.html' }))
    expect(previewListenerKey('/other', URL_TARGET)).not.toBe(URL_KEY)
  })
})

describe('agent previews', () => {
  it('registers an opened page once per listener and keeps the latest target', () => {
    get().registerAgent(WS, URL_TARGET, 100)
    get().registerAgent(WS, { kind: 'url', url: 'http://localhost:5173/other' }, 200)
    const entries = Object.values(get().agent)
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ workspace: WS, lastAgentUseAt: 200, target: { kind: 'url', url: 'http://localhost:5173/other' } })
  })

  it('keeps the learned listener id when the agent opens the page again', () => {
    get().registerAgent(WS, URL_TARGET, 100)
    get().setAgentPreviewId(URL_KEY, 'p1')
    get().registerAgent(WS, URL_TARGET, 200)
    expect(get().agent[URL_KEY]?.previewId).toBe('p1')
  })

  it('touch refreshes the previews of one workspace only', () => {
    get().registerAgent(WS, URL_TARGET, 100)
    get().registerAgent('/other', URL_TARGET, 100)
    get().touchAgent(WS, 500)
    expect(get().agent[URL_KEY]?.lastAgentUseAt).toBe(500)
    expect(get().agent[previewListenerKey('/other', URL_TARGET)]?.lastAgentUseAt).toBe(100)
  })

  it('expires previews the agent did not use for 15 minutes', () => {
    get().registerAgent(WS, URL_TARGET, 1000)
    get().registerAgent(WS, { kind: 'file', path: 'a.html' }, 1000 + KEEP_ALIVE_TTL_MS / 2)
    get().expire(1000 + KEEP_ALIVE_TTL_MS - 1)
    expect(Object.keys(get().agent)).toHaveLength(2)
    get().expire(1000 + KEEP_ALIVE_TTL_MS)
    expect(Object.keys(get().agent)).toEqual([previewListenerKey(WS, { kind: 'file', path: 'a.html' })])
    // Using a page again before it expires keeps it.
    get().touchAgent(WS, 1000 + KEEP_ALIVE_TTL_MS)
    get().expire(1000 + KEEP_ALIVE_TTL_MS * 1.4)
    expect(Object.keys(get().agent)).toHaveLength(1)
  })

  it('forgets a closed listener by id, and a page by key', () => {
    get().registerAgent(WS, URL_TARGET)
    get().registerAgent(WS, { kind: 'file', path: 'a.html' })
    get().setAgentPreviewId(URL_KEY, 'p1')
    get().forgetPreviewId('p1')
    expect(get().agent[URL_KEY]).toBeUndefined()
    expect(Object.keys(get().agent)).toHaveLength(1)
    get().forgetKey(previewListenerKey(WS, { kind: 'file', path: 'a.html' }))
    expect(get().agent).toEqual({})
  })
})

describe('tabs showing a preview', () => {
  it('matches by listener id, or by key until the id is known', () => {
    get().registerAgent(WS, URL_TARGET)
    const entry = () => get().agent[URL_KEY]!
    expect(isShownInTab(get().tabs, entry())).toBe(false)

    get().showTab('t1', URL_KEY)
    expect(isShownInTab(get().tabs, entry())).toBe(true)
    get().hideTab('t1')
    expect(isShownInTab(get().tabs, entry())).toBe(false)

    // Both ids known: only the same id is the same listener.
    get().setAgentPreviewId(URL_KEY, 'p1')
    get().showTab('t2', URL_KEY, 'p2')
    expect(isShownInTab(get().tabs, entry())).toBe(false)
    get().showTab('t2', URL_KEY, 'p1')
    expect(isShownInTab(get().tabs, entry())).toBe(true)
  })

  it('hands a tab\'s listener id to the agent entry', () => {
    get().registerAgent(WS, URL_TARGET)
    get().showTab('t1', URL_KEY, 'p9')
    expect(get().agent[URL_KEY]?.previewId).toBe('p9')
    get().forgetPreviewId('p9')
    expect(get().agent).toEqual({})
  })

  it('does not notify when nothing changed', () => {
    get().showTab('t1', URL_KEY, 'p1')
    const before = get()
    get().showTab('t1', URL_KEY, 'p1')
    get().hideTab('missing')
    get().expire()
    get().touchAgent(WS)
    expect(get()).toBe(before)
  })
})
