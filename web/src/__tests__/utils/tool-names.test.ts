import { describe, expect, it } from 'bun:test'
import { canonicalToolName } from '@/utils/tool-names'

describe('canonicalToolName', () => {
  it('maps former tool names to the current ones', () => {
    expect(canonicalToolName('todo_manage')).toBe('todo')
    expect(canonicalToolName('schedule_task')).toBe('schedule')
    expect(canonicalToolName('send_to_workspace')).toBe('workspace')
    expect(canonicalToolName('delegate')).toBe('team')
  })

  it('leaves current and unrelated names alone', () => {
    for (const name of ['todo', 'schedule', 'workspace', 'team', 'team_manage', 'read', 'mcp']) {
      expect(canonicalToolName(name)).toBe(name)
    }
  })
})
