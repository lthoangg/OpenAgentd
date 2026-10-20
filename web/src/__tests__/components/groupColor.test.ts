import { describe, expect, it } from 'bun:test'
import { groupColor, groupColorHex, parseHexColor, suggestedGroupColor } from '@/components/Sidebar/groupColor'

const ids = Array.from({ length: 50 }, (_, i) => `01a157c2-6a6a-74e7-88c4-${String(i).padStart(12, '0')}`)

describe('groupColor', () => {
  it('uses the picked colour', () => {
    expect(groupColor({ id: 'g-1', color: '#a78bfa' })).toBe('#a78bfa')
    expect(groupColorHex({ id: 'g-1', color: '#A78BFA' })).toBe('#a78bfa')
  })

  it('derives a stable, non-red accent from the id when none is picked or the colour is unusable', () => {
    for (const id of ids) {
      const derived = groupColor({ id, color: null })
      expect(derived).toMatch(/^var\(--accent-(blue|green|orange|purple|pink)\)$/)
      expect(groupColor({ id })).toBe(derived)
      expect(groupColor({ id, color: 'url(x)' })).toBe(derived)
    }
    expect(new Set(ids.map((id) => groupColor({ id }))).size).toBeGreaterThan(1)
  })

  it('gives the colour input a hex value even for a derived colour', () => {
    expect(groupColorHex({ id: 'g-1', color: null })).toMatch(/^#[0-9a-f]{6}$/)
  })

  it('reads typed or pasted hex colours, with or without #, short or long', () => {
    expect(parseHexColor('#3B82F6')).toBe('#3b82f6')
    expect(parseHexColor('  3b82f6 ')).toBe('#3b82f6')
    expect(parseHexColor('#F0a')).toBe('#ff00aa')
    expect(parseHexColor('abc')).toBe('#aabbcc')
    for (const bad of ['', '#', '#12345', '#1234567', 'red', '#ggg000', 'rgb(1,2,3)']) {
      expect(parseHexColor(bad)).toBeNull()
    }
  })

  it('suggests distinct hex colours for consecutive new groups', () => {
    const suggested = Array.from({ length: 8 }, (_, i) => suggestedGroupColor(i))
    for (const c of suggested) expect(c).toMatch(/^#[0-9a-f]{6}$/)
    expect(new Set(suggested).size).toBe(suggested.length)
  })
})
