/**
 * Settings section registry.
 *
 * The single source for grouping, order, labels, icons and the one-line
 * descriptions shown in the phone section list. The content switch stays in
 * SettingsModal because each section takes genuinely different props.
 */
import {
  Brain,
  Image,
  Info,
  KeyRound,
  MessagesSquare,
  Monitor,
  Plug,
  Puzzle,
  Server,
  Shield,
  SlidersHorizontal,
  Sparkles,
  UserRound,
  Waypoints,
  Wrench,
  type LucideIcon,
} from 'lucide-react'

import {
  parentSection as parentSectionId,
  resolveSection,
  type SettingsSection,
} from '@/stores/useSettingsStore'

/**
 * Sections that own a sidebar entry. Drill-downs are not listed, nor are the
 * ids of pages that became headings of Sessions (`resolveSection`).
 */
export type TopLevelSection = Extract<
  SettingsSection,
  | 'general'
  | 'desktop'
  | 'connection'
  | 'account'
  | 'agents'
  | 'skills'
  | 'mcp'
  | 'memory'
  | 'plugins'
  | 'providers'
  | 'denied_paths'
  | 'workspaces'
  | 'titles'
  | 'media'
  | 'about'
>

type SettingsGroupId = 'basics' | 'agent' | 'advanced'

interface SettingsGroupDef {
  id: SettingsGroupId
  label: string
}

/**
 * Grouped by who needs a page: what everyone sets once (Basics), what shapes
 * the agent (Agent), and what most people never open (Advanced).
 */
export const SETTINGS_GROUPS: readonly SettingsGroupDef[] = [
  { id: 'basics', label: 'Basics' },
  { id: 'agent', label: 'Agent' },
  { id: 'advanced', label: 'Advanced' },
]

export interface SettingsSectionDef {
  id: TopLevelSection
  /** Sidebar label. */
  label: string
  /** One line shown under the label in the phone section list. */
  description: string
  /**
   * Words search also finds the section by and the page never shows: the
   * names it had before (Providers, MCP servers, Denied paths…).
   */
  keywords?: readonly string[]
  icon: LucideIcon
  group: SettingsGroupId
  /** Shown only when the backend advertises this capability (see `useServerCapability`). */
  capability?: string
  /** Shown only inside the desktop app (it controls the builtin backend). */
  desktopOnly?: boolean
}

export const SETTINGS_SECTIONS: readonly SettingsSectionDef[] = [
  // Basics
  { id: 'general', label: 'Appearance', description: 'Theme, text size, detail and previews', icon: SlidersHorizontal, group: 'basics' },
  { id: 'providers', label: 'Models', description: 'The accounts and API keys your models come from', keywords: ['providers', 'provider'], icon: KeyRound, group: 'basics' },
  { id: 'account', label: 'Remote control', description: 'Optional: use this computer from your phone anywhere', icon: UserRound, group: 'basics', capability: 'api.cloud' },
  { id: 'desktop', label: 'Desktop', description: 'Agent status in the notch and the desktop pet', icon: Monitor, group: 'basics', desktopOnly: true },
  { id: 'about', label: 'About', description: 'Version, updates and community', keywords: ['about openagentd'], icon: Info, group: 'basics' },
  // Agent
  { id: 'agents', label: 'Agents', description: 'The main agent and its subagents', icon: Wrench, group: 'agent' },
  { id: 'skills', label: 'Skills', description: 'Reusable instruction packs', icon: Sparkles, group: 'agent' },
  { id: 'mcp', label: 'Connectors', description: 'Outside tools and services the agent can use', keywords: ['mcp servers', 'mcp', 'model context protocol'], icon: Plug, group: 'agent' },
  { id: 'plugins', label: 'Plugins', description: 'Skills, connectors and tools from plugins', icon: Puzzle, group: 'agent', capability: 'api.plugins' },
  { id: 'memory', label: 'Memory', description: 'Shared Markdown knowledge base', icon: Brain, group: 'agent' },
  // Advanced
  { id: 'titles', label: 'Sessions', description: 'Names, summaries, goals and history', keywords: ['session titles', 'context', 'goals', 'retention'], icon: MessagesSquare, group: 'advanced' },
  { id: 'workspaces', label: 'Workspaces', description: 'Messages and groups across workspaces', icon: Waypoints, group: 'advanced' },
  { id: 'denied_paths', label: 'Blocked files', description: 'Files and folders agents cannot read or change', keywords: ['denied paths', 'denied', 'deny'], icon: Shield, group: 'advanced' },
  { id: 'media', label: 'Image and video', description: 'Image and video models and defaults', icon: Image, group: 'advanced' },
  { id: 'connection', label: 'Server', description: 'Which computer this app uses, and access from other devices', icon: Server, group: 'advanced' },
]

const BY_ID = new Map(SETTINGS_SECTIONS.map((s) => [s.id, s]))

/** Registry entry for a (possibly drilled-down) section. */
export function sectionDef(section: SettingsSection): SettingsSectionDef | undefined {
  return BY_ID.get(parentSection(section))
}

/** Which top-level section a (possibly drilled-down or merged) section belongs to. */
export function parentSection(section: SettingsSection): TopLevelSection {
  return resolveSection(parentSectionId(section)).section as TopLevelSection
}

/**
 * Where the phone Back button goes: a drill-down (skill / MCP editor) returns
 * to its list, a top-level section returns to the section list.
 */
export function mobileBackTarget(section: SettingsSection): TopLevelSection | 'index' {
  const parent = parentSection(section)
  return section !== parent ? parent : 'index'
}
