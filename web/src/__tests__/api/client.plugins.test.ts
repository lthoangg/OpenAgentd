/**
 * Plugin bundle endpoints of the API client: what each call sends, and how a
 * refusal reads. The server answers with the bundle or list as `PluginsResponse`
 * and `PluginBundle` describe them.
 */
import { afterEach, describe, expect, it } from 'bun:test'

import { ApiValidationError, listPlugins, reloadPlugins, setPluginBundleEnabled } from '@/api/client'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

function answerWith(body: unknown, status = 200) {
  const calls: { url: string; init?: RequestInit }[] = []
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init })
    return Promise.resolve(new Response(JSON.stringify(body), { status }))
  }) as typeof fetch
  return calls
}

describe('listPlugins', () => {
  it('reads GET /plugins as it is, with `bundles` when the server has them', async () => {
    const body = { dirs: ['/p'], plugins: [], unported: [], bundles: [{ name: 'changelog-tools' }] }
    const calls = answerWith(body)

    expect(await listPlugins()).toEqual(body)
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('/api/plugins')
    expect(calls[0].init).toBeUndefined()
  })

  it('hands back a response without `bundles` untouched, for an older server', async () => {
    answerWith({ dirs: ['/p'], plugins: [], unported: [] })
    expect((await listPlugins()).bundles).toBeUndefined()
  })
})

describe('reloadPlugins', () => {
  it('posts to /plugins/reload and returns the list it answers with', async () => {
    const body = { dirs: ['/p'], plugins: [], unported: [], bundles: [] }
    const calls = answerWith(body)

    expect(await reloadPlugins()).toEqual(body)
    expect(calls[0].url).toBe('/api/plugins/reload')
    expect(calls[0].init?.method).toBe('POST')
  })

  it('throws the server\'s reason when the reload is refused', async () => {
    answerWith({ detail: 'the plugin folder is not readable' }, 500)
    await expect(reloadPlugins()).rejects.toThrow('the plugin folder is not readable')
  })
})

describe('setPluginBundleEnabled', () => {
  it('puts { enabled } as JSON to the bundle and returns the updated bundle', async () => {
    const bundle = { name: 'changelog-tools', enabled: false, state: 'disabled' }
    const calls = answerWith(bundle)

    expect(await setPluginBundleEnabled('changelog-tools', false)).toEqual(bundle as never)
    expect(calls[0].url).toBe('/api/plugins/bundles/changelog-tools')
    expect(calls[0].init?.method).toBe('PUT')
    expect(calls[0].init?.headers).toEqual({ 'Content-Type': 'application/json' })
    expect(JSON.parse(calls[0].init?.body as string)).toEqual({ enabled: false })
  })

  it('sends true to turn one on', async () => {
    const calls = answerWith({ name: 'changelog-tools' })
    await setPluginBundleEnabled('changelog-tools', true)
    expect(JSON.parse(calls[0].init?.body as string)).toEqual({ enabled: true })
  })

  it('encodes the name, so a slash or a space cannot change the path', async () => {
    const calls = answerWith({ name: 'x' })
    await setPluginBundleEnabled('team/notes sync+v2', true)
    expect(calls[0].url).toBe('/api/plugins/bundles/team%2Fnotes%20sync%2Bv2')
  })

  it('keeps a dot in a name, as in dev.openagentd.notes', async () => {
    const calls = answerWith({ name: 'x' })
    await setPluginBundleEnabled('dev.openagentd.notes', true)
    expect(calls[0].url).toBe('/api/plugins/bundles/dev.openagentd.notes')
  })

  it('throws the server\'s reason for an unknown bundle (404)', async () => {
    answerWith({ detail: 'No plugin bundle named ghost' }, 404)
    const failure = await setPluginBundleEnabled('ghost', true).catch((e: unknown) => e)
    expect(failure).toBeInstanceOf(ApiValidationError)
    expect((failure as ApiValidationError).status).toBe(404)
    expect((failure as ApiValidationError).message).toBe('No plugin bundle named ghost')
  })
})
