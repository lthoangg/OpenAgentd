/**
 * Settings section registry.
 *
 * Section metadata used to live in four places that had to be kept in sync by
 * hand: the desktop sidebar array, the mobile tab bar array, the content
 * switch, and the label map. On top of that, the set of "leaf"
 * sections was spelled out verbatim in three separate boolean predicates
 * (`MobileTabBar`'s active fallback, `isDrillDown`, `mobileBackSection`).
 * Adding one section meant editing seven places, so they drifted.
 *
 * This module is the single source. The content switch stays in SettingsModal
 * because each section takes genuinely different props; everything else
 * (grouping, order, labels, icons, mobile nav) derives
 * from here.
 */
import {
  Info,
  KeyRound,
  Plug,
  Shield,
  Sparkles,
  Wrench,
  type LucideIcon,
} from 'lucide-react'

import {
  parentSection as parentSectionId,
  type SettingsSection,
} from '@/stores/useSettingsStore'

/** Sections that own a sidebar entry. Drill-downs are not listed. */
export type TopLevelSection = Extract<
  SettingsSection,
  | 'agents'
  | 'skills'
  | 'mcp'
  | 'providers'
  | 'denied_paths'
  | 'sandbox'
  | 'automation'
  | 'about'
>

type SettingsGroupId = 'build' | 'models' | 'about'

interface SettingsGroupDef {
  id: SettingsGroupId
  label: string
}

/**
 * Nav grouping keeps related sections together, so provider credentials and
 * agent/tool settings remain distinct.
 */
export const SETTINGS_GROUPS: readonly SettingsGroupDef[] = [
  { id: 'build', label: 'Agents & tools' },
  { id: 'models', label: 'Models' },
  { id: 'about', label: 'About' },
]

export interface SettingsSectionDef {
  id: TopLevelSection
  /** Sidebar label. */
  label: string
  icon: LucideIcon
  group: SettingsGroupId
  /** Included in the five-slot mobile tab bar. */
  mobileTab?: boolean
}

export const SETTINGS_SECTIONS: readonly SettingsSectionDef[] = [
  {
    id: 'agents',
    label: 'Agents',
    icon: Wrench,
    group: 'build',
    mobileTab: true,
  },
  {
    id: 'skills',
    label: 'Skills',
    icon: Sparkles,
    group: 'build',
    mobileTab: true,
  },
  {
    id: 'mcp',
    label: 'MCP servers',
    icon: Plug,
    group: 'build',
    mobileTab: true,
  },
  {
    id: 'providers',
    label: 'Providers',
    icon: KeyRound,
    group: 'models',
    mobileTab: true,
  },
  {
    id: 'automation',
    label: 'Automation',
    icon: Sparkles,
    group: 'models',
  },
  {
    id: 'denied_paths',
    label: 'Denied Paths',
    icon: Shield,
    group: 'build',
  },
  {
    id: 'about',
    label: 'About openagentd',
    icon: Info,
    group: 'about',
    mobileTab: true,
  },
]

const BY_ID = new Map(SETTINGS_SECTIONS.map((s) => [s.id, s]))

/** Which top-level section a (possibly drilled-down) section belongs to. */
export function parentSection(section: SettingsSection): TopLevelSection {
  return parentSectionId(section) as TopLevelSection
}

/**
 * True for sections without a mobile tab of their own, which therefore need a
 * back button and route back to About on mobile. Derived from `mobileTab`
 * rather than a hardcoded id list.
 */
function isMobileLeaf(section: SettingsSection): boolean {
  const def = BY_ID.get(parentSection(section))
  return !!def && !def.mobileTab
}

/** The section a mobile back button should return to. */
export function mobileBackSection(section: SettingsSection): TopLevelSection {
  return isMobileLeaf(section) ? 'about' : parentSection(section)
}

/** True when the current view is nested below its top-level section. */
export function isDrillDown(section: SettingsSection): boolean {
  return section !== parentSection(section) || isMobileLeaf(section)
}
