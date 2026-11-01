/**
 * The scheduler modal is closed until asked for, so it loads on first open —
 * and then stays mounted so it can animate out. ⌘K and ⌘P mount one and the
 * same palette, scoped differently.
 */
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, render, screen } from '@testing-library/react'

mock.module('@/components/SchedulerPanel', () => ({
  SchedulerPanel: ({ open }: { open: boolean }) => <div role="dialog" aria-label="Scheduled tasks" data-open={open} />,
}))
mock.module('@/components/TodosPopover', () => ({ TodosPopover: () => null }))
mock.module('@/components/CommandPalette', () => ({ CommandPalette: () => null, QuickOpen: () => null }))
mock.module('@/components/AgentChatView/PaletteHost', () => ({
  PaletteHost: (props: { scope?: string; sessionId: string | null; workspaceFiles?: unknown[]; filesLoading?: boolean; onFileOpen?: unknown }) => (
    <div
      data-testid="palette"
      data-scope={props.scope ?? 'all'}
      data-session={props.sessionId ?? ''}
      data-files={props.workspaceFiles?.length ?? 0}
      data-files-loading={String(Boolean(props.filesLoading))}
      data-can-open-files={String(Boolean(props.onFileOpen))}
    />
  ),
}))

import { AgentChatPanels } from '@/components/AgentChatView/AgentChatPanels'

afterEach(cleanup)

function panels(open: { scheduler?: boolean; palette?: boolean; findFile?: boolean; noWorkspace?: boolean }) {
  return (
    <AgentChatPanels
      showTodos={false}
      onShowTodosChange={() => {}}
      todos={[]}
      schedulerOpen={open.scheduler ?? false}
      onCloseScheduler={() => {}}
      showPalette={open.palette ?? false}
      palettePage={[]}
      paletteKey={0}
      paletteCommands={[]}
      sessionId="s1"
      quickOpenOpen={open.findFile ?? false}
      quickOpenQuery=""
      quickOpenWorkspaceFiles={[{ path: 'a.ts', name: 'a.ts', size: 0, mtime: 0, mime: 'text/plain' }]}
      quickOpenFilesLoading
      onQuickOpenFileOpen={open.noWorkspace ? undefined : () => {}}
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

  it('mounts no palette until one is asked for', () => {
    render(panels({}))
    expect(screen.queryByTestId('palette')).toBeNull()
  })

  it('opens ⌘K as the palette over everything, with the workspace files and the open session', () => {
    render(panels({ palette: true }))
    const palette = screen.getByTestId('palette')
    expect(palette.dataset).toMatchObject({ scope: 'all', session: 's1', files: '1', filesLoading: 'true', canOpenFiles: 'true' })
  })

  it('opens ⌘P as the same palette scoped to files', () => {
    render(panels({ findFile: true }))
    expect(screen.getAllByTestId('palette')).toHaveLength(1)
    expect(screen.getByTestId('palette').dataset).toMatchObject({ scope: 'files', session: 's1', files: '1' })
  })

  it('offers no files to the palette without a workspace', () => {
    render(panels({ palette: true, noWorkspace: true }))
    expect(screen.getByTestId('palette').dataset.canOpenFiles).toBe('false')
  })
})
