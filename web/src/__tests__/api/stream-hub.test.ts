import { describe, expect, it } from 'bun:test'
import { StreamHub } from '@/api/stream-hub'
import type { ChannelLike, LockManagerLike } from '@/api/stream-hub'
import type { GlobalEventCallbacks } from '@/api/global-events'
import { isTransientNetworkError } from '@/utils/errors'

/** FIFO exclusive locks by name, released when the callback's promise settles. */
function fakeLocks(): LockManagerLike {
  const tails = new Map<string, Promise<unknown>>()
  return {
    request(name, options, callback) {
      const previous = tails.get(name) ?? Promise.resolve()
      const run = new Promise<unknown>((resolve, reject) => {
        let waiting = true
        options.signal?.addEventListener('abort', () => {
          if (waiting) reject(new DOMException('aborted', 'AbortError'))
        })
        previous.then(() => {
          if (!waiting || options.signal?.aborted) return
          waiting = false
          callback().then(resolve, reject)
        })
      })
      tails.set(name, run.catch(() => undefined))
      return run
    },
  }
}

/** Same-name channels see each other's messages, never their own. */
function fakeChannels() {
  const byName = new Map<string, Set<FakeChannel>>()
  class FakeChannel implements ChannelLike {
    onmessage: ((event: { data: unknown }) => void) | null = null
    closed = false
    readonly name: string
    constructor(name: string) {
      this.name = name
      if (!byName.has(name)) byName.set(name, new Set())
      byName.get(name)!.add(this)
    }
    postMessage(message: unknown) {
      for (const peer of byName.get(this.name) ?? []) {
        if (peer === this || peer.closed) continue
        queueMicrotask(() => { if (!peer.closed) peer.onmessage?.({ data: structuredClone(message) }) })
      }
    }
    close() {
      this.closed = true
      byName.get(this.name)?.delete(this)
    }
  }
  return (name: string): ChannelLike => new FakeChannel(name)
}

const settle = async () => { for (let i = 0; i < 6; i++) await new Promise<void>((r) => setTimeout(r, 0)) }

interface Feed { clientId: string | null; callbacks: GlobalEventCallbacks; signal: AbortSignal }

function world(options: { putTimeoutMs?: number } = {}) {
  const locks = fakeLocks()
  const makeChannel = fakeChannels()
  const feeds: Feed[] = []
  const puts: { clientId: string; ids: string[]; sessions: string[] }[] = []
  // ``hang``: the request never answers on its own, as one queued behind the
  // webview's per-host connection limit does; only its signal can end it.
  // ``defer``: the request answers when the test settles it from ``answers``.
  const state = {
    putResult: 'ok' as 'ok' | 'gone' | 'error',
    hang: false,
    defer: false,
    answers: [] as ((result: 'ok' | 'gone' | 'error') => void)[],
  }
  let windows = 0
  let gens = 0
  const makeWindow = (key = 'http://a/api') => {
    const windowId = `w${++windows}`
    const hub = new StreamHub({
      locks,
      makeChannel,
      openStream: (clientId, callbacks, signal) => { feeds.push({ clientId, callbacks, signal }) },
      putSubscriptions: async (clientId, subs, signal) => {
        puts.push({ clientId, ids: subs.map((s) => s.id).sort(), sessions: subs.map((s) => s.session_id).sort() })
        if (state.hang) {
          return new Promise<'error'>((resolve) => signal?.addEventListener('abort', () => resolve('error'), { once: true }))
        }
        if (state.defer) {
          return new Promise<'ok' | 'gone' | 'error'>((resolve) => { state.answers.push(resolve) })
        }
        return state.putResult
      },
      key,
      windowId,
      newId: () => `gen${++gens}`,
      putTimeoutMs: options.putTimeoutMs,
    })
    return hub
  }
  return { feeds, puts, state, makeWindow }
}

function global(hub: StreamHub) {
  const log = { opens: 0, errors: 0, dones: 0, parseErrors: 0, events: [] as string[] }
  const controller = new AbortController()
  hub.subscribeGlobal(
    {
      onOpen: () => { log.opens++ },
      onEvent: (type) => { log.events.push(type) },
      onError: () => { log.errors++ },
      onDone: () => { log.dones++ },
      onParseError: () => { log.parseErrors++ },
    },
    controller.signal,
  )
  return { log, controller }
}

function session(hub: StreamHub, sid: string) {
  const log = { events: [] as string[], dones: 0, errors: [] as Error[] }
  const controller = new AbortController()
  hub.subscribeSession(
    sid,
    { onEvent: (type) => { log.events.push(type) }, onDone: () => { log.dones++ }, onError: (e) => { log.errors.push(e) } },
    controller.signal,
  )
  return { log, controller }
}

const frame = (subId: string, type: string) => ({ sub_id: subId, type, data: {} })

describe('StreamHub: global events', () => {
  it('opens one feed for three windows and fans events out in order', async () => {
    const w = world()
    const [a, b, c] = [w.makeWindow(), w.makeWindow(), w.makeWindow()].map(global)
    await settle()
    expect(w.feeds).toHaveLength(1)

    w.feeds[0].callbacks.onOpen?.()
    w.feeds[0].callbacks.onEvent('title_update', {})
    w.feeds[0].callbacks.onEvent('config_changed', {})
    await settle()

    for (const x of [a, b, c]) {
      expect(x.log.opens).toBe(1)
      expect(x.log.events).toEqual(['title_update', 'config_changed'])
    }
  })

  it('answers a window that starts late without telling the others again', async () => {
    const w = world()
    const early = global(w.makeWindow())
    const other = global(w.makeWindow())
    await settle()
    w.feeds[0].callbacks.onOpen?.()
    await settle()
    const late = global(w.makeWindow())
    await settle()

    expect(late.log.opens).toBe(1)
    expect(early.log.opens).toBe(1)
    expect(other.log.opens).toBe(1)
    expect(w.feeds).toHaveLength(1)
  })

  it('does not reopen the feed when its own consumer reconnects', async () => {
    const w = world()
    const hub = w.makeWindow()
    const first = global(hub)
    await settle()
    w.feeds[0].callbacks.onOpen?.()

    // The hook aborts and subscribes again in one tick.
    first.controller.abort()
    const again = global(hub)
    await settle()

    expect(w.feeds).toHaveLength(1)
    expect(w.feeds[0].signal.aborted).toBe(false)
    expect(again.log.opens).toBe(1)
  })

  it('hands the feed to a waiting window when the leader closes', async () => {
    const w = world()
    const leader = global(w.makeWindow())
    const follower = global(w.makeWindow())
    await settle()
    w.feeds[0].callbacks.onOpen?.()
    await settle()

    leader.controller.abort()
    await settle()
    expect(w.feeds[0].signal.aborted).toBe(true)
    expect(w.feeds).toHaveLength(2)

    w.feeds[1].callbacks.onOpen?.()
    w.feeds[1].callbacks.onEvent('mcp_status_changed', {})
    await settle()
    expect(follower.log.opens).toBe(2)
    expect(follower.log.events).toEqual(['mcp_status_changed'])
  })

  it('reports a dropped feed to the leader and lets a waiting window take over', async () => {
    const w = world()
    const leader = global(w.makeWindow())
    const follower = global(w.makeWindow())
    await settle()
    w.feeds[0].callbacks.onOpen?.()
    w.feeds[0].callbacks.onError?.(new Error('boom'))
    await settle()

    expect(leader.log.errors).toBe(1)
    expect(follower.log.errors).toBe(0)
    expect(w.feeds).toHaveLength(2)
  })

  it('does not share between different backends', async () => {
    const w = world()
    global(w.makeWindow('http://a/api'))
    global(w.makeWindow('http://b/api'))
    await settle()
    expect(w.feeds).toHaveLength(2)
  })

  it('never opens a feed for a window that aborted while waiting for the lock', async () => {
    const w = world()
    const leader = global(w.makeWindow())
    const waiting = global(w.makeWindow())
    await settle()
    waiting.controller.abort()
    leader.controller.abort()
    await settle()
    expect(w.feeds).toHaveLength(1)
  })
})

describe('StreamHub: session streams', () => {
  it('subscribes the leader and a follower on one feed and routes frames to their owner', async () => {
    const w = world()
    const leaderHub = w.makeWindow()
    const followerHub = w.makeWindow()
    const mine = session(leaderHub, 'sid-a')
    await settle()
    expect(w.feeds[0].clientId).toBe('gen1')
    w.feeds[0].callbacks.onOpen?.()
    const theirs = session(followerHub, 'sid-b')
    await settle()

    // One request carries both windows' sessions.
    const last = w.puts.at(-1)!
    expect(last.clientId).toBe('gen1')
    expect(last.sessions).toEqual(['sid-a', 'sid-b'])
    const [leaderSub, followerSub] = [last.ids.find((i) => i.startsWith('w1-'))!, last.ids.find((i) => i.startsWith('w2-'))!]

    const send = w.feeds[0].callbacks.onEvent
    send('session_event', frame(leaderSub, 'message'))
    send('session_event', frame(followerSub, 'thinking'))
    send('session_event', frame(followerSub, 'done'))
    await settle()
    expect(mine.log.events).toEqual(['message'])
    expect(theirs.log.events).toEqual(['thinking', 'done'])
  })

  it('does not pass session frames to the global consumers', async () => {
    const w = world()
    const hub = w.makeWindow()
    const watching = global(hub)
    session(hub, 'sid-a')
    await settle()
    w.feeds[0].callbacks.onOpen?.()
    await settle()
    const id = w.puts.at(-1)!.ids[0]
    w.feeds[0].callbacks.onEvent('session_event', frame(id, 'message'))
    w.feeds[0].callbacks.onEvent('session_stream_end', { sub_id: id })
    w.feeds[0].callbacks.onEvent('title_update', {})
    await settle()
    expect(watching.log.events).toEqual(['title_update'])
  })

  it('ends a subscription when the server says its turn is over, and stops asking for it', async () => {
    const w = world()
    const leaderHub = w.makeWindow()
    const followerHub = w.makeWindow()
    session(leaderHub, 'sid-a')
    await settle()
    w.feeds[0].callbacks.onOpen?.()
    const theirs = session(followerHub, 'sid-b')
    await settle()
    const followerSub = w.puts.at(-1)!.ids.find((i) => i.startsWith('w2-'))!

    w.feeds[0].callbacks.onEvent('session_stream_end', { sub_id: followerSub })
    await settle()
    expect(theirs.log.dones).toBe(1)
    expect(w.puts.at(-1)!.sessions).toEqual(['sid-a'])
  })

  it('drops a subscription from the request when its window aborts it', async () => {
    const w = world()
    const leaderHub = w.makeWindow()
    const followerHub = w.makeWindow()
    session(leaderHub, 'sid-a')
    await settle()
    w.feeds[0].callbacks.onOpen?.()
    const theirs = session(followerHub, 'sid-b')
    await settle()
    expect(w.puts.at(-1)!.sessions).toEqual(['sid-a', 'sid-b'])

    theirs.controller.abort()
    await settle()
    expect(w.puts.at(-1)!.sessions).toEqual(['sid-a'])
  })

  it('swaps a reconnecting window\'s subscription in one request', async () => {
    const w = world()
    const hub = w.makeWindow()
    const first = session(hub, 'sid-a')
    await settle()
    w.feeds[0].callbacks.onOpen?.()
    await settle()
    const before = w.puts.at(-1)!.ids[0]

    first.controller.abort()
    session(hub, 'sid-a')
    await settle()
    const after = w.puts.at(-1)!
    expect(after.ids).toHaveLength(1)
    expect(after.ids[0]).not.toBe(before)
    expect(w.feeds).toHaveLength(1)
  })

  it('subscribes a follower that asked before the feed had opened', async () => {
    const w = world()
    const leaderHub = w.makeWindow()
    const followerHub = w.makeWindow()
    global(leaderHub)
    const theirs = session(followerHub, 'sid-b')
    await settle()
    expect(w.puts).toHaveLength(0)

    w.feeds[0].callbacks.onOpen?.()
    await settle()
    expect(w.puts.at(-1)!.sessions).toEqual(['sid-b'])
    w.feeds[0].callbacks.onEvent('session_event', frame(w.puts.at(-1)!.ids[0], 'message'))
    await settle()
    expect(theirs.log.events).toEqual(['message'])
  })

  it('fails every subscription with a transient error when the feed drops', async () => {
    const w = world()
    const leaderHub = w.makeWindow()
    const followerHub = w.makeWindow()
    const mine = session(leaderHub, 'sid-a')
    await settle()
    w.feeds[0].callbacks.onOpen?.()
    const theirs = session(followerHub, 'sid-b')
    await settle()

    w.feeds[0].callbacks.onError?.(new Error('boom'))
    await settle()
    expect(mine.log.errors).toHaveLength(1)
    expect(isTransientNetworkError(mine.log.errors[0])).toBe(true)

    // The follower learns of it when the next feed opens, and resubscribes through its store.
    expect(w.feeds).toHaveLength(2)
    w.feeds[1].callbacks.onOpen?.()
    await settle()
    expect(theirs.log.errors).toHaveLength(1)
    expect(isTransientNetworkError(theirs.log.errors[0])).toBe(true)
  })

  it('fails the subscriptions bound to a leader that went away, in the window that takes over too', async () => {
    const w = world()
    const leaderHub = w.makeWindow()
    const followerHub = w.makeWindow()
    const keep = global(leaderHub)
    await settle()
    w.feeds[0].callbacks.onOpen?.()
    const theirs = session(followerHub, 'sid-b')
    await settle()
    expect(w.puts.at(-1)!.sessions).toEqual(['sid-b'])

    keep.controller.abort()
    await settle()
    // The follower was the next in line: it leads now, and its old subscription is gone.
    expect(w.feeds).toHaveLength(2)
    expect(theirs.log.errors).toHaveLength(1)

    // Subscribing again lands on its own feed.
    w.feeds[1].callbacks.onOpen?.()
    session(followerHub, 'sid-b')
    await settle()
    expect(w.puts.at(-1)!.clientId).toBe('gen2')
    expect(w.puts.at(-1)!.sessions).toEqual(['sid-b'])
  })

  it('reopens the feed when the server no longer knows it', async () => {
    const w = world()
    const hub = w.makeWindow()
    const watching = global(hub)
    session(hub, 'sid-a')
    await settle()
    w.feeds[0].callbacks.onOpen?.()
    await settle()
    expect(w.puts).toHaveLength(1)

    w.state.putResult = 'gone'
    session(hub, 'sid-b')
    await settle()
    // Not an older server: a first request had already been accepted.
    expect(hub.muxSupported).toBeNull()
    expect(watching.log.errors).toBe(1)
  })

  it('falls back to per-session streams on a server that cannot carry them', async () => {
    const w = world()
    const leaderHub = w.makeWindow()
    const followerHub = w.makeWindow()
    const watching = global(leaderHub)
    const mine = session(leaderHub, 'sid-a')
    const theirs = session(followerHub, 'sid-b')
    await settle()
    w.state.putResult = 'gone'
    w.feeds[0].callbacks.onOpen?.()
    await settle()

    expect(leaderHub.muxSupported).toBe(false)
    expect(followerHub.muxSupported).toBe(false)
    expect(mine.log.errors).toHaveLength(1)
    expect(theirs.log.errors).toHaveLength(1)
    // The global feed it is already reading is untouched.
    expect(w.feeds).toHaveLength(1)
    expect(w.feeds[0].signal.aborted).toBe(false)
    expect(watching.log.errors).toBe(0)
  })

  it('does not send an empty request when nothing is subscribed', async () => {
    const w = world()
    global(w.makeWindow())
    await settle()
    w.feeds[0].callbacks.onOpen?.()
    await settle()
    expect(w.puts).toHaveLength(0)
  })

  it('restarts the feed when a subscription request never answers, instead of starving every later subscription', async () => {
    const w = world({ putTimeoutMs: 0 })
    const hub = w.makeWindow()
    const watching = global(hub)
    await settle()
    w.feeds[0].callbacks.onOpen?.()
    await settle()

    w.state.hang = true
    const first = session(hub, 'sid-a')
    await settle()
    // The stuck request fails the feed: the session store reconnects from a
    // transient error, and the global consumer reopens the feed.
    expect(first.log.errors).toHaveLength(1)
    expect(isTransientNetworkError(first.log.errors[0])).toBe(true)
    expect(watching.log.errors).toBe(1)
    expect(w.feeds[0].signal.aborted).toBe(true)

    // On the reopened feed a new subscription goes out at once.
    w.state.hang = false
    global(hub)
    await settle()
    w.feeds.at(-1)!.callbacks.onOpen?.()
    const second = session(hub, 'sid-a')
    await settle()
    expect(w.puts.at(-1)!.sessions).toEqual(['sid-a'])
    w.feeds.at(-1)!.callbacks.onEvent('session_event', frame(w.puts.at(-1)!.ids[0], 'message'))
    await settle()
    expect(second.log.events).toEqual(['message'])
  })
})

describe('StreamHub: leadership replacement during a subscription request', () => {
  /** Lead with sid-a subscribed on gen1, its request still out; then the feed drops and the window leads again. */
  async function replacedWhileSyncing() {
    const w = world()
    const hub = w.makeWindow()
    const watching = global(hub)
    await settle()
    w.state.defer = true
    w.feeds[0].callbacks.onOpen?.()
    const old = session(hub, 'sid-a')
    await settle()
    expect(w.puts).toHaveLength(1)
    expect(w.puts[0].clientId).toBe('gen1')
    const oldAnswer = w.state.answers[0]

    w.feeds[0].callbacks.onError?.(new Error('boom'))
    await settle()
    expect(old.log.errors).toHaveLength(1)
    // The global consumer reconnects, which re-runs the election.
    const again = global(hub)
    await settle()
    expect(w.feeds).toHaveLength(2)
    w.feeds[1].callbacks.onOpen?.()
    const fresh = session(hub, 'sid-a')
    await settle()
    return { w, hub, watching, again, old, fresh, oldAnswer }
  }

  it('sends the new leader\'s subscriptions without waiting for the old leader\'s request', async () => {
    const { w } = await replacedWhileSyncing()
    expect(w.puts.at(-1)).toMatchObject({ clientId: 'gen2', sessions: ['sid-a'] })
  })

  it('still sends the new leader\'s subscriptions after the old request answers', async () => {
    const { w, oldAnswer } = await replacedWhileSyncing()
    oldAnswer('ok')
    await settle()
    expect(w.puts.filter((p) => p.clientId === 'gen2').at(-1)?.sessions).toEqual(['sid-a'])
  })

  it('does not let the old leader\'s late refusal mark the server unsupported or restart the new feed', async () => {
    const { w, hub, again, fresh, oldAnswer } = await replacedWhileSyncing()
    oldAnswer('gone')
    await settle()
    expect(hub.muxSupported).toBeNull()
    expect(w.feeds[1].signal.aborted).toBe(false)
    expect(again.log.errors).toBe(0)
    expect(fresh.log.errors).toHaveLength(0)
  })

  it('does not let the old leader\'s late failure restart the new feed', async () => {
    const { w, again, fresh, oldAnswer } = await replacedWhileSyncing()
    oldAnswer('error')
    await settle()
    expect(w.feeds[1].signal.aborted).toBe(false)
    expect(again.log.errors).toBe(0)
    expect(fresh.log.errors).toHaveLength(0)
  })

  it('routes no frame from the old feed into the new one\'s subscriptions or global consumers', async () => {
    const { w, again, fresh } = await replacedWhileSyncing()
    const newId = w.puts.filter((p) => p.clientId === 'gen2').at(-1)?.ids[0] ?? ''
    w.feeds[0].callbacks.onEvent('session_event', frame(newId, 'message'))
    w.feeds[0].callbacks.onEvent('title_update', {})
    await settle()
    expect(fresh.log.events).toEqual([])
    expect(again.log.events).toEqual([])
  })

  it('sends nothing for an old leader\'s request that answers after the window let go of the feed', async () => {
    const w = world()
    const hub = w.makeWindow()
    const watching = global(hub)
    await settle()
    w.state.defer = true
    w.feeds[0].callbacks.onOpen?.()
    const mine = session(hub, 'sid-a')
    await settle()
    mine.controller.abort()
    watching.controller.abort()
    await settle()
    expect(w.feeds[0].signal.aborted).toBe(true)
    const sent = w.puts.length

    w.state.answers[0]('ok')
    await settle()
    expect(w.puts).toHaveLength(sent)
    expect(w.feeds).toHaveLength(1)
  })
})

describe('StreamHub: callbacks from a term that ended', () => {
  it('does not open a late consumer after its feed was replaced', async () => {
    const w = world()
    const hub = w.makeWindow()
    global(hub)
    await settle()
    w.feeds[0].callbacks.onOpen?.()
    const late = global(hub)

    w.feeds[0].callbacks.onError?.(new Error('boom'))
    await settle()

    expect(late.log.errors).toBe(1)
    expect(late.log.opens).toBe(0)
  })

  it('reports a parse error from the current feed to the global consumers', async () => {
    const w = world()
    const watching = global(w.makeWindow())
    await settle()
    w.feeds[0].callbacks.onOpen?.()
    w.feeds[0].callbacks.onParseError?.(new Error('bad frame'))
    expect(watching.log.parseErrors).toBe(1)
  })

  it('does not report a parse error from a feed that was replaced', async () => {
    const w = world()
    const hub = w.makeWindow()
    global(hub)
    await settle()
    w.feeds[0].callbacks.onOpen?.()
    w.feeds[0].callbacks.onError?.(new Error('boom'))
    await settle()
    const again = global(hub)
    await settle()
    expect(w.feeds).toHaveLength(2)

    w.feeds[0].callbacks.onParseError?.(new Error('late bad frame'))
    expect(again.log.parseErrors).toBe(0)
  })

  it('sends no subscription request from a late open of a feed the window let go of', async () => {
    const w = world()
    const hub = w.makeWindow()
    const mine = session(hub, 'sid-a')
    await settle()
    mine.controller.abort()
    await settle()
    expect(w.feeds[0].signal.aborted).toBe(true)

    w.feeds[0].callbacks.onOpen?.()
    await settle()
    expect(w.puts).toHaveLength(0)
  })

  it('does not bind a resubscription made while the feed drops to the dropped feed', async () => {
    const w = world()
    const hub = w.makeWindow()
    const watching = global(hub)
    await settle()
    w.feeds[0].callbacks.onOpen?.()
    // A consumer that subscribes again from inside its error callback.
    const retried: { errors: Error[] } = { errors: [] }
    hub.subscribeSession('sid-a', {
      onEvent: () => {},
      onError: () => {
        hub.subscribeSession('sid-a', { onEvent: () => {}, onError: (e) => { retried.errors.push(e) } })
      },
    })
    await settle()
    expect(w.puts).toHaveLength(1)

    w.feeds[0].callbacks.onError?.(new Error('boom'))
    await settle()
    expect(watching.log.errors).toBe(1)
    expect(w.puts.filter((p) => p.clientId === 'gen1')).toHaveLength(1)

    // The next term carries the retried subscription without failing it first.
    global(hub)
    await settle()
    w.feeds[1].callbacks.onOpen?.()
    await settle()
    expect(retried.errors).toHaveLength(0)
    expect(w.puts.at(-1)).toMatchObject({ clientId: 'gen2', sessions: ['sid-a'] })
  })
})
