import { afterEach, describe, expect, it, mock } from 'bun:test'
import { clearEtagCache, fetchJsonWithEtag } from '@/api/client/_shared'
import { sessionHistory } from '@/api/client/agent'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
  clearEtagCache()
})

describe('fetchJsonWithEtag', () => {
  it('revalidates with If-None-Match and returns the same object on 304', async () => {
    const seen: (string | null)[] = []
    globalThis.fetch = mock(async (_url: unknown, init: unknown) => {
      const inm = new Headers((init as RequestInit | undefined)?.headers).get('If-None-Match')
      seen.push(inm)
      if (inm === '"abc"') return new Response(null, { status: 304, headers: { ETag: '"abc"' } })
      return new Response(JSON.stringify({ files: [1] }), { headers: { ETag: '"abc"' } })
    }) as unknown as typeof fetch

    const first = await fetchJsonWithEtag<{ files: number[] }>('/x', 'x')
    const second = await fetchJsonWithEtag<{ files: number[] }>('/x', 'x')
    expect(seen).toEqual([null, '"abc"'])
    expect(second).toBe(first)
  })

  it('replaces the cached body when the server sends a new one', async () => {
    let n = 0
    globalThis.fetch = mock(async () => {
      n += 1
      return new Response(JSON.stringify({ n }), { headers: { ETag: `"v${n}"` } })
    }) as unknown as typeof fetch
    expect(await fetchJsonWithEtag('/y', 'y')).toEqual({ n: 1 })
    expect(await fetchJsonWithEtag('/y', 'y')).toEqual({ n: 2 })
  })

  it('throws the server detail on errors', async () => {
    globalThis.fetch = mock(async () => new Response(JSON.stringify({ detail: 'nope' }), { status: 422 })) as unknown as typeof fetch
    await expect(fetchJsonWithEtag('/z', 'z')).rejects.toThrow('nope')
  })
})

describe('sessionHistory', () => {
  /** A server whose pages never change: tag = URL. Records each request's `If-None-Match`. */
  function unchangedServer(seen: { url: string; inm: string | null; cache?: RequestCache }[]) {
    globalThis.fetch = mock(async (url: unknown, init: unknown) => {
      const req = init as RequestInit | undefined
      const inm = new Headers(req?.headers).get('If-None-Match')
      seen.push({ url: String(url), inm, cache: req?.cache })
      const tag = `"${String(url)}"`
      if (inm === tag) return new Response(null, { status: 304, headers: { ETag: tag } })
      return new Response(JSON.stringify({ lead: { messages: [] }, members: [] }), { headers: { ETag: tag } })
    }) as unknown as typeof fetch
  }

  it('reopening an unchanged session revalidates and returns the same page', async () => {
    const seen: { url: string; inm: string | null; cache?: RequestCache }[] = []
    unchangedServer(seen)
    const first = await sessionHistory('s1')
    const again = await sessionHistory('s1')
    expect(again).toBe(first)
    expect(seen.map((s) => s.inm)).toEqual([null, `"${seen[0].url}"`])
    expect(seen.every((s) => s.cache === 'no-store')).toBe(true)
  })

  it('keeps only the last four sessions', async () => {
    const seen: { url: string; inm: string | null; cache?: RequestCache }[] = []
    unchangedServer(seen)
    for (const sid of ['a', 'b', 'c', 'd', 'e']) await sessionHistory(sid)
    seen.length = 0
    await sessionHistory('a')
    await sessionHistory('e')
    expect(seen.map((s) => s.inm !== null)).toEqual([false, true])
  })

  it('does not revalidate older pages', async () => {
    const seen: { url: string; inm: string | null; cache?: RequestCache }[] = []
    unchangedServer(seen)
    await sessionHistory('s1', '5|x')
    await sessionHistory('s1', '5|x')
    expect(seen.map((s) => s.inm)).toEqual([null, null])
  })
})
