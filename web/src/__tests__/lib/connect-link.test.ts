import { describe, expect, it } from 'bun:test'
import { buildConnectLink, parseConnectLink } from '@/lib/connect-link'

const KEY = 'generated-key-0123456789abcdef'

describe('connect links', () => {
  it('round-trips every address and the key', () => {
    const link = buildConnectLink({ urls: ['http://192.168.1.20:4082', 'http://10.0.0.5:4082'], key: KEY })
    expect(link.startsWith('openagentd://connect?')).toBe(true)
    expect(parseConnectLink(link)).toEqual({ urls: ['http://192.168.1.20:4082', 'http://10.0.0.5:4082'], key: KEY })
  })

  it('keeps keys with URL-special characters intact', () => {
    const key = 'a+b/c=d&e f#g?h'
    expect(parseConnectLink(buildConnectLink({ urls: ['http://192.168.1.20:4082'], key }))?.key).toBe(key)
  })

  it('matches the link the CLI prints as a QR code (`agentd server start --qr`)', () => {
    // Pinned in appv3/crates/cli/src/qr.rs `link_matches_url_search_params`.
    const cli = 'openagentd://connect?url=http%3A%2F%2F192.168.1.5%3A4082&url=http%3A%2F%2F10.0.0.2%3A4082&key=a+b%2Bc%2F%3D%C3%A9%7E'
    const urls = ['http://192.168.1.5:4082', 'http://10.0.0.2:4082']
    expect(buildConnectLink({ urls, key: 'a b+c/=é~' })).toBe(cli)
    expect(parseConnectLink(cli)).toEqual({ urls, key: 'a b+c/=é~' })
  })

  it('accepts the dev scheme and normalizes /api and trailing slashes', () => {
    const link = `openagentd-dev://connect?url=${encodeURIComponent('http://192.168.1.20:4082/api/')}&key=${KEY}`
    expect(parseConnectLink(link)).toEqual({ urls: ['http://192.168.1.20:4082'], key: KEY })
  })

  it('drops unsafe or malformed addresses', () => {
    const urls = ['javascript:alert(1)', 'file:///etc/passwd', 'http://user:pw@192.168.1.20:4082', 'http://192.168.1.20:4082/other', 'not a url', 'https://host.example']
    const params = new URLSearchParams()
    for (const url of urls) params.append('url', url)
    params.set('key', KEY)
    expect(parseConnectLink(`openagentd://connect?${params}`)).toEqual({ urls: ['https://host.example'], key: KEY })
  })

  it('rejects links without a usable address or key', () => {
    expect(parseConnectLink(`openagentd://connect?key=${KEY}`)).toBeNull()
    expect(parseConnectLink('openagentd://connect?url=http%3A%2F%2F192.168.1.20%3A4082')).toBeNull()
    expect(parseConnectLink('openagentd://connect?url=http%3A%2F%2F192.168.1.20%3A4082&key=%20%20')).toBeNull()
    expect(parseConnectLink(`openagentd://connect?url=http%3A%2F%2Fh%3A1&key=${'k'.repeat(513)}`)).toBeNull()
  })

  it('rejects other hosts, paths, and schemes', () => {
    expect(parseConnectLink(`openagentd://session?url=http%3A%2F%2Fh%3A1&key=${KEY}`)).toBeNull()
    expect(parseConnectLink(`openagentd://connect/extra?url=http%3A%2F%2Fh%3A1&key=${KEY}`)).toBeNull()
    expect(parseConnectLink(`https://connect?url=http%3A%2F%2Fh%3A1&key=${KEY}`)).toBeNull()
    expect(parseConnectLink('garbage')).toBeNull()
  })

  it('caps the number of addresses', () => {
    const urls = Array.from({ length: 12 }, (_, i) => `http://10.0.0.${i + 1}:4082`)
    expect(parseConnectLink(buildConnectLink({ urls, key: KEY }))?.urls).toHaveLength(8)
  })
})
