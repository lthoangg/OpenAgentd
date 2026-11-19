/**
 * Every search result lands on text its page shows. A result scrolls to
 * `anchor ?? label` (`revealSetting`); a name the page does not show is a
 * dead end that opens the section and scrolls nowhere. Each section's page
 * (and the components it shows) must hold that text as a heading, label or
 * button, written out in its source.
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { SETTINGS_INDEX } from '@/components/settings/settings-index'
import { SETTINGS_SECTIONS, type TopLevelSection } from '@/components/settings/sections'

const SRC = fileURLToPath(new URL('../../../', import.meta.url))
const P = 'components/settings/pages'

/** The source files that render each section. */
const PAGE_SOURCES: Record<TopLevelSection, readonly string[]> = {
  general: [`${P}/settings.general.tsx`],
  models: [`${P}/settings.models.tsx`],
  media: [`${P}/settings.media.tsx`],
  desktop: [`${P}/settings.desktop.tsx`, 'components/settings/PetSettingsSection.tsx', 'components/settings/StartupSection.tsx'],
  agents: ['components/settings/SettingsListView.tsx', `${P}/settings.agents.tsx`],
  skills: [`${P}/settings.skills.tsx`],
  connectors: [`${P}/settings.connectors.tsx`],
  plugins: [`${P}/settings.plugins.tsx`],
  memory: [`${P}/settings.memory.tsx`],
  sessions: [`${P}/sessions/titles.tsx`, `${P}/sessions/summaries.tsx`, `${P}/sessions/goals.tsx`, `${P}/sessions/history.tsx`],
  workspaces: [`${P}/settings.workspaces.tsx`],
  blocked_files: [`${P}/settings.blocked_files.tsx`],
  secrets: [`${P}/settings.secrets.tsx`],
  switch_computer: [`${P}/settings.switch_computer.tsx`, 'components/AppBackendPanel.tsx', 'components/NetworkAccessCard.tsx', 'components/DirectSessionsCard.tsx'],
  remote: [`${P}/settings.remote.tsx`, 'components/account/DeviceRows.tsx'],
  about: [`${P}/settings.about.tsx`],
}

const pageText = (section: TopLevelSection) => PAGE_SOURCES[section].map((file) => readFileSync(join(SRC, file), 'utf8')).join('\n')

/** The page writes `text` out: as a string literal, or as JSX text between tags. */
function shows(source: string, text: string): boolean {
  const quoted = [`'${text}'`, `"${text}"`, `\`${text}\``].some((q) => source.includes(q))
  const jsxText = new RegExp(`>\\s*${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/'/g, "(?:'|&apos;)")}\\s*<`).test(source)
  return quoted || jsxText
}

describe('settings search anchors', () => {
  it('lists every section in the source map', () => {
    expect(Object.keys(PAGE_SOURCES).sort()).toEqual(SETTINGS_SECTIONS.map((s) => s.id).sort())
  })

  it('lands every result on text its page shows', () => {
    const dead: string[] = []
    for (const entry of SETTINGS_INDEX) {
      const anchor = entry.anchor ?? entry.label
      // The page title (its h1) is the section's label.
      const title = SETTINGS_SECTIONS.find((s) => s.id === entry.section)?.label
      if (anchor === title) continue
      if (!shows(pageText(entry.section), anchor)) dead.push(`${entry.section}: "${anchor}" (for "${entry.label}")`)
    }
    expect(dead).toEqual([])
  })
})
