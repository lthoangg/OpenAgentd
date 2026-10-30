/**
 * Settings section registry.
 *
 * The single source for grouping, order, labels, icons and the one-line
 * descriptions shown in the phone section list. The content switch stays in
 * SettingsModal because each section takes genuinely different props.
 */
import {
  Activity,
  Brain,
  Heading,
  Image,
  Info,
  KeyRound,
  Monitor,
  Plug,
  Puzzle,
  Server,
  Shield,
  Shrink,
  SlidersHorizontal,
  Sparkles,
  Target,
  Waypoints,
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
  | 'desktop'
  | 'connection'
  | 'agents'
  | 'skills'
  | 'mcp'
  | 'memory'
  | 'plugins'
  | 'providers'
  | 'denied_paths'
  | 'telemetry'
  | 'workspaces'
  | 'goals'
  | 'titles'
  | 'context'
  | 'media'
  | 'about'
>

type SettingsGroupId = 'app' | 'build' | 'sessions' | 'models' | 'privacy' | 'about'

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
  { id: 'build', label: 'Agents and tools' },
  { id: 'sessions', label: 'Sessions' },
  { id: 'models', label: 'Models and media' },
  { id: 'privacy', label: 'Data and safety' },
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
  { id: 'desktop', label: 'Desktop', description: 'Agent status in the notch and the desktop pet', icon: Monitor, group: 'app', desktopOnly: true },
  { id: 'connection', label: 'Connection', description: 'Which server this app uses, and access from other devices', icon: Server, group: 'app' },
  // Agents and tools
  { id: 'agents', label: 'Agents', description: 'The main agent and its subagents', icon: Wrench, group: 'build' },
  { id: 'skills', label: 'Skills', description: 'Reusable instruction packs', icon: Sparkles, group: 'build' },
  { id: 'mcp', label: 'MCP servers', description: 'External tools over Model Context Protocol', icon: Plug, group: 'build' },
  { id: 'plugins', label: 'Plugins', description: 'Plugins the server loaded', icon: Puzzle, group: 'build', capability: 'api.plugins' },
  { id: 'goals', label: 'Goals', description: 'Keep working on an approved plan until it is done', icon: Target, group: 'build' },
  // Sessions
  { id: 'titles', label: 'Session titles', description: 'Name sessions automatically', icon: Heading, group: 'sessions' },
  { id: 'context', label: 'Context', description: 'When long sessions are summarized', icon: Shrink, group: 'sessions' },
  { id: 'workspaces', label: 'Workspaces', description: 'Messages and groups across workspaces', icon: Waypoints, group: 'sessions' },
  // Models and media
  { id: 'providers', label: 'Providers', description: 'API keys and model accounts', icon: KeyRound, group: 'models' },
  { id: 'media', label: 'Image and video', description: 'Image and video models and defaults', icon: Image, group: 'models' },
  // Data and safety
  { id: 'memory', label: 'Memory', description: 'Shared Markdown knowledge base', icon: Brain, group: 'privacy' },
  { id: 'denied_paths', label: 'Denied paths', description: 'Files and folders agents cannot touch', icon: Shield, group: 'privacy' },
  { id: 'telemetry', label: 'Data retention', description: 'How long local traces and metrics are kept', icon: Activity, group: 'privacy' },
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
