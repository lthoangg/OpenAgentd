/**
 * SessionTools — the collapsible tool inventory in session settings.
 *
 * It answers "what can this session actually do", grouped by where each tool
 * comes from. Auto-opened by default so users immediately see available tools.
 */
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

mock.module('lucide-react', () => new Proxy({}, { get: () => () => null }))

import { SessionTools } from '@/components/SessionTools'
import type { AgentToolInfo } from '@/api/types'

afterEach(cleanup)

const BUILTINS: AgentToolInfo[] = [
  { name: 'read', description: 'Read a file from the workspace.' },
  { name: 'patch', description: 'Apply a patch.' },
]

function renderTools(
  tools: AgentToolInfo[] = BUILTINS,
  mcpServers: string[] = [],
  defaultOpen?: boolean,
) {
  return render(
    <SessionTools tools={tools} mcpServers={mcpServers} defaultOpen={defaultOpen} />,
  )
}

/** The disclosure button that opens the whole section. */
function toggle() {
  return screen.getByRole('button', { name: /^tools/i })
}

describe('SessionTools', () => {
  it('starts open by default, reporting total count and displaying tools', () => {
    renderTools()

    expect(toggle().getAttribute('aria-expanded')).toBe('true')
    expect(within(toggle()).getByText('2')).toBeTruthy()
    expect(screen.getByText('read')).toBeTruthy()
    expect(screen.getByText('patch')).toBeTruthy()
  })

  it('can be collapsed when toggled', async () => {
    renderTools()

    expect(toggle().getAttribute('aria-expanded')).toBe('true')
    await userEvent.click(toggle())

    expect(toggle().getAttribute('aria-expanded')).toBe('false')
    expect(screen.queryByText('read')).toBeNull()
  })

  it('can start collapsed if defaultOpen=false is provided', () => {
    renderTools(BUILTINS, [], false)

    expect(toggle().getAttribute('aria-expanded')).toBe('false')
    expect(within(toggle()).getByText('2')).toBeTruthy()
    expect(screen.queryByText('read')).toBeNull()
  })

  it('groups MCP tools under their server and leaves the rest built-in', () => {
    renderTools(
      [
        ...BUILTINS,
        { name: 'github_create_issue', description: 'Open an issue.' },
        { name: 'github_list_prs', description: 'List pull requests.' },
      ],
      ['github'],
    )

    const builtinGroup = screen.getByRole('group', { name: /built-in/i })
    expect(within(builtinGroup).getByText('read')).toBeTruthy()
    expect(within(builtinGroup).queryByText('github_create_issue')).toBeNull()

    const mcpGroup = screen.getByRole('group', { name: /github/i })
    expect(within(mcpGroup).getByText('github_create_issue')).toBeTruthy()
    expect(within(mcpGroup).getByText('github_list_prs')).toBeTruthy()
  })

  it('keeps a tool description hidden until its row is opened', async () => {
    renderTools()

    expect(screen.queryByText('Read a file from the workspace.')).toBeNull()

    await userEvent.click(screen.getByRole('button', { name: /read/i }))
    expect(await screen.findByText('Read a file from the workspace.')).toBeTruthy()
  })

  it('offers a filter once the list is long enough to need one', async () => {
    const many = Array.from({ length: 9 }, (_, i) => ({
      name: `tool_${i}`,
      description: `Does thing ${i}.`,
    }))
    renderTools(many)

    const filter = screen.getByPlaceholderText(/filter tools/i)
    await userEvent.type(filter, 'tool_3')

    expect(screen.getByText('tool_3')).toBeTruthy()
    expect(screen.queryByText('tool_4')).toBeNull()
  })

  it('does not offer a filter for a short list', () => {
    renderTools()

    expect(screen.queryByPlaceholderText(/filter tools/i)).toBeNull()
  })

  it('matches on description text as well as name', async () => {
    const many = Array.from({ length: 9 }, (_, i) => ({
      name: `tool_${i}`,
      description: i === 5 ? 'Renders a mermaid diagram.' : `Does thing ${i}.`,
    }))
    renderTools(many)

    await userEvent.type(screen.getByPlaceholderText(/filter tools/i), 'mermaid')

    expect(screen.getByText('tool_5')).toBeTruthy()
    expect(screen.queryByText('tool_4')).toBeNull()
  })

  it('says so when a filter matches nothing', async () => {
    const many = Array.from({ length: 9 }, (_, i) => ({
      name: `tool_${i}`,
      description: `Does thing ${i}.`,
    }))
    renderTools(many)

    await userEvent.type(screen.getByPlaceholderText(/filter tools/i), 'zzznope')

    expect(screen.getByText(/no tools match/i)).toBeTruthy()
  })

  it('shows a configured server that has contributed no tools', () => {
    renderTools(BUILTINS, ['figma'])

    const mcpGroup = screen.getByRole('group', { name: /figma/i })
    expect(within(mcpGroup).getByText(/no tools available/i)).toBeTruthy()
  })

  it('renders nothing at all when there are no tools and no servers', () => {
    renderTools([], [])

    expect(screen.queryByRole('button', { name: /^tools/i })).toBeNull()
  })
})
