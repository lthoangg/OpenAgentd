import { describe, expect, it } from 'bun:test'
import { getToolDisplay } from '@/components/ToolCall/display'

describe('ToolCall team tools display', () => {
  it('formats team_spawn with profile and sync mode', () => {
    const display = getToolDisplay(
      'team_spawn',
      JSON.stringify({ profile: 'explorer', task: 'Find all auth files', wait: true })
    )
    expect(display.headerTitle).toBe('Spawn subagent explorer')
    expect(display.formattedArgs).toBe('Find all auth files')
  })

  it('formats team_spawn with custom name and async mode', () => {
    const display = getToolDisplay(
      'team_spawn',
      JSON.stringify({ profile: 'explorer', name: 'explorer#1', task: 'Search frontend', wait: false })
    )
    expect(display.headerTitle).toBe('Spawn subagent explorer#1')
    expect(display.formattedArgs).toBe('Search frontend')
  })

  it('formats team_send with target member and message', () => {
    const display = getToolDisplay(
      'team_send',
      JSON.stringify({ member_id: 'explorer#1', message: 'Please focus on JWT only' })
    )
    expect(display.headerTitle).toBe('Message to explorer#1')
    expect(display.formattedArgs).toBe('Please focus on JWT only')
  })

  it('formats team_list header', () => {
    const display = getToolDisplay('team_list', '{}')
    expect(display.headerTitle).toBe('Listing team subagents…')
  })

  it('formats team_wait with target member IDs', () => {
    const display = getToolDisplay(
      'team_wait',
      JSON.stringify({ member_ids: ['explorer#1', 'explorer#2'], timeout: 60 })
    )
    expect(display.headerTitle).toBe('Waiting for explorer#1, explorer#2…')
  })

  it('formats team_stop with member ID', () => {
    const display = getToolDisplay(
      'team_stop',
      JSON.stringify({ member_id: 'explorer#1' })
    )
    expect(display.headerTitle).toBe('Stopping subagent explorer#1')
  })

  it('formats send_to_lead for progress vs final report', () => {
    const progressDisplay = getToolDisplay(
      'send_to_lead',
      JSON.stringify({ message: 'Scanned 10 files so far', end_turn: false })
    )
    expect(progressDisplay.headerTitle).toBe('Reporting progress to lead')

    const finalDisplay = getToolDisplay(
      'send_to_lead',
      JSON.stringify({ message: 'Completed audit', end_turn: true })
    )
    expect(finalDisplay.headerTitle).toBe('Reporting final deliverables to lead')
  })

  it('formats ask_lead with question', () => {
    const display = getToolDisplay(
      'ask_lead',
      JSON.stringify({ question: 'Which auth method should I audit?', options: ['jwt', 'cookie'] })
    )
    expect(display.headerTitle).toBe('Asking lead: Which auth method should I audit?')
    expect(display.formattedArgs).toBe('Which auth method should I audit?')
  })

  it('formats delegate tool with profile or target handle', () => {
    const spawnDisplay = getToolDisplay('delegate', JSON.stringify({ profile: 'explorer', task: 'Scan API files' }))
    expect(spawnDisplay.headerTitle).toBe('Delegate to explorer')
    expect(spawnDisplay.formattedArgs).toBe('Scan API files')

    const replyDisplay = getToolDisplay('delegate', JSON.stringify({ profile: 'explorer', target: 'explorer#1', task: 'Use JWT' }))
    expect(replyDisplay.headerTitle).toBe('Reply to explorer#1')
    expect(replyDisplay.formattedArgs).toBe('Use JWT')
  })

  it('formats team_manage for list, wait, and stop actions', () => {
    const listDisplay = getToolDisplay('team_manage', JSON.stringify({ action: 'list' }))
    expect(listDisplay.headerTitle).toBe('Listing team subagents…')

    const waitDisplay = getToolDisplay('team_manage', JSON.stringify({ action: 'wait', member_ids: ['exp#1'] }))
    expect(waitDisplay.headerTitle).toBe('Waiting for exp#1…')

    const stopDisplay = getToolDisplay('team_manage', JSON.stringify({ action: 'stop', member_id: 'exp#1' }))
    expect(stopDisplay.headerTitle).toBe('Stopping subagent exp#1')
  })
})
