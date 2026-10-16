import { afterEach, describe, expect, it } from 'bun:test'
import { createPersistedDraftMap } from '@/lib/persisted-drafts'

const KEY = 'oa.drafts.test.v1'

afterEach(() => {
  localStorage.removeItem(KEY)
})

/** A fresh map over the same storage key: what a reload sees. */
function reload<T>(max = 3, maxBytesPerEntry?: number) {
  return createPersistedDraftMap<T>({ storageKey: KEY, max, maxBytesPerEntry })
}

/** Force the debounced write. */
function hide() {
  window.dispatchEvent(new Event('pagehide'))
}

describe('createPersistedDraftMap', () => {
  it('keeps drafts across a reload', () => {
    const a = reload<{ value: string }>()
    a.set('s1', { value: 'half a prompt' })
    hide()
    expect(reload<{ value: string }>().get('s1')).toEqual({ value: 'half a prompt' })
  })

  it('forgets deleted drafts across a reload', () => {
    const a = reload<string>()
    a.set('s1', 'x')
    hide()
    a.delete('s1')
    hide()
    expect(reload<string>().get('s1')).toBeUndefined()
    expect(localStorage.getItem(KEY)).toBeNull()
  })

  it('drops the least recently written entry past max', () => {
    const a = reload<string>(2)
    a.set('a', '1')
    a.set('b', '2')
    a.set('a', '3')
    a.set('c', '4')
    hide()
    const b = reload<string>(2)
    expect([b.get('a'), b.get('b'), b.get('c')]).toEqual(['3', undefined, '4'])
  })

  it('keeps oversized entries in memory only', () => {
    const a = reload<string>(3, 10)
    a.set('big', 'x'.repeat(100))
    a.set('small', 'ok')
    hide()
    expect(a.get('big')).toBe('x'.repeat(100))
    const b = reload<string>(3, 10)
    expect([b.get('big'), b.get('small')]).toEqual([undefined, 'ok'])
  })

  it('ignores corrupt storage', () => {
    localStorage.setItem(KEY, '{not json')
    const a = reload<string>()
    expect(a.get('x')).toBeUndefined()
    a.set('x', 'y')
    expect(a.get('x')).toBe('y')
  })

  it('works in memory when storage throws', () => {
    const orig = Storage.prototype.setItem
    Storage.prototype.setItem = () => {
      throw new Error('QuotaExceededError')
    }
    try {
      const a = reload<string>()
      a.set('x', 'y')
      hide()
      expect(a.get('x')).toBe('y')
    } finally {
      Storage.prototype.setItem = orig
    }
  })
})
