import { describe, expect, test } from 'bun:test'
import { agentPageSrc } from '@/agent-page/frame-src'

const q = (src: string) => `?src=${encodeURIComponent(src)}`

describe('agentPageSrc', () => {
  test('frames a preview listener on this computer, path and query kept', () => {
    expect(agentPageSrc(q('http://127.0.0.1:52011/pricing?tab=2#top'))).toBe('http://127.0.0.1:52011/pricing?tab=2#top')
    expect(agentPageSrc(q('http://127.0.0.1:52011'))).toBe('http://127.0.0.1:52011/')
  })

  test('refuses anything that is not a listener on 127.0.0.1', () => {
    for (const bad of [
      'https://127.0.0.1:52011/',
      'http://localhost:52011/',
      'http://example.com/',
      'http://127.0.0.1/',
      'http://127.0.0.1:80/',
      'http://user:pw@127.0.0.1:52011/',
      'javascript:alert(1)',
      'file:///etc/passwd',
      '/relative',
      '',
    ]) {
      expect(agentPageSrc(q(bad))).toBeNull()
    }
    expect(agentPageSrc('')).toBeNull()
  })
})
