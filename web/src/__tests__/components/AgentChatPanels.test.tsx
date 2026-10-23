/**
 * The scheduler and Session Settings modals are closed until asked for, so
 * they load on first open — and then stay mounted so they can animate out.
 */
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, render, screen } from '@testing-library/react'

mock.module('@/components/SchedulerPanel', () => ({
  SchedulerPanel: ({ open }: { open: boolean }) => <div role="dialog" aria-label="Scheduled tasks" data-open={open} />,
}))
mock.module('@/components/SessionSettingsPanel', () => ({
  SessionSettingsPanel: ({ open }: { open: boolean }) => <div role="dialog" aria-label="Session settings" data-open={open} />,
}))
mock.module('@/components/TodosPopover', () => ({ TodosPopover: () => null }))
mock.module('@/components/CommandPalette', () => ({ CommandPalette: () => null, QuickOpen: () => null }))

import { AgentChatPanels } from '@/components/AgentChatView/AgentChatPanels'

afterEach(cleanup)

function panels(open: { scheduler?: boolean; settings?: boolean }) {
  return (
    <AgentChatPanels
      agentCapabilitiesOpen={open.settings ?? false}
      agentWorkspace="/repo"
      sessionModel={null}
      sessionThinkingLevel={null}
      onSessionModelSettingsChange={() => {}}
      onCloseAgentCapabilities={() => {}}
      showTodos={false}
      onShowTodosChange={() => {}}
      todos={[]}
      schedulerOpen={open.scheduler ?? false}
      onCloseScheduler={() => {}}
      showPalette={false}
      palettePage={[]}
      paletteKey={0}
      paletteCommands={[]}
      quickOpenOpen={false}
      quickOpenQuery=""
      quickOpenWorkspaceFiles={[]}
      onQuickOpenFileOpen={() => {}}
      onClosePalette={() => {}}
      onCloseQuickOpen={() => {}}
    />
  )
}

describe('AgentChatPanels', () => {
  for (const [name, key] of [['Scheduled tasks', 'scheduler'], ['Session settings', 'settings']] as const) {
    it(`mounts ${name} on first open and keeps it for its exit`, async () => {
      const { rerender } = render(panels({}))
      expect(screen.queryByRole('dialog', { name })).toBeNull()

      rerender(panels({ [key]: true }))
      expect((await screen.findByRole('dialog', { name })).getAttribute('data-open')).toBe('true')

      rerender(panels({}))
      expect(screen.getByRole('dialog', { name }).getAttribute('data-open')).toBe('false')
    })
  }
})
