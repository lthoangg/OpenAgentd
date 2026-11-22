import { describe, expect, it } from 'bun:test'

import { browserViewId, isPublicTarget, parseBrowserViewEvent, publicUrl } from '@/lib/browser-view'

describe('browser view', () => {
  it('takes a page on another machine for public, and nothing else', () => {
    expect(publicUrl('https://example.com/docs?x=1#top')?.href).toBe('https://example.com/docs?x=1#top')
    expect(publicUrl('example.com')?.href).toBe('https://example.com/')
    expect(publicUrl('http://192.168.1.20:3000')?.origin).toBe('http://192.168.1.20:3000')
    for (const local of ['http://localhost:5173', 'localhost:3000', 'http://127.0.0.1:8000/', 'http://[::1]:4000', 'http://0.0.0.0:80', 'http://app.localhost', 'ftp://example.com', 'javascript:alert(1)', '']) {
      expect(publicUrl(local)).toBeNull()
    }
    expect(isPublicTarget({ kind: 'url', url: 'https://example.com' })).toBe(true)
    expect(isPublicTarget({ kind: 'url', url: 'http://localhost:5173' })).toBe(false)
    expect(isPublicTarget({ kind: 'file', path: 'example.com/index.html' })).toBe(false)
  })

  it('gives each workspace and site one id the shell accepts', () => {
    const id = browserViewId('/code/demo', 'https://www.example.com')
    expect(id).toMatch(/^[A-Za-z0-9_-]{1,64}$/)
    expect(id.startsWith('www-example-com_')).toBe(true)
    expect(browserViewId('/code/demo', 'https://www.example.com')).toBe(id)
    expect(browserViewId('/code/other', 'https://www.example.com')).not.toBe(id)
    expect(browserViewId('/code/demo', 'http://www.example.com')).not.toBe(id)
    expect(browserViewId('/code/demo', `https://${'a'.repeat(200)}.example`)).toMatch(/^[A-Za-z0-9_-]{1,64}$/)
  })

  it('reads the events of a view and drops what is not one', () => {
    expect(parseBrowserViewEvent({ id: 'v', kind: 'load', phase: 'finished', url: 'https://example.com/' })).toEqual({ id: 'v', kind: 'load', phase: 'finished', url: 'https://example.com/' })
    expect(parseBrowserViewEvent({ id: 'v', kind: 'title', title: 'x'.repeat(500) })).toEqual({ id: 'v', kind: 'title', title: 'x'.repeat(300) })
    expect(parseBrowserViewEvent({ id: 'v', kind: 'page', url: 'https://example.com/', messages: [{ type: 'ready' }] })).toEqual({ id: 'v', kind: 'page', url: 'https://example.com/', messages: [{ type: 'ready' }] })
    expect(parseBrowserViewEvent({ id: 'v', kind: 'blocked', url: 'file:///etc/passwd' })).toEqual({ id: 'v', kind: 'blocked', url: 'file:///etc/passwd' })
    expect(parseBrowserViewEvent({ id: 'v', kind: 'url', url: '', loading: false })).toEqual({ id: 'v', kind: 'url', url: '', loading: false })
    expect(parseBrowserViewEvent({ id: 'v', kind: 'url', url: 'https://example.com/', loading: 'no' })).toEqual({ id: 'v', kind: 'url', url: 'https://example.com/' })
    for (const bad of [null, 'x', {}, { kind: 'load', phase: 'finished' }, { id: 'v', kind: 'load', phase: 'half' }, { id: 'v', kind: 'title' }, { id: 'v', kind: 'page', messages: 'no' }, { id: 'v', kind: 'eval' }]) {
      expect(parseBrowserViewEvent(bad)).toBeNull()
    }
  })
})
