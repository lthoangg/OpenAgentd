import { describe, expect, it } from 'bun:test'

import { addressSuggestions, shortAddress } from '@/components/Preview/preview-suggestions'

const files = ['src/main.tsx', 'site/pricing.html', 'index.html', 'docs/mockup.html', 'docs/notes.md', 'old/page.HTM']

describe('shortAddress', () => {
  it('drops http:// and keeps https://, the one that differs', () => {
    expect(shortAddress('http://localhost:5173/pricing')).toBe('localhost:5173/pricing')
    expect(shortAddress('https://localhost:8443/')).toBe('https://localhost:8443/')
    expect(shortAddress('/docs/index.html')).toBe('/docs/index.html')
  })
})

describe('addressSuggestions', () => {
  it('lists recent addresses, then the workspace pages with the shallowest first', () => {
    const list = addressSuggestions({ recent: ['http://localhost:3000/admin'], files, query: '', current: 'http://localhost:5173/' })
    expect(list).toEqual([
      { group: 'recent', label: 'localhost:3000/admin', value: 'http://localhost:3000/admin' },
      { group: 'page', label: 'index.html', value: 'index.html' },
      { group: 'page', label: 'docs/mockup.html', value: 'docs/mockup.html' },
      { group: 'page', label: 'old/page.HTM', value: 'old/page.HTM' },
      { group: 'page', label: 'site/pricing.html', value: 'site/pricing.html' },
    ])
  })

  it('leaves out the address the tab already shows', () => {
    const list = addressSuggestions({ recent: ['http://localhost:5173/pricing', 'http://localhost:3000/'], files: ['index.html'], query: '', current: 'http://localhost:5173/pricing' })
    expect(list.map((s) => s.label)).toEqual(['localhost:3000/', 'index.html'])
    // A file tab shows its page as a rooted path.
    expect(addressSuggestions({ recent: [], files: ['index.html', 'a.html'], query: '', current: '/index.html' }).map((s) => s.label)).toEqual(['a.html'])
  })

  it('filters both lists by what was typed, whatever the case, with or without http://', () => {
    const args = { recent: ['http://localhost:3000/admin', 'http://localhost:5173/pricing'], files, current: '' }
    expect(addressSuggestions({ ...args, query: 'PRIC' }).map((s) => s.label)).toEqual(['localhost:5173/pricing', 'site/pricing.html'])
    expect(addressSuggestions({ ...args, query: 'http://localhost:3' }).map((s) => s.label)).toEqual(['localhost:3000/admin'])
    expect(addressSuggestions({ ...args, query: 'nothing-like-this' })).toEqual([])
  })

  it('shows at most eight pages', () => {
    const many = Array.from({ length: 20 }, (_, i) => `p${String(i).padStart(2, '0')}.html`)
    expect(addressSuggestions({ recent: [], files: many, query: '', current: '' })).toHaveLength(8)
  })
})
