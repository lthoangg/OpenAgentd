import { describe, expect, it } from 'bun:test'
import { needsYouText, parseSessions, rowSubtitle } from '@/tray/sessions'
import { modifierLabel, shortcutLabel } from '@/tray/shortcuts'
import type { IslandSession } from '@/island/status'

const session = (patch: Partial<IslandSession> = {}): IslandSession =>
  ({ id: 's', title: 'Plan', workspace: 'api', state: 'needs_input', question: null, ...patch })

describe('parseSessions', () => {
  it('reads the shell’s lists, and tolerates an older shell without unreachable servers', () => {
    expect(parseSessions({ connected: true, needsYou: [session()], running: [] })).toEqual({
      connected: true,
      needsYou: [session()],
      running: [],
      unreachable: [],
    })
    expect(parseSessions({ connected: false, needsYou: [], running: [], unreachable: [{ id: 'x', name: 'NAS', reason: 'unreachable' }] })?.unreachable).toHaveLength(1)
  })

  it('refuses anything else', () => {
    for (const bad of [null, undefined, 'x', 3, {}, { needsYou: [] }, { needsYou: 'a', running: [] }]) expect(parseSessions(bad)).toBeNull()
  })
})

describe('rowSubtitle', () => {
  it('puts the server and workspace first, and what a waiting session asked in quotes', () => {
    expect(rowSubtitle(session({ question: 'Which branch?', server: 'NAS' }))).toBe('NAS · api · “Which branch?”')
    expect(rowSubtitle(session({ question: '  ' }))).toBe('api')
  })

  it('shows a running session’s goal in place of its workspace, and never a question', () => {
    const running = session({ state: 'running', question: 'stale', goal: { status: 'active', turn: 2, maxTurns: 9 } })
    expect(rowSubtitle(running)).toBe('Goal 2/9')
    expect(rowSubtitle(session({ state: 'running', workspace: null }))).toBe('')
  })
})

describe('needsYouText', () => {
  it('counts in words', () => {
    expect(needsYouText(1)).toBe('1 needs you')
    expect(needsYouText(3)).toBe('3 need you')
  })
})

describe('shortcutLabel', () => {
  // The hints said ⌘ everywhere; the popup answers Ctrl too.
  it('writes ⌘ on macOS and Ctrl+ elsewhere', () => {
    expect(shortcutLabel(',', 'macos')).toBe('⌘,')
    expect(shortcutLabel('q', 'macos')).toBe('⌘Q')
    expect(shortcutLabel(',', 'windows')).toBe('Ctrl+,')
    expect(shortcutLabel('q', 'linux')).toBe('Ctrl+Q')
    expect(modifierLabel('unknown')).toBe('Ctrl+')
  })
})
