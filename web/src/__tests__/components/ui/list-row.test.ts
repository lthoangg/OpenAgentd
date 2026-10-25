import { describe, expect, it } from 'bun:test'
import { ROW_ACTION, listRowClass, listRowSurface } from '@/components/ui/list-row'

describe('list row press feedback', () => {
  it('darkens a row the moment a finger presses it', () => {
    expect(listRowSurface().split(' ')).toContain('pointer-coarse:active:bg-(--bg-key)/60')
    expect(listRowClass()).toContain('pointer-coarse:active:bg-(--bg-key)/60')
  })

  it('gives a row action its own press wash on touch', () => {
    expect(ROW_ACTION.split(' ')).toContain('pointer-coarse:active:bg-(--bg-key)')
  })

  it('keeps the desktop hover wash and the current-row wash unchanged', () => {
    expect(listRowSurface().split(' ')).toContain('hover:bg-(--bg-key)/35')
    // A mouse press does not flash the row; only coarse pointers get :active.
    expect(listRowSurface().split(' ').filter((c) => c.startsWith('active:'))).toEqual([])
    expect(listRowSurface(true)).toBe('bg-(--bg-key)/60')
  })
})
