/**
 * Agents, Skills and Connectors editors look and behave alike: the main
 * agent is called Main agent (not its file, "code"), an agent opens as a
 * drill-down like a skill does, and each editor deletes from one "Delete
 * <thing>" row at its bottom.
 */
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'

mock.module('@/components/settings/AgentForm', () => ({ AgentForm: () => <div>form</div> }))
mock.module('@/components/SessionTools', () => ({ SessionTools: () => null }))
mock.module('@/queries/useAgentsQuery', () => ({ useAgentsQuery: () => ({ data: undefined }) }))

const AGENT = (name: string) => ({ name, path: `/cfg/agents/${name}.md`, content: `---\nname: ${name}\n---\nHi\n`, config: { tools: [] } })
mock.module('@/queries', () => ({
  useAgentFilesListQuery: () => ({
    data: { agents: [
      { name: 'code', role: 'lead', description: '', model: 'openai:gpt-5', valid: true },
      { name: 'reviewer', role: 'member', description: 'Reviews', model: 'openai:gpt-5', valid: true },
    ] },
    isLoading: false, isError: false, error: null, refetch: () => {},
  }),
  useCreateAgentMutation: () => ({ mutateAsync: async () => ({}), isPending: false }),
  useAgentFileQuery: (name: string) => ({ data: AGENT(name), isLoading: false, isError: false, error: null, refetch: () => {} }),
  useUpdateAgentMutation: () => ({ mutateAsync: async () => ({}), isPending: false }),
  useDeleteAgentMutation: () => ({ mutateAsync: async () => {}, isPending: false }),
  useSkillFileQuery: () => ({
    data: { name: 'mine', path: '/cfg/skills/mine/SKILL.md', content: '---\nname: mine\ndescription: x\n---\nDo.\n', editable: true, built_in: false },
    isLoading: false, isError: false, error: null, refetch: () => {},
  }),
  useUpdateSkillMutation: () => ({ mutateAsync: async () => ({}), isPending: false }),
  useDeleteSkillMutation: () => ({ mutateAsync: async () => {}, isPending: false }),
}))

const { AgentsListPage } = await import('@/components/settings/pages/settings.agents')
const { AgentEditorPage } = await import('@/components/settings/pages/settings.agents.$name')
const { SkillEditorPage } = await import('@/components/settings/pages/settings.skills.$name')
const { mobileBackTarget, parentSection } = await import('@/components/settings/sections')

afterEach(cleanup)

describe('the main agent', () => {
  it('is listed as Main agent, not by its file name', () => {
    render(<AgentsListPage onSelect={() => {}} />)
    expect(screen.getByText('Main agent')).toBeTruthy()
    expect(screen.queryByText('code')).toBeNull()
    expect(screen.getByText('reviewer')).toBeTruthy()
  })

  it('is titled Main agent in its editor, which has no Delete', () => {
    render(<AgentEditorPage name="code" onBack={() => {}} />)
    expect(screen.getByText('Main agent')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Delete…' })).toBeNull()
  })
})

describe('agents open like skills and connectors', () => {
  it('asks the modal to open an agent, so Back and the phone stack work as for the other lists', () => {
    const opened: string[] = []
    render(<AgentsListPage onSelect={(name) => opened.push(name)} />)
    fireEvent.click(screen.getByText('reviewer'))
    expect(opened).toEqual(['reviewer'])
    expect(parentSection('agents-edit')).toBe('agents')
    expect(mobileBackTarget('agents-edit')).toBe('agents')
  })
})

describe('one Delete row at the bottom of each editor', () => {
  it.each([
    ['a subagent', () => <AgentEditorPage name="reviewer" onBack={() => {}} />, 'Delete subagent'],
    ['a skill', () => <SkillEditorPage name="mine" onBack={() => {}} />, 'Delete skill'],
  ] as const)('for %s', (_what, page, label) => {
    const { container } = render(page())
    const row = container.querySelector('[data-editor-delete]') as HTMLElement
    expect(row).not.toBeNull()
    expect(row.textContent).toContain(label)
    expect(row.querySelector('button')?.textContent).toBe('Delete…')
  })
})
