/** The settings registry: 15 sections in four named groups, with About apart at the bottom. */
import { describe, expect, it } from 'bun:test'

import { parentSection, sectionDef, SETTINGS_GROUPS, SETTINGS_SECTIONS } from '@/components/settings/sections'

describe('settings sections', () => {
  it('groups the sections by what they are about, About last on its own', () => {
    const byGroup = SETTINGS_GROUPS.map((group) => [group.label, SETTINGS_SECTIONS.filter((s) => s.group === group.id).map((s) => s.label)])

    expect(byGroup).toEqual([
      ['Basics', ['General', 'Models', 'Image and video', 'Desktop']],
      ['Agent', ['Agents', 'Skills', 'Connectors', 'Plugins', 'Memory']],
      ['Work', ['Sessions', 'Workspaces', 'Blocked files']],
      ['Devices', ['Computers', 'Remote control']],
      [null, ['About']],
    ])
    expect(SETTINGS_SECTIONS).toHaveLength(15)
  })

  it('names every section id after its label', () => {
    for (const s of SETTINGS_SECTIONS) {
      const id = s.id.replace(/_/g, ' ')
      // Two labels say more than one word: "Image and video" (media) and "Remote control" (remote).
      const expected = { media: 'image and video', remote: 'remote control' }[s.id as string] ?? id
      expect(s.label.toLowerCase()).toBe(expected)
    }
  })

  it('files the drill-down editors under their list', () => {
    expect(parentSection('connectors-edit')).toBe('connectors')
    expect(parentSection('skills-new')).toBe('skills')
    expect(sectionDef('connectors-new')?.label).toBe('Connectors')
  })
})
