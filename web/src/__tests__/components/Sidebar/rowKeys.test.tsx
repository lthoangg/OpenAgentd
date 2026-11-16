import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { act, fireEvent, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  cleanupSidebarHarness,
  deleteSessionMutate,
  fx,
  renderSidebarForSessions,
  resetSidebarHarness,
} from './harness'

describe('Sidebar workspace trust flow', () => {
  beforeEach(resetSidebarHarness)
  afterEach(cleanupSidebarHarness)

  describe('keyboard', () => {
    const twoSessions = () => {
      fx.sessionsData = ['First', 'Second'].map((title, i) => ({
        id: `session-${i + 1}`,
        title,
        agent_name: 'lead',
        created_at: `2026-05-1${3 - i}T00:00:00Z`,
        updated_at: `2026-05-1${3 - i}T00:00:00Z`,
        mode: 'coding',
        workspace: '/repo/project',
      }))
      fx.workspaceSessionsData = fx.sessionsData
    }
    const frame = () => act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())))
    const row = (title: string) =>
      Array.from(document.querySelectorAll<HTMLElement>('[data-sidebar-session]')).find((el) => el.textContent?.includes(title))!

    it('keeps every row and its actions in Tab order', async () => {
      twoSessions()
      await renderSidebarForSessions('session-1')
      await frame()
      expect(row('First').getAttribute('aria-current')).toBe('page')
      for (const el of [
        row('First'),
        row('Second'),
        screen.getByLabelText('Open workspace project'),
        screen.getByLabelText('Pin session First'),
        screen.getByLabelText('More actions for First'),
        screen.getByLabelText('Actions for project'),
      ]) expect(el.tabIndex).toBe(0)
      // The chevron is a pointer target; ←/→ on the name fold from the keyboard.
      expect(screen.getByLabelText('Collapse workspace project').tabIndex).toBe(-1)
    })

    it('climbs and folds the workspace with Left/Right', async () => {
      const user = userEvent.setup()
      twoSessions()
      await renderSidebarForSessions('session-1')
      row('Second').focus()
      await user.keyboard('{ArrowLeft}')
      const header = screen.getByLabelText('Open workspace project')
      expect(document.activeElement).toBe(header)
      expect(header.getAttribute('aria-description')).toBe('Expanded')
      await user.keyboard('{ArrowLeft}')
      expect(header.getAttribute('aria-description')).toBe('Collapsed')
      expect(screen.getByLabelText('Expand workspace project').getAttribute('aria-expanded')).toBe('false')
      await user.keyboard('{ArrowRight}')
      expect(header.getAttribute('aria-description')).toBe('Expanded')
      expect(document.activeElement).toBe(header)
    })

    it('ignores F2, Delete, ⌘⌫ and Shift+F10 on a session row', async () => {
      const user = userEvent.setup()
      twoSessions()
      await renderSidebarForSessions('session-1')
      row('Second').focus()
      await user.keyboard('{Shift>}{F10}{/Shift}')
      await user.keyboard('{ContextMenu}')
      expect(screen.queryByRole('menu')).toBeNull()
      await user.keyboard('{F2}')
      expect(screen.queryByLabelText('Session title')).toBeNull()
      await user.keyboard('{Delete}')
      await user.keyboard('{Meta>}{Backspace}{/Meta}')
      await user.keyboard('{Control>}{Backspace}{/Control}')
      expect(deleteSessionMutate).not.toHaveBeenCalled()
    })

    it('ignores Shift+F10 on a workspace row', async () => {
      const user = userEvent.setup()
      twoSessions()
      await renderSidebarForSessions('session-1')
      screen.getByLabelText('Open workspace project').focus()
      await user.keyboard('{Shift>}{F10}{/Shift}')
      expect(screen.queryByRole('menu')).toBeNull()
    })

    it('moves between rows with Up/Down and jumps with Home/End', async () => {
      const user = userEvent.setup()
      twoSessions()
      await renderSidebarForSessions('session-1')
      const header = screen.getByLabelText('Open workspace project')
      header.focus()

      await user.keyboard('{ArrowDown}')
      expect(document.activeElement).toBe(row('First'))
      await user.keyboard('{ArrowDown}')
      expect(document.activeElement).toBe(row('Second'))
      await user.keyboard('{ArrowUp}')
      expect(document.activeElement).toBe(row('First'))
      await user.keyboard('{End}')
      expect(document.activeElement).toBe(row('Second'))
      await user.keyboard('{Home}')
      const rows = Array.from(document.querySelectorAll<HTMLElement>('[data-sidebar-session], [data-sidebar-workspace]'))
      expect(document.activeElement).toBe(rows[0])
    })

    it('skips the rows of a folded workspace', async () => {
      const user = userEvent.setup()
      twoSessions()
      await renderSidebarForSessions('session-1')
      const header = screen.getByLabelText('Open workspace project')
      header.focus()
      await user.keyboard('{ArrowLeft}')

      await user.keyboard('{ArrowDown}')
      expect(document.activeElement === row('First') || document.activeElement === row('Second')).toBe(false)
    })

    it('leaves Up/Down alone in the rename field', async () => {
      const user = userEvent.setup()
      twoSessions()
      await renderSidebarForSessions('session-1')
      fireEvent.contextMenu(row('Second'))
      await user.click(within(await screen.findByRole('menu')).getByRole('menuitem', { name: 'Rename' }))
      const input = screen.getByLabelText('Session title')
      input.focus()
      await user.keyboard('{ArrowUp}')
      expect(document.activeElement).toBe(input)
    })
  })
})
