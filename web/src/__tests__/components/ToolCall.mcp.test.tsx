import { describe, expect, it } from 'bun:test'
import { getToolDisplay } from '@/components/ToolCall/display'

const display = (args: Record<string, unknown>) => getToolDisplay('mcp', JSON.stringify(args))

describe('mcp display', () => {
  it('describes searches', () => {
    expect(display({ action: 'search', query: 'create issue' }).headerTitle).toBe('Search MCP tools "create issue"')
    expect(display({ action: 'search', query: 'issue', server: 'github' }).headerTitle).toBe('Search MCP tools "issue" in github')
    expect(display({ action: 'search', server: 'github' }).headerTitle).toBe('List github tools')
    expect(display({ action: 'search' }).headerTitle).toBe('List MCP tools')
    expect(display({ action: 'search', query: 'x' }).formattedArgs).toBeNull()
  })

  it('names the server and tool of a call and shows its arguments', () => {
    const d = display({ action: 'call', server: 'github', tool: 'create_issue', arguments: { title: 'Bug' } })
    expect(d.headerTitle).toBe('MCP github · create_issue')
    expect(d.formattedArgs).toBe(JSON.stringify({ title: 'Bug' }, null, 2))
  })

  it('pretty-prints JSON-string arguments and hides empty ones', () => {
    expect(display({ action: 'call', server: 's', tool: 't', arguments: '{"a":1}' }).formattedArgs).toBe(JSON.stringify({ a: 1 }, null, 2))
    expect(display({ action: 'call', server: 's', tool: 't', arguments: {} }).formattedArgs).toBeNull()
    expect(display({ action: 'call', server: 's', tool: 't' }).formattedArgs).toBeNull()
    expect(display({ action: 'call' }).headerTitle).toBe('MCP call')
  })

  it('reads partial (streaming) arguments', () => {
    expect(getToolDisplay('mcp', '{"action": "call", "server": "github", "tool": "list_issues", "argu').headerTitle).toBe('MCP github · list_issues')
  })
})
