/** The settings registry: 15 sections in 3 groups, with the merged pages' ids still landing on Sessions. */
import { describe, expect, it } from 'bun:test'

import { parentSection, sectionDef, SETTINGS_GROUPS, SETTINGS_SECTIONS } from '@/components/settings/sections'

describe('settings sections', () => {
  it('lists 15 sections in 3 groups, by who needs them', () => {
    const byGroup = SETTINGS_GROUPS.map((group) => [group.label, SETTINGS_SECTIONS.filter((s) => s.group === group.id).map((s) => s.label)])

    expect(byGroup).toEqual([
      ['Basics', ['Appearance', 'Models', 'Account', 'Desktop', 'About']],
      ['Agent', ['Agents', 'Skills', 'Connectors', 'Plugins', 'Memory']],
      ['Advanced', ['Sessions', 'Workspaces', 'Blocked files', 'Image and video', 'Server']],
    ])
    expect(SETTINGS_SECTIONS).toHaveLength(15)
  })

  it('keeps every section id it had, so links into Settings still land', () => {
    expect(SETTINGS_SECTIONS.map((s) => s.id).sort()).toEqual([
      'about', 'account', 'agents', 'connection', 'denied_paths', 'desktop', 'general', 'mcp', 'media', 'memory', 'plugins', 'providers', 'skills', 'titles', 'workspaces',
    ])
  })

  it('files the three merged pages under Sessions', () => {
    for (const id of ['context', 'goals', 'telemetry'] as const) {
      expect(parentSection(id)).toBe('titles')
      expect(sectionDef(id)?.label).toBe('Sessions')
    }
  })
})
