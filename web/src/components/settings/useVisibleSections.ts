import { useHealthQuery } from '@/queries/useHealthQuery'
import { isDesktopShell } from '@/lib/desktop-shell'
import { useDeniedPathsSettingsQuery, useMcpServersQuery, useSkillFilesQuery } from '@/queries'
import { SETTINGS_SECTIONS, type SettingsSectionDef, type TopLevelSection } from './sections'

/**
 * The section registry minus sections whose backend capability is missing
 * (v2), and desktop-only sections outside the desktop app.
 */
export function useVisibleSettingsSections(): readonly SettingsSectionDef[] {
  const capabilities = useHealthQuery().data?.capabilities
  const desktop = isDesktopShell()
  return SETTINGS_SECTIONS.filter((s) =>
    (!s.capability || (capabilities?.includes(s.capability) ?? false)) && (!s.desktopOnly || desktop),
  )
}

/** Item counts shown beside a section's nav entry; `null` while loading. */
export function useSettingsSectionCounts(): Partial<Record<TopLevelSection, number | null>> {
  const skillsQ = useSkillFilesQuery()
  const mcpQ = useMcpServersQuery()
  const deniedPathsQ = useDeniedPathsSettingsQuery()
  return {
    skills: skillsQ.data?.skills.length ?? null,
    mcp: mcpQ.data?.servers.length ?? null,
    denied_paths: deniedPathsQ.data?.denied_patterns.length ?? null,
  }
}
