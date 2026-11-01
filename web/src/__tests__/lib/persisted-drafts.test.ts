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

describe('drafts shared between windows', () => {
  /** What another window's write looks like here: the new JSON and a storage event. */
  function writeFromOtherWindow(pairs: [string, unknown][]) {
    const newValue = JSON.stringify(pairs)
    localStorage.setItem(KEY, newValue)
    window.dispatchEvent(new StorageEvent('storage', { key: KEY, newValue }))
  }

  it('picks up a draft another window wrote and tells subscribers which key changed', () => {
    const a = reload<{ value: string }>()
    a.set('s1', { value: 'mine' })
    hide()
    const changes: [string, unknown][] = []
    const stop = a.subscribe((key, value) => changes.push([key, value]))

    writeFromOtherWindow([['s1', { value: 'typed in the other window' }], ['s2', { value: 'new' }]])

    expect(a.get('s1')).toEqual({ value: 'typed in the other window' })
    expect(a.get('s2')).toEqual({ value: 'new' })
    expect(changes).toEqual([
      ['s1', { value: 'typed in the other window' }],
      ['s2', { value: 'new' }],
    ])
    stop()
  })

  it('reports a draft the other window cleared', () => {
    const a = reload<string>()
    a.set('s1', 'x')
    hide()
    const changes: [string, unknown][] = []
    const stop = a.subscribe((key, value) => changes.push([key, value]))

    localStorage.removeItem(KEY)
    window.dispatchEvent(new StorageEvent('storage', { key: KEY, newValue: null }))

    expect(a.get('s1')).toBeUndefined()
    expect(changes).toEqual([['s1', undefined]])
    stop()
  })

  it('says nothing when the other window wrote what this one has, so echoes stop', () => {
    const a = reload<string>()
    a.set('s1', 'same')
    hide()
    const changes: [string, unknown][] = []
    const stop = a.subscribe((key, value) => changes.push([key, value]))

    writeFromOtherWindow([['s1', 'same']])

    expect(changes).toEqual([])
    stop()
  })

  it('keeps a write this window has not saved yet over the other window’s', () => {
    const a = reload<string>()
    a.set('s1', 'typing here')
    const stop = a.subscribe(() => {})

    writeFromOtherWindow([['s1', 'older text']])

    expect(a.get('s1')).toBe('typing here')
    stop()
  })
})
