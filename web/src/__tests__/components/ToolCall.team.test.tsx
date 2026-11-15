import { describe, expect, it } from 'bun:test'
import { getToolDisplay } from '@/components/ToolCall/display'

describe('ToolCall team tools display', () => {
  /** Tools the app no longer has get the ordinary card: name, then the call as JSON. */
  it('shows a retired team tool as an ordinary tool card', () => {
    const calls: [string, Record<string, unknown>][] = [
      ['team_spawn', { profile: 'explorer', task: 'Find all auth files' }],
      ['team_send', { member_id: 'explorer#1', message: 'Please focus on JWT only' }],
      ['team_wait', { member_ids: ['explorer#1'] }],
      ['team_stop', { member_id: 'explorer#1' }],
      ['team_manage', { action: 'stop', member_id: 'explorer#1' }],
      ['send_to_lead', { message: 'Completed audit', end_turn: true }],
    ]
    for (const [name, args] of calls) {
      const display = getToolDisplay(name, JSON.stringify(args))
      expect(display.header).toBeNull()
      expect(display.headerTitle).toBeNull()
      expect(display.formattedArgs).toBe(JSON.stringify(args, null, 2))
    }
    expect(getToolDisplay('team_list', '{}').formattedArgs).toBeNull()
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
