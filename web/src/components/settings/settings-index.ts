/**
 * Settings search index.
 *
 * A hand-written list of the individual settings people look for, each with
 * the section that holds it and a few words they might type instead of its
 * name. Section names and descriptions are searched too (they come from the
 * registry in `sections.ts`), so a query finds a whole section or one
 * setting inside it.
 *
 * `label` is the text the page shows for the setting, so opening a result can
 * scroll to it and focus its control (`revealSetting`). A setting with no
 * page text of its own (a button in a list) sets `anchor`, or leaves the
 * result to open its section only.
 */
import type { SettingsSectionDef, TopLevelSection } from '@/components/settings/sections'

export interface SettingEntry {
  section: TopLevelSection
  /** The setting's name as its page shows it. */
  label: string
  /** Other words for it: synonyms, values, the thing it affects. */
  keywords: readonly string[]
  /** Text to scroll to when it differs from `label`. */
  anchor?: string
}

export const SETTINGS_INDEX: readonly SettingEntry[] = [
  // Appearance
  { section: 'general', label: 'Theme', keywords: ['dark', 'light', 'system', 'color', 'colour', 'mode', 'appearance'] },
  { section: 'general', label: 'Text size', keywords: ['font', 'compact', 'default', 'large', 'bigger', 'smaller', 'zoom', 'type'] },
  { section: 'general', label: 'Transcript', keywords: ['reader', 'detailed', 'style', 'thinking', 'tool calls', 'chat layout'] },
  { section: 'general', label: 'Previews', keywords: ['preview', 'open', 'review panel', 'web page', 'browser', 'auto open', 'on click'] },
  // Desktop
  { section: 'desktop', label: 'Agent status in the notch', keywords: ['notch', 'island', 'menu bar', 'macos', 'status'] },
  { section: 'desktop', label: 'Show while OpenAgentd is in front', keywords: ['notch', 'frontmost', 'island'] },
  { section: 'desktop', label: 'Keep finished sessions until opened', keywords: ['notch', 'done', 'failed', 'island'] },
  { section: 'desktop', label: 'Expand on hover', keywords: ['notch', 'island', 'hover'] },
  { section: 'desktop', label: 'Show a desktop pet', keywords: ['pet', 'cat', 'duck', 'crab', 'mascot'] },
  { section: 'desktop', label: 'Character', keywords: ['pet', 'cat', 'duck', 'crab'] },
  { section: 'desktop', label: 'Movement', keywords: ['pet', 'calm', 'playful', 'chaotic', 'still'] },
  { section: 'desktop', label: 'Show notifications in its bubble', keywords: ['pet', 'bubble', 'questions', 'reminders'] },
  { section: 'desktop', label: 'Climb on windows', keywords: ['pet', 'jump', 'fall'] },
  // Server
  { section: 'connection', label: 'Built-in server', keywords: ['builtin', 'local', 'sidecar', 'backend', 'runs inside this app'], anchor: 'Servers' },
  { section: 'connection', label: 'Saved server', keywords: ['remote', 'backend', 'switch', 'use', 'connect'], anchor: 'Servers' },
  { section: 'connection', label: 'Server URL', keywords: ['address', 'host', 'backend', 'add a server', 'connect'] },
  { section: 'connection', label: 'Access key', keywords: ['token', 'password', 'auth', 'server'] },
  { section: 'connection', label: 'Access from other devices', keywords: ['network', 'lan', 'phone', 'qr', 'scan', 'share', 'remote access'] },
  // Agents, skills, MCP, plugins, goals
  { section: 'agents', label: 'Agent model', keywords: ['model', 'thinking', 'reasoning', 'effort', 'subagent', 'system prompt', 'tools'], anchor: 'Agents' },
  { section: 'skills', label: 'Skill instructions', keywords: ['skill.md', 'instruction pack', 'new skill', 'create skill'], anchor: 'Skills' },
  { section: 'mcp', label: 'MCP server tools', keywords: ['model context protocol', 'stdio', 'http', 'oauth', 'restart', 'new server', 'tool'], anchor: 'MCP servers' },
  { section: 'plugins', label: 'Plugin folders', keywords: ['folder', 'bundle', 'skills', 'mcp servers', 'tools', 'permissions', 'enable', 'disable', 'reload', 'install', 'add plugin', 'agentd plugin add'], anchor: 'Plugin folders' },
  { section: 'plugins', label: 'Single-file plugins', keywords: ['hooks', 'extensions', 'python', 'typescript', 'javascript', 'provider'] },
  { section: 'goals', label: 'Keep going after approval by default', keywords: ['goal', 'plan', 'approve', 'continue', 'autonomous'] },
  { section: 'goals', label: 'Turns per goal', keywords: ['goal', 'limit', 'max turns'] },
  { section: 'goals', label: 'Token budget per goal', keywords: ['goal', 'limit', 'cost', 'tokens'] },
  { section: 'goals', label: 'Allow questions during goals', keywords: ['goal', 'ask', 'questions', 'interrupt'] },
  // Sessions
  { section: 'titles', label: 'Generate titles automatically', keywords: ['session name', 'rename', 'title'] },
  { section: 'titles', label: 'Wait for title (seconds)', keywords: ['session name', 'delay', 'timeout'] },
  { section: 'titles', label: 'Update title after summarizing', keywords: ['session name', 'summary'] },
  { section: 'context', label: 'Token threshold', keywords: ['summarize', 'summarization', 'compact', 'context window', 'long sessions'] },
  { section: 'context', label: 'Summarize idle sessions', keywords: ['idle', 'summary', 'cache'] },
  { section: 'context', label: 'Idle trigger', keywords: ['idle', 'percent', 'summary'] },
  { section: 'workspaces', label: 'Let agents message other workspaces', keywords: ['cross workspace', 'send message', 'agents talk'] },
  { section: 'workspaces', label: 'Groups', keywords: ['workspace group', 'notes for agents', 'repos', 'color'] },
  // Models and media
  { section: 'providers', label: 'API keys', keywords: ['key', 'anthropic', 'openai', 'gemini', 'openrouter', 'save key', 'test key', 'credentials'], anchor: 'Providers' },
  { section: 'providers', label: 'Accounts and fallback order', keywords: ['tried in this order', 'use first', 'move down', 'standby', 'rate limit', 'quota', 'pinned', 'sign in', 'account', 'rotate'], anchor: 'Providers' },
  { section: 'providers', label: 'Hide a provider from pickers', keywords: ['hide', 'show', 'models list', 'visible models', 'picker'], anchor: 'Providers' },
  { section: 'providers', label: 'Sign out of a provider', keywords: ['oauth', 'chatgpt', 'copilot', 'codex', 'subscription', 'logout', 'reconnect'], anchor: 'Providers' },
  { section: 'media', label: 'Image generation', keywords: ['image model', 'aspect ratio', 'size', 'output format', 'quality', 'picture'] },
  { section: 'media', label: 'Video generation', keywords: ['video model', 'resolution', 'duration', 'aspect ratio'] },
  // Data and safety
  { section: 'memory', label: 'Memory pages', keywords: ['wiki', 'knowledge base', 'markdown', 'notes', 'remember'], anchor: 'Memory' },
  { section: 'denied_paths', label: 'Denied patterns', keywords: ['block', 'deny', 'gitignore', 'glob', 'files', 'folders', 'forbidden'] },
  { section: 'telemetry', label: 'Keep forever', keywords: ['retention', 'delete', 'traces', 'metrics', 'privacy'] },
  { section: 'telemetry', label: 'Keep traces and metrics for', keywords: ['retention', 'days', 'delete', 'privacy'] },
  // About
  { section: 'about', label: 'Check for updates', keywords: ['version', 'update', 'download', 'restart', 'upgrade', 'release'], anchor: 'Updates' },
  { section: 'about', label: 'Community and support', keywords: ['discord', 'facebook', 'website', 'help', 'feedback'] },
]

export type SettingsHit =
  | { kind: 'section'; section: TopLevelSection; label: string; sectionLabel: string; description: string }
  | { kind: 'setting'; section: TopLevelSection; label: string; sectionLabel: string; anchor: string }

const words = (query: string) => query.trim().toLowerCase().split(/\s+/).filter(Boolean)

/**
 * Sections and settings that match `query`. Every word of the query must
 * appear somewhere in the entry (its name, its other words, or its section's
 * name), in any order. Sections come first, then settings whose name starts
 * with the query, then the rest.
 */
export function searchSettings(query: string, sections: readonly SettingsSectionDef[]): SettingsHit[] {
  const terms = words(query)
  if (terms.length === 0) return []
  const q = terms.join(' ')
  const byId = new Map(sections.map((s) => [s.id, s]))

  const sectionHits: SettingsHit[] = sections
    .filter((s) => {
      const text = `${s.label} ${s.description}`.toLowerCase()
      return terms.every((t) => text.includes(t))
    })
    .map((s) => ({ kind: 'section', section: s.id, label: s.label, sectionLabel: s.label, description: s.description }))

  const scored: Array<{ hit: SettingsHit; rank: number }> = []
  for (const entry of SETTINGS_INDEX) {
    const section = byId.get(entry.section)
    if (!section) continue
    const label = entry.label.toLowerCase()
    const text = `${label} ${entry.keywords.join(' ')} ${section.label}`.toLowerCase()
    if (!terms.every((t) => text.includes(t))) continue
    scored.push({
      rank: label.startsWith(q) ? 0 : label.includes(q) ? 1 : 2,
      hit: { kind: 'setting', section: entry.section, label: entry.label, sectionLabel: section.label, anchor: entry.anchor ?? entry.label },
    })
  }
  scored.sort((a, b) => a.rank - b.rank)
  return [...sectionHits, ...scored.map((s) => s.hit)]
}

const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [role="switch"], [role="radio"], [role="combobox"]'

/** The element whose own text is `text` (case-insensitive), deepest first. */
function findByText(root: ParentNode, text: string): HTMLElement | null {
  const target = text.trim().toLowerCase()
  let found: HTMLElement | null = null
  for (const el of root.querySelectorAll<HTMLElement>('h1, h2, h3, h4, label, p, span, div, legend')) {
    if (el.textContent?.trim().toLowerCase() !== target) continue
    // A wrapper repeating its only child's text is not the match.
    if (found && el.contains(found)) continue
    found = el
    break
  }
  return found
}

/**
 * Scrolls to the setting named `text` inside `root` and focuses its control.
 * Returns false when the page has not rendered it (yet).
 */
export function revealSetting(root: ParentNode | null, text: string): boolean {
  if (!root) return false
  const label = findByText(root, text)
  if (!label) return false
  label.scrollIntoView?.({ block: 'center' })
  let scope: HTMLElement | null = label
  for (let depth = 0; scope && depth < 4; depth += 1, scope = scope.parentElement) {
    const control = scope.querySelector<HTMLElement>(FOCUSABLE)
    if (control) {
      control.focus({ preventScroll: true })
      return true
    }
  }
  return true
}
