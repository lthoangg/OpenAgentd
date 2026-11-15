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
  type SettingsSection,
} from '@/stores/useSettingsStore'

/** Sections that own a sidebar entry (drill-down editors are not listed). */
export type TopLevelSection = Extract<
  SettingsSection,
  | 'general'
  | 'models'
  | 'media'
  | 'desktop'
  | 'agents'
  | 'skills'
  | 'connectors'
  | 'plugins'
  | 'memory'
  | 'sessions'
  | 'workspaces'
  | 'blocked_files'
  | 'computers'
  | 'remote'
  | 'about'
>

type SettingsGroupId = 'basics' | 'agent' | 'work' | 'devices' | 'footer'

interface SettingsGroupDef {
  id: SettingsGroupId
  /** Shown above the group; the footer (About) has none. */
  label: string | null
}

/**
 * Grouped by what a page is about: what everyone sets once (Basics), what
 * shapes the agent (Agent), how sessions and workspaces behave (Work), and
 * which computers and phones reach each other (Devices). About sits apart at
 * the bottom.
 */
export const SETTINGS_GROUPS: readonly SettingsGroupDef[] = [
  { id: 'basics', label: 'Basics' },
  { id: 'agent', label: 'Agent' },
  { id: 'work', label: 'Work' },
  { id: 'devices', label: 'Devices' },
  { id: 'footer', label: null },
]

export interface SettingsSectionDef {
  id: TopLevelSection
  /** Sidebar label. */
  label: string
  /** One line shown under the label in the phone section list. */
  description: string
  /**
   * Words search also finds the section by and the page never shows: the
   * names it had before (Providers, MCP servers, Server…).
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
  { id: 'general', label: 'General', description: 'Theme, text size and how chats show', keywords: ['appearance', 'look'], icon: SlidersHorizontal, group: 'basics' },
  { id: 'models', label: 'Models', description: 'The accounts and API keys your models come from', keywords: ['providers', 'provider'], icon: KeyRound, group: 'basics' },
  { id: 'media', label: 'Image and video', description: 'Image and video models and defaults', keywords: ['media'], icon: Image, group: 'basics' },
  { id: 'desktop', label: 'Desktop', description: 'Agent status in the notch and the desktop pet', icon: Monitor, group: 'basics', desktopOnly: true },
  // Agent
  { id: 'agents', label: 'Agents', description: 'The main agent and its subagents', icon: Wrench, group: 'agent' },
  { id: 'skills', label: 'Skills', description: 'Reusable instruction packs', icon: Sparkles, group: 'agent' },
  { id: 'connectors', label: 'Connectors', description: 'Outside tools and services the agent can use', keywords: ['mcp servers', 'mcp', 'model context protocol'], icon: Plug, group: 'agent' },
  { id: 'plugins', label: 'Plugins', description: 'Skills, connectors and tools from plugins', icon: Puzzle, group: 'agent', capability: 'api.plugins' },
  { id: 'memory', label: 'Memory', description: 'Shared Markdown knowledge base', icon: Brain, group: 'agent' },
  // Work
  { id: 'sessions', label: 'Sessions', description: 'Names, summaries, goals and history', keywords: ['session titles', 'context', 'goals', 'retention'], icon: MessagesSquare, group: 'work' },
  { id: 'workspaces', label: 'Workspaces', description: 'Messages and groups across workspaces', icon: Waypoints, group: 'work' },
  { id: 'blocked_files', label: 'Blocked files', description: 'Files and folders agents cannot read or change', keywords: ['denied paths', 'denied', 'deny'], icon: Shield, group: 'work' },
  // Devices
  { id: 'computers', label: 'Computers', description: 'Which computer this app uses, and which devices can connect', keywords: ['server', 'connection', 'backend'], icon: Server, group: 'devices' },
  { id: 'remote', label: 'Remote control', description: 'Optional: use this computer from your phone anywhere', keywords: ['account', 'cloud', 'sign in'], icon: UserRound, group: 'devices', capability: 'api.cloud' },
  // Footer
  { id: 'about', label: 'About', description: 'Version, updates and community', keywords: ['about openagentd'], icon: Info, group: 'footer' },
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
