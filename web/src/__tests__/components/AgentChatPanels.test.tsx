/**
 * The scheduler modal is closed until asked for, so it loads on first open —
 * and then stays mounted so it can animate out.
 */
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, render, screen } from '@testing-library/react'

mock.module('@/components/SchedulerPanel', () => ({
  SchedulerPanel: ({ open }: { open: boolean }) => <div role="dialog" aria-label="Scheduled tasks" data-open={open} />,
}))
mock.module('@/components/TodosPopover', () => ({ TodosPopover: () => null }))
mock.module('@/components/CommandPalette', () => ({ CommandPalette: () => null, QuickOpen: () => null }))

import { AgentChatPanels } from '@/components/AgentChatView/AgentChatPanels'

afterEach(cleanup)

function panels(open: { scheduler?: boolean }) {
  return (
    <AgentChatPanels
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
  for (const [name, key] of [['Scheduled tasks', 'scheduler']] as const) {
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
