import { describe, expect, it } from 'bun:test'
import { newSessionChoicePaths } from '@/components/Sidebar.helpers'

describe('newSessionChoicePaths', () => {
  it('puts Chat on top, the recent others newest nearest the thumb, and the current one last', () => {
    expect(newSessionChoicePaths('/p', '/chat', ['/newest', '/p', '/older'])).toEqual(['/chat', '/older', '/newest', '/p'])
  })

  it('lists Chat once, at the bottom, when it is the current workspace', () => {
    expect(newSessionChoicePaths('/chat', '/chat', ['/a'])).toEqual(['/a', '/chat'])
  })

  it('keeps the newest others within the limit', () => {
    expect(newSessionChoicePaths('/p', '/chat', ['/1', '/2', '/3', '/4', '/5', '/6'], 4)).toEqual(['/chat', '/2', '/1', '/p'])
  })

  it('works with no current workspace and no Chat', () => {
    expect(newSessionChoicePaths(null, null, ['/a', '/b'])).toEqual(['/b', '/a'])
  })
})
