import { describe, expect, it } from 'bun:test'
import { getToolDisplay } from '@/components/ToolCall/display'

describe('ToolCall team tools display', () => {
  it('formats team_spawn with profile and sync mode', () => {
    const display = getToolDisplay(
      'team_spawn',
      JSON.stringify({ profile: 'explorer', task: 'Find all auth files', wait: true })
    )
    expect(display.headerTitle).toBe('explorer')
    expect(display.formattedArgs).toBe('Find all auth files')
  })

  it('formats team_spawn with custom name and async mode', () => {
    const display = getToolDisplay(
      'team_spawn',
      JSON.stringify({ profile: 'explorer', name: 'explorer#1', task: 'Search frontend', wait: false })
    )
    expect(display.headerTitle).toBe('explorer#1 · in background')
    expect(display.formattedArgs).toBe('Search frontend')
  })

  it('formats team_send with target member and message', () => {
    const display = getToolDisplay(
      'team_send',
      JSON.stringify({ member_id: 'explorer#1', message: 'Please focus on JWT only' })
    )
    expect(display.headerTitle).toBe('→ explorer#1')
    expect(display.formattedArgs).toBe('Please focus on JWT only')
  })

  it('formats team_list header', () => {
    const display = getToolDisplay('team_list', '{}')
    expect(display.headerTitle).toBeNull()
    expect(display.header).toBeNull()
  })

  it('formats team_wait with target member IDs', () => {
    const display = getToolDisplay(
      'team_wait',
      JSON.stringify({ member_ids: ['explorer#1', 'explorer#2'], timeout: 60 })
    )
    expect(display.headerTitle).toBe('explorer#1, explorer#2')
  })

  it('formats team_stop with member ID', () => {
    const display = getToolDisplay(
      'team_stop',
      JSON.stringify({ member_id: 'explorer#1' })
    )
    expect(display.headerTitle).toBe('explorer#1')
  })

  it('formats send_to_lead for progress vs final report', () => {
    const progressDisplay = getToolDisplay(
      'send_to_lead',
      JSON.stringify({ message: 'Scanned 10 files so far', end_turn: false })
    )
    expect(progressDisplay.header).toBe('progress report')
    expect(progressDisplay.headerTitle).toBe('Progress report to the main agent')

    const finalDisplay = getToolDisplay(
      'send_to_lead',
      JSON.stringify({ message: 'Completed audit', end_turn: true })
    )
    expect(finalDisplay.header).toBe('final report')
    expect(finalDisplay.headerTitle).toBe('Final report to the main agent')
  })

  it('formats ask_lead with question', () => {
    const display = getToolDisplay(
      'ask_lead',
      JSON.stringify({ question: 'Which auth method should I audit?', options: ['jwt', 'cookie'] })
    )
    expect(display.headerTitle).toBe('Question for the main agent: Which auth method should I audit?')
    expect(display.formattedArgs).toBe('Which auth method should I audit?')
  })

  it('formats delegate tool with profile or target handle', () => {
    const spawnDisplay = getToolDisplay('delegate', JSON.stringify({ profile: 'explorer', task: 'Scan API files' }))
    expect(spawnDisplay.headerTitle).toBe('spawn explorer')
    expect(spawnDisplay.formattedArgs).toBe('Scan API files')

    const replyDisplay = getToolDisplay('delegate', JSON.stringify({ profile: 'explorer', target: 'explorer#1', task: 'Use JWT' }))
    expect(replyDisplay.headerTitle).toBe('send explorer#1')
    expect(replyDisplay.formattedArgs).toBe('Use JWT')
  })

  it('formats delegate interrupt, stop, and list actions', () => {
    const interrupt = getToolDisplay('delegate', JSON.stringify({ action: 'interrupt', target: 'explorer#1', task: 'Only the API crate' }))
    expect(interrupt.headerTitle).toBe('interrupt explorer#1')
    expect(interrupt.formattedArgs).toBe('Only the API crate')

    const stop = getToolDisplay('delegate', JSON.stringify({ action: 'stop', target: 'explorer#1' }))
    expect(stop.headerTitle).toBe('stop explorer#1')
    expect(stop.formattedArgs).toBeNull()

    const list = getToolDisplay('delegate', JSON.stringify({ action: 'list' }))
    expect(list.headerTitle).toBe('list')
    expect(list.formattedArgs).toBeNull()

    const send = getToolDisplay('delegate', JSON.stringify({ action: 'send', target: 'explorer#1', task: 'Use JWT' }))
    expect(send.headerTitle).toBe('send explorer#1')
  })

  it('formats team_manage for list, wait, and stop actions', () => {
    const listDisplay = getToolDisplay('team_manage', JSON.stringify({ action: 'list' }))
    expect(listDisplay.headerTitle).toBe('list')

    const waitDisplay = getToolDisplay('team_manage', JSON.stringify({ action: 'wait', member_ids: ['exp#1'] }))
    expect(waitDisplay.headerTitle).toBe('wait exp#1')

    const stopDisplay = getToolDisplay('team_manage', JSON.stringify({ action: 'stop', member_id: 'exp#1' }))
    expect(stopDisplay.headerTitle).toBe('stop exp#1')
  })

  /** Old transcripts keep the former names; both render the same card. */
  it('renders renamed tools the same under their former and current names', () => {
    const pairs: [string, string, Record<string, unknown>][] = [
      ['delegate', 'team', { profile: 'explorer', task: 'Scan API files' }],
      ['delegate', 'team', { action: 'stop', target: 'explorer#1' }],
      ['send_to_workspace', 'workspace', { workspace: 'infra', message: 'Add a queue', reply: true }],
      ['schedule_task', 'schedule', { action: 'list' }],
      ['todo_manage', 'todo', { actions: [{ action: 'create', content: 'Ship it' }] }],
    ]
    for (const [former, current, args] of pairs) {
      const before = getToolDisplay(former, JSON.stringify(args))
      const after = getToolDisplay(current, JSON.stringify(args))
      expect(after.headerTitle).toBe(before.headerTitle)
      expect(after.formattedArgs).toEqual(before.formattedArgs)
      expect(after.headerTitle).not.toBeNull()
    }
  })
})
