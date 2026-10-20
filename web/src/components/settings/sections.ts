/**
 * Settings section registry.
 *
 * The single source for grouping, order, labels, icons and the one-line
 * descriptions shown in the phone section list. The content switch stays in
 * SettingsModal because each section takes genuinely different props.
 */
import {
  Brain,
  Heading,
  Image,
  Info,
  KeyRound,
  Plug,
  Puzzle,
  Server,
  Shield,
  Shrink,
  SlidersHorizontal,
  Sparkles,
  Waypoints,
  Wifi,
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
  | 'general'
  | 'connection'
  | 'network'
  | 'agents'
  | 'skills'
  | 'mcp'
  | 'memory'
  | 'plugins'
  | 'providers'
  | 'denied_paths'
  | 'workspaces'
  | 'titles'
  | 'context'
  | 'media'
  | 'about'
>

type SettingsGroupId = 'app' | 'build' | 'models' | 'privacy' | 'about'

interface SettingsGroupDef {
  id: SettingsGroupId
  label: string
}

/**
 * Nav grouping keeps related sections together, so provider credentials and
 * agent/tool settings remain distinct.
 */
export const SETTINGS_GROUPS: readonly SettingsGroupDef[] = [
  { id: 'app', label: 'App' },
  { id: 'build', label: 'Agents & tools' },
  { id: 'models', label: 'Models' },
  { id: 'privacy', label: 'Privacy & safety' },
  { id: 'about', label: 'About' },
]

export interface SettingsSectionDef {
  id: TopLevelSection
  /** Sidebar label. */
  label: string
  /** One line shown under the label in the phone section list. */
  description: string
  icon: LucideIcon
  group: SettingsGroupId
  /** Shown only when the backend advertises this capability (see `useServerCapability`). */
  capability?: string
  /** Shown only inside the desktop app (it controls the builtin backend). */
  desktopOnly?: boolean
}

export const SETTINGS_SECTIONS: readonly SettingsSectionDef[] = [
  // App
  { id: 'general', label: 'General', description: 'Theme and transcript style', icon: SlidersHorizontal, group: 'app' },
  { id: 'connection', label: 'Connection', description: 'Which backend this app uses', icon: Server, group: 'app' },
  { id: 'network', label: 'Network access', description: 'Let phones and other computers connect', icon: Wifi, group: 'app', desktopOnly: true },
  // Agents & tools
  { id: 'agents', label: 'Agents', description: 'Lead and member agent profiles', icon: Wrench, group: 'build' },
  { id: 'skills', label: 'Skills', description: 'Reusable instruction packs', icon: Sparkles, group: 'build' },
  { id: 'mcp', label: 'MCP servers', description: 'External tools over Model Context Protocol', icon: Plug, group: 'build' },
  { id: 'plugins', label: 'Plugins', description: 'Plugins the backend loaded', icon: Puzzle, group: 'build', capability: 'api.plugins' },
  { id: 'workspaces', label: 'Workspaces', description: 'Messages and groups across workspaces', icon: Waypoints, group: 'build' },
  // Models
  { id: 'providers', label: 'Providers', description: 'API keys and model accounts', icon: KeyRound, group: 'models' },
  { id: 'titles', label: 'Chat titles', description: 'Name sessions automatically', icon: Heading, group: 'models' },
  { id: 'context', label: 'Context', description: 'When long sessions are summarized', icon: Shrink, group: 'models' },
  { id: 'media', label: 'Media generation', description: 'Image and video models and defaults', icon: Image, group: 'models' },
  // Privacy & safety
  { id: 'memory', label: 'Memory', description: 'Shared Markdown knowledge base', icon: Brain, group: 'privacy' },
  { id: 'denied_paths', label: 'Denied Paths', description: 'Files and folders agents cannot touch', icon: Shield, group: 'privacy' },
  // About
  { id: 'about', label: 'About OpenAgentd', description: 'Version, updates and community', icon: Info, group: 'about' },
]

const BY_ID = new Map(SETTINGS_SECTIONS.map((s) => [s.id, s]))

/** Registry entry for a (possibly drilled-down) section. */
export function sectionDef(section: SettingsSection): SettingsSectionDef | undefined {
  return BY_ID.get(parentSection(section))
}

/** Which top-level section a (possibly drilled-down) section belongs to. */
export function parentSection(section: SettingsSection): TopLevelSection {
  return parentSectionId(section) as TopLevelSection
}

/**
 * Where the phone Back button goes: a drill-down (skill / MCP editor) returns
 * to its list, a top-level section returns to the section list.
 */
export function mobileBackTarget(section: SettingsSection): TopLevelSection | 'index' {
  const parent = parentSection(section)
  return section !== parent ? parent : 'index'
}
