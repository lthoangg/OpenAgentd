/**
 * The Review panel's tab strip speaks the sidebar's language (DESIGN.md →
 * Editor tabs): it sits on the same chrome tone as the sidebar, header and
 * status bar, and its open tab is marked the way the sidebar marks the open
 * session, so the two side columns read as one design.
 */
import { describe, expect, it } from 'bun:test'

import { listRowSurface } from '@/components/ui/list-row'
import { DOCK_STRIP_PART_CLASS, DOCK_TAB_STRIP_CLASS, dockTabClass } from '@/components/WorkspacePanel/dock-tab-styles'

describe('Review panel tab strip', () => {
  it('sits on the chrome tone: the page in light, the recessed rail in dark', () => {
    const classes = DOCK_TAB_STRIP_CLASS.split(' ')
    expect(classes).toContain('bg-(--bg-page)')
    expect(classes).toContain('dark:bg-(--bg-sidebar)')
    expect(classes).not.toContain('bg-(--bg-sidebar)')
  })

  it("marks the open tab like the sidebar's open session: its wash, medium weight and ink text", () => {
    const active = dockTabClass(true)
    expect(active).toContain(listRowSurface(true))
    expect(active).toContain('font-medium')
    expect(active).toContain('text-(--color-text)')
    // A page-coloured pill vanished on the dark rail (1.04:1).
    expect(active).not.toContain('bg-(--bg-page)')
  })

  it('washes a closed tab on hover the way a sidebar row does', () => {
    expect(dockTabClass(false)).toContain(listRowSurface(false))
  })

  it('steps the open tab back in a pane without focus, so the focused pane stands out', () => {
    const active = dockTabClass(true).split(' ')
    expect(active).toContain('[[data-pane-unfocused]_&]:text-(--color-text-2)')
    expect(active).toContain('[[data-pane-unfocused]_&]:bg-(--bg-key)/35')
    // A closed tab looks the same in either pane.
    expect(dockTabClass(false)).not.toContain('data-pane-unfocused')
  })

  // As an inactive window's title bar on macOS: the strips of the panes that
  // do not have focus fade, so the one ⌘W and ⌘1–9 act on reads at a glance.
  it('fades the tabs and buttons of a pane without focus', () => {
    const part = DOCK_STRIP_PART_CLASS.split(' ')
    expect(part).toContain('[[data-pane-unfocused]_&]:opacity-50')
    expect(part).toContain('transition-opacity')
    // The strip's own tone stays: only what sits on it fades.
    expect(DOCK_TAB_STRIP_CLASS).not.toContain('opacity')
  })
})
