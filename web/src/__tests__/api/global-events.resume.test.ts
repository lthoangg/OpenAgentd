/**
 * The app remembers the last event id it read on a server's feed and
 * reopens the feed from there (`?since=`), so a reconnect replays what it
 * missed.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { setApiBaseUrl } from '@/api/base-url'
import { globalEventStream, readGlobalStreamCursor } from '@/api/global-events'

const realFetch = globalThis.fetch
let urls: string[] = []
let body = ''

function sseResponse(text: string): Response {
  return new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text))
      controller.close()
    },
  }), { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

function open(clientId?: string): Promise<Array<[string, unknown, string | undefined]>> {
  const events: Array<[string, unknown, string | undefined]> = []
  return new Promise((resolve) => {
    globalEventStream({
      onEvent: (type, data, id) => { events.push([type, data, id]) },
      onDone: () => resolve(events),
      onError: () => resolve(events),
    }, undefined, clientId)
  })
}

beforeEach(() => {
  localStorage.clear()
  setApiBaseUrl('http://192.168.1.20:4082/api')
  urls = []
  globalThis.fetch = mock(async (...args: unknown[]) => {
    urls.push(String(args[0]))
    return sseResponse(body)
  }) as unknown as typeof fetch
})

afterEach(() => {
  globalThis.fetch = realFetch
  setApiBaseUrl('')
})

describe('resuming the global feed', () => {
  it('remembers the last event id and reopens the feed from it', async () => {
    body = 'id: b00t-7\r\nevent: stream_resume\r\ndata: {"replay":0,"resync":false}\r\n\r\n'
      + 'id: b00t-8\r\nevent: title_update\r\ndata: {"session_id":"s","title":"t"}\r\n\r\n'
      + 'event: session_event\r\ndata: {"sub_id":"x","type":"message","data":{}}\r\n\r\n'
    const events = await open('win-1')
    expect(urls[0]).toBe('http://192.168.1.20:4082/api/events/stream?client_id=win-1')
    expect(events.map(([type, , id]) => [type, id])).toEqual([['stream_resume', 'b00t-7'], ['title_update', 'b00t-8'], ['session_event', undefined]])
    expect(readGlobalStreamCursor()).toBe('b00t-8')

    body = ''
    await open('win-1')
    expect(urls[1]).toBe('http://192.168.1.20:4082/api/events/stream?client_id=win-1&since=b00t-8')
  })

  it('keeps one position per server', async () => {
    body = 'id: b00t-3\r\nevent: title_update\r\ndata: {}\r\n\r\n'
    await open()
    setApiBaseUrl('http://192.168.1.30:4082/api')
    expect(readGlobalStreamCursor()).toBeNull()
    body = ''
    await open()
    expect(urls[1]).toBe('http://192.168.1.30:4082/api/events/stream')
  })

  it('ignores a stored position that is not an id', async () => {
    localStorage.setItem('oa-global-stream-cursor:http://192.168.1.20:4082/api', 'x&evil=1')
    body = ''
    await open()
    expect(urls[0]).toBe('http://192.168.1.20:4082/api/events/stream')
  })
})
