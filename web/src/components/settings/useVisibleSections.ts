import { useHealthQuery } from '@/queries/useHealthQuery'
import { isDesktopShell } from '@/lib/desktop-shell'
import { hasDesktopSettings } from './pages/settings.desktop'
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
    (!s.capability || (capabilities?.includes(s.capability) ?? false))
    && (!s.desktopOnly || desktop)
    // Desktop lists the notch and the pet; a shell with neither has no page.
    && (s.id !== 'desktop' || hasDesktopSettings()),
  )
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

/**
 * What sits beside a section's nav entry, in words ("4 skills",
 * "1 needs sign-in"), so a bare number never has to be guessed; `null`
 * while loading or when there is nothing worth saying.
 */
export function useSettingsSectionCounts(): Partial<Record<TopLevelSection, string | null>> {
  const skillsQ = useSkillFilesQuery()
  const mcpQ = useMcpServersQuery()
  const deniedPathsQ = useDeniedPathsSettingsQuery()
  const servers = mcpQ.data?.servers
  const signIn = servers?.filter((s) => s.enabled && s.state === 'auth_required').length ?? 0
  const skills = skillsQ.data?.skills.length
  const rules = deniedPathsQ.data?.denied_patterns.length
  return {
    skills: skills === undefined ? null : plural(skills, 'skill', 'skills'),
    mcp: servers === undefined ? null : signIn > 0 ? `${signIn} needs sign-in` : plural(servers.length, 'server', 'servers'),
    denied_paths: rules === undefined ? null : plural(rules, 'rule', 'rules'),
  }
}
