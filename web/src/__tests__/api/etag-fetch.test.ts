import { afterEach, describe, expect, it, mock } from 'bun:test'
import { clearEtagCache, fetchJsonWithEtag } from '@/api/client/_shared'

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
