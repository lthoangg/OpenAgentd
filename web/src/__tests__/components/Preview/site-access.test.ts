import { describe, expect, it } from 'bun:test'

import type { BrowserSites } from '@/api/client'
import { ruleName, siteAccess, siteName, withSiteAccess } from '@/components/Preview/site-access'

const rules = (over: Partial<BrowserSites> = {}): BrowserSites => ({ default: 'ask', allowed: [], blocked: [], ...over })

describe('site access', () => {
  it('names a site by its host without www', () => {
    expect(siteName('WWW.Example.com.')).toBe('example.com')
    expect(siteName('app.example.com')).toBe('app.example.com')
    expect(ruleName(' https://www.Example.com:8443/pricing?x=1 ')).toBe('example.com')
    expect(ruleName('*.Example.com')).toBe('*.example.com')
    expect(ruleName('example.com')).toBe('example.com')
  })

  it('reads the rules as the server does', () => {
    const r = rules({ allowed: ['example.com', '*.corp.test'], blocked: ['bad.corp.test'] })
    expect(siteAccess(r, 'www.example.com')).toBe('allow')
    expect(siteAccess(r, 'app.example.com')).toBe('ask')
    expect(siteAccess(r, 'notexample.com')).toBe('ask')
    expect(siteAccess(r, 'wiki.corp.test')).toBe('allow')
    expect(siteAccess(r, 'corp.test')).toBe('ask')
    expect(siteAccess(r, 'bad.corp.test')).toBe('block')
    const open = rules({ default: 'allow', blocked: ['bank.test'] })
    expect(siteAccess(open, 'anything.test')).toBe('allow')
    expect(siteAccess(open, 'www.bank.test')).toBe('block')
  })

  it('moves one site between the lists and leaves the rest', () => {
    const start = rules({ allowed: ['docs.test', '*.corp.test'], blocked: ['shop.test'] })
    expect(withSiteAccess(start, 'www.shop.test', 'allow')).toEqual(rules({ allowed: ['docs.test', '*.corp.test', 'shop.test'], blocked: [] }))
    expect(withSiteAccess(start, 'docs.test', 'block')).toEqual(rules({ allowed: ['*.corp.test'], blocked: ['shop.test', 'docs.test'] }))
    expect(withSiteAccess(start, 'docs.test', 'ask')).toEqual(rules({ allowed: ['*.corp.test'], blocked: ['shop.test'] }))
    // Picking what it already is does not list it twice.
    expect(withSiteAccess(start, 'docs.test', 'allow').allowed).toEqual(['*.corp.test', 'docs.test'])
  })
})
