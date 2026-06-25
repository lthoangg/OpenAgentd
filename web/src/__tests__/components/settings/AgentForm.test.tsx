/**
 * AgentForm — focused tests for the MCP server picker, the server-prefixed tool
 * filter, and the YAML round-trip of the new ``mcp:`` frontmatter field.
 *
 * The existing form already has broad coverage of identity / model /
 * tools / skills via integration. These tests cover only the deltas
 * introduced when MCP server membership moved into a dedicated picker.
 */
import { describe, it, expect, afterEach, mock } from 'bun:test'
import { render, screen, cleanup, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { AgentForm } from '@/components/settings/AgentForm'
import {
  buildFrontmatter,
  splitFrontmatter,
  combine,
  type AgentFrontmatter,
} from '@/components/settings/frontmatter'

// ── Module mocks ─────────────────────────────────────────────────────────────

mock.module('lucide-react', () => new Proxy({}, { get: () => () => null }))

// Single source of truth for the registry + MCP servers fixture across the
// test file. Tests can mutate the inner arrays freely; the mocked hooks
// always return live references.
const registryFixture = {
  tools: [
    { name: 'shell', description: 'Run a shell command' },
    { name: 'read', description: 'Read a file' },
    { name: 'skill', description: 'Load skill instructions' },
    { name: 'todo_manage', description: 'Manage tasks' },
    { name: 'schedule_task', description: 'Schedule reminders' },
    { name: 'note', description: 'Record notes' },
    // These should be hidden from the Tools picker — they belong to MCP
    // servers and are granted via the MCP picker.
    { name: 'context7_resolve_library_id', description: 'C7 resolve' },
    { name: 'context7_get_library_docs', description: 'C7 docs' },
  ],
  skills: [{ name: 'self-healing', description: 'Repair the agent config' }],
  providers: ['openai'],
  models: [
    { id: 'openai:gpt-5.4', provider: 'openai', model: 'gpt-5.4', vision: false },
  ],
}

const mcpFixture = {
  servers: [
    {
      name: 'context7',
      transport: 'http' as const,
      enabled: true,
      state: 'ready' as const,
      error: null,
      tool_names: ['resolve_library_id', 'get_library_docs'],
      started_at: null,
      config: null,
    },
    {
      name: 'filesystem',
      transport: 'stdio' as const,
      enabled: true,
      state: 'error' as const,
      error: 'spawn failed',
      tool_names: [],
      started_at: null,
      config: null,
    },
  ],
}

mock.module('@/queries', () => ({
  useRegistryQuery: () => ({
    data: registryFixture,
    isLoading: false,
    isError: false,
    error: null,
  }),
  useAgentFilesQuery: () => ({
    data: {
      agents: [
        {
          name: 'openagentd',
          role: 'lead',
          description: 'Built-in lead',
          model: 'openai:gpt-5.4',
          tools: ['skill', 'todo_manage', 'schedule_task', 'note', 'shell', 'read', 'write'],
          mcp: [],
          skills: ['self-healing'],
          valid: true,
          error: null,
        },
        {
          name: 'helper',
          role: 'member',
          description: 'Custom helper',
          model: 'openai:gpt-5.4',
          tools: ['skill', 'read'],
          mcp: [],
          skills: [],
          valid: true,
          error: null,
        },
        {
          name: 'coding/coder',
          role: 'member',
          description: 'Built-in coder',
          model: 'openai:gpt-5.4',
          tools: ['skill', 'read', 'shell'],
          mcp: [],
          skills: [],
          valid: true,
          error: null,
        },
      ],
    },
    isLoading: false,
    isError: false,
    error: null,
  }),
  useMcpServersQuery: () => ({
    data: mcpFixture,
    isLoading: false,
    isError: false,
    error: null,
  }),
}))

afterEach(cleanup)

// ── frontmatter round-trip ───────────────────────────────────────────────────

describe('frontmatter — mcp field', () => {
  it('emits sorted mcp list under its own key', () => {
    const fm: AgentFrontmatter = {
      name: 'openagentd',
      role: 'lead',
      model: 'openai:gpt-5.4',
      mcp: ['filesystem', 'context7'],
    }
    const yaml = buildFrontmatter(fm)
    // Sorted ascending, one entry per line, indented two spaces.
    expect(yaml).toContain('mcp:\n  - context7\n  - filesystem')
  })

  it('omits the mcp key entirely when empty / undefined', () => {
    const fm: AgentFrontmatter = {
      name: 'a',
      role: 'member',
      model: 'openai:gpt-5.4',
    }
    expect(buildFrontmatter(fm)).not.toContain('mcp:')
    expect(buildFrontmatter({ ...fm, mcp: [] })).not.toContain('mcp:')
  })

  it('survives a combine → split round-trip', () => {
    const raw = combine(
      {
        name: 'openagentd',
        role: 'lead',
        model: 'openai:gpt-5.4',
        mcp: ['context7'],
      },
      'You are openagentd.',
    )
    const { fm: fmText, body } = splitFrontmatter(raw)
    expect(fmText).toContain('mcp:')
    expect(fmText).toContain('- context7')
    expect(body.trim()).toBe('You are openagentd.')
  })
})

// ── AgentForm — picker rendering & tool filtering ───────────────────────────

const SAMPLE_RAW = `---
name: openagentd
role: lead
model: openai:gpt-5.4
tools:
  - shell
  - read
mcp:
  - context7
---

You are openagentd.
`

function renderForm(initial = SAMPLE_RAW, agentPath?: string) {
  // Mocks are typed loosely; the real callbacks are typed via the AgentForm
  // prop signature so this is purely a spy.
  const onChange = mock(() => {})
  const onModeChange = mock(() => {})
  render(
    <AgentForm
      initial={initial}
      agentPath={agentPath}
      onChange={onChange}
      mode="form"
      onModeChange={onModeChange}
    />,
  )
  return { onChange, onModeChange }
}

/**
 * Locate the ``Field`` wrapper for a given label. The form renders each
 * field as ``<div class="flex flex-col gap-1.5"><span>Label</span> ...</div>``
 * — the parent of the label span is the field root.
 */
function fieldFor(label: string): HTMLElement {
  const span = screen.getByText(label, { selector: 'span' })
  const root = span.parentElement
  if (!root) throw new Error(`No field root for label ${label}`)
  return root as HTMLElement
}

/** The MultiSelect trigger inside a given field. */
function comboboxIn(label: string): HTMLElement {
  return within(fieldFor(label)).getByRole('combobox')
}

describe('AgentForm — Capabilities card', () => {
  it('hides MCP server-prefixed entries from the Tools picker', async () => {
    const user = userEvent.setup()
    renderForm()

    await user.click(comboboxIn('Tools'))
    // After opening, the search input is focused. Type a query that would
    // otherwise match the context7_* entries.
    const search = screen.getByLabelText('Search options')
    await user.type(search, 'context7_')

    // The list shows the empty state and the count only includes selectable
    // non-MCP, non-implicit tools.
    expect(screen.queryByText('context7_resolve_library_id')).toBeNull()
    expect(screen.queryByText('context7_get_library_docs')).toBeNull()
    expect(screen.getByText('0/2')).toBeTruthy()
  })

  it('renders the MCP servers picker with available servers', async () => {
    const user = userEvent.setup()
    renderForm()

    await user.click(comboboxIn('MCP servers'))

    // Both server names appear as option rows; even the errored one stays
    // pickable so an agent can keep referencing it during repair.
    const listbox = screen.getByRole('listbox')
    expect(within(listbox).getByText('context7')).toBeTruthy()
    expect(within(listbox).getByText('filesystem')).toBeTruthy()
  })

  it('shows built-in tools separately from extra tool overrides', () => {
    renderForm(SAMPLE_RAW, 'openagentd')

    const toolsField = fieldFor('Tools')
    const builtInBox = within(toolsField).getByText('Built-in tools').parentElement
    if (!builtInBox) throw new Error('missing built-in tools box')
    expect(within(builtInBox).getByText('write')).toBeTruthy()
    expect(within(builtInBox).getByText('skill')).toBeTruthy()
    expect(within(builtInBox).getByText('todo_manage')).toBeTruthy()
    expect(within(builtInBox).queryByText('shell')).toBeNull()
    expect(within(builtInBox).queryByText('read')).toBeNull()
    expect(screen.getByText(/2 extra selected/i)).toBeTruthy()
  })

  it('shows skill as a built-in tool for custom agents too', async () => {
    const user = userEvent.setup()
    renderForm(`---
name: helper
role: member
model: openai:gpt-5.4
tools:
  - read
---
Custom helper.
`, 'helper')

    const toolsField = fieldFor('Tools')
    const builtInBox = within(toolsField).getByText('Built-in tools').parentElement
    if (!builtInBox) throw new Error('missing built-in tools box')
    expect(within(builtInBox).getByText('skill')).toBeTruthy()

    await user.click(comboboxIn('Tools'))
    const listbox = screen.getByRole('listbox')
    expect(within(listbox).queryByText('skill')).toBeNull()
  })

  it('does not offer implicit lead-only or skill tools in the extra picker', async () => {
    const user = userEvent.setup()
    renderForm(SAMPLE_RAW, 'openagentd')

    await user.click(comboboxIn('Tools'))
    const listbox = screen.getByRole('listbox')
    expect(within(listbox).queryByText('skill')).toBeNull()
    expect(within(listbox).queryByText('todo_manage')).toBeNull()
    expect(within(listbox).queryByText('schedule_task')).toBeNull()
    expect(within(listbox).queryByText('note')).toBeNull()
  })

  it('shows the picker hint with selected count', () => {
    renderForm()
    // Sample has one server selected (context7), two available.
    expect(screen.getByText(/1 selected of 2 available/i)).toBeTruthy()
  })

  it('treats coding built-in members as additive profiles based on path', () => {
    renderForm(`---
name: coder
role: member
model: openai:gpt-5.4
---
<!-- Add extra prompt text below. -->
`, 'coding/coder')

    expect(screen.getByText('Built-in OpenAgentd profile')).toBeTruthy()
    expect(screen.getByText('Extra prompt')).toBeTruthy()
    expect(screen.getByText(/Built-in tools are always included/i)).toBeTruthy()
  })

  it('renders the existing mcp selection as a chip', () => {
    renderForm()
    const trigger = comboboxIn('MCP servers')
    // The chip renders `context7` text inside the trigger div.
    expect(within(trigger).getByText('context7')).toBeTruthy()
  })

  it('falls back to the empty-state hint when no servers are configured', () => {
    const original = [...mcpFixture.servers]
    mcpFixture.servers.length = 0
    try {
      renderForm()
      expect(screen.getByText(/No MCP servers configured/i)).toBeTruthy()
    } finally {
      mcpFixture.servers.push(...original)
    }
  })
})

// ── AgentForm — write-back into raw on selection ────────────────────────────

describe('AgentForm — selecting an MCP server updates raw', () => {
  it('appends the new server to the mcp: list in YAML', async () => {
    const user = userEvent.setup()
    const { onChange } = renderForm()

    onChange.mockClear()

    await user.click(comboboxIn('MCP servers'))
    // The popover renders an unfiltered listbox — pick the not-yet-selected
    // server.
    const listbox = screen.getByRole('listbox')
    await user.click(within(listbox).getByText('filesystem'))

    const lastCall = onChange.mock.calls.at(-1)
    expect(lastCall).toBeDefined()
    const nextRaw = lastCall![0] as string
    expect(nextRaw).toContain('mcp:\n  - context7\n  - filesystem')
  })
})
