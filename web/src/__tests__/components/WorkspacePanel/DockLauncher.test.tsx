/**
 * The launcher's rows by place: views then tools in a repository, tools
 * first where there is no Git (Chat, a plain folder), on desktop and phone.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { cleanup, render, screen } from '@testing-library/react'

import { DockLauncher, dockOpenItems } from '@/components/WorkspacePanel/DockLauncher'

afterEach(cleanup)

const run = () => {}
const everything = { onOpenGit: run, onOpenGoal: run, onOpenPlan: run, onOpenTasks: run, onOpenSideQuestions: run, onOpenSchedule: run, onOpenTerminal: run, onOpenPreview: run, onOpenFile: run }

describe('dockOpenItems', () => {
  it('lists views, then tools', () => {
    expect(dockOpenItems('macos', everything).map((row) => row.label)).toEqual([
      'Git', 'Goal', 'Plan', 'Tasks', 'Side questions', 'Scheduled tasks', 'Terminal', 'Browser', 'Find file…',
    ])
  })

  it('leads with files, preview and terminal where there is no Git', () => {
    const rows = dockOpenItems('macos', { onOpenTasks: run, onOpenSchedule: run, onOpenTerminal: run, onOpenPreview: run, onOpenFile: run }, new Set(), {}, { toolsFirst: true })
    expect(rows.map((row) => row.label)).toEqual(['Find file…', 'Browser', 'Terminal', 'Tasks', 'Scheduled tasks'])
  })

  it('drops a row whose handler is missing', () => {
    expect(dockOpenItems('macos', { onOpenFile: run }).map((row) => row.id)).toEqual(['file'])
  })
})

describe('DockLauncher on a phone', () => {
  it('puts Views first in a repository', () => {
    render(<DockLauncher phone items={dockOpenItems('ios', { onOpenGit: run, onOpenSchedule: run, onOpenTerminal: run, onOpenFile: run })} />)
    expect(screen.getAllByRole('group').map((group) => group.getAttribute('aria-label'))).toEqual(['Views', 'Tools'])
  })

  it('puts Tools first where there is no Git, with the files leading', () => {
    render(<DockLauncher phone items={dockOpenItems('ios', { onOpenSchedule: run, onOpenTerminal: run, onOpenPreview: run, onOpenFile: run }, new Set(), {}, { toolsFirst: true })} />)
    const groups = screen.getAllByRole('group')
    expect(groups.map((group) => group.getAttribute('aria-label'))).toEqual(['Tools', 'Views'])
    expect(Array.from(groups[0].querySelectorAll('button'), (row) => row.textContent)).toEqual(['Find file', 'Browser', 'Terminal'])
    expect(Array.from(groups[1].querySelectorAll('button'), (row) => row.textContent)).toEqual(['Scheduled tasks'])
  })
})
