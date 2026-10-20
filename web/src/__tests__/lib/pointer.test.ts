import { afterEach, describe, expect, it } from 'bun:test'
import { hasFinePointer } from '@/lib/pointer'

const original = window.matchMedia

afterEach(() => {
  window.matchMedia = original
})

function stubPointer(fine: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: query === '(pointer: fine)' ? fine : false,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia
}

describe('hasFinePointer', () => {
  it('is true for a mouse / trackpad', () => {
    stubPointer(true)
    expect(hasFinePointer()).toBe(true)
  })

  it('is false on touch', () => {
    stubPointer(false)
    expect(hasFinePointer()).toBe(false)
  })

  it('assumes a fine pointer when matchMedia is unavailable', () => {
    window.matchMedia = undefined as unknown as typeof window.matchMedia
    expect(hasFinePointer()).toBe(true)
  })
})
