import { describe, expect, it } from 'bun:test'
import { canonicalToolName, isPlanSubmission } from '@/utils/tool-names'

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

describe('isPlanSubmission', () => {
  it('recognises a plan call with submit, streaming or complete, and the former submit_plan', () => {
    expect(isPlanSubmission('plan', '{"submit": true}')).toBe(true)
    expect(isPlanSubmission('plan', '{"action":"write","content":"# P","submit":true,"summ')).toBe(true)
    expect(isPlanSubmission('plan', '{"submit": "true"}')).toBe(true)
    expect(isPlanSubmission('submit_plan', '{}')).toBe(true)
  })

  it('leaves plain saves and other tools alone, even when the plan text mentions submit', () => {
    expect(isPlanSubmission('plan', '{"action":"write","content":"# P"}')).toBe(false)
    expect(isPlanSubmission('plan', '{"submit": false}')).toBe(false)
    expect(isPlanSubmission('plan', '{"action":"write","content":"Call {\\"submit\\": true}"}')).toBe(false)
    expect(isPlanSubmission('plan', undefined)).toBe(false)
    expect(isPlanSubmission('ask_user', '{"submit": true}')).toBe(false)
  })
})
