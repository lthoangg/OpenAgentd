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
  { section: 'general', label: 'Detail', keywords: ['simple', 'full', 'reader', 'detailed', 'transcript', 'style', 'thinking', 'tool calls', 'chat layout'] },
  { section: 'general', label: 'Open previews', keywords: ['previews', 'review panel', 'web page', 'browser', 'auto open', 'automatically', 'manually', 'on click', 'when i choose'] },
  // Desktop
  { section: 'desktop', label: 'Agent status in the notch', keywords: ['notch', 'island', 'menu bar', 'macos', 'status'] },
  { section: 'desktop', label: 'Show while OpenAgentd is in front', keywords: ['notch', 'frontmost', 'island'] },
  { section: 'desktop', label: 'Keep finished sessions until opened', keywords: ['notch', 'done', 'failed', 'island'] },
  { section: 'desktop', label: 'Expand on hover', keywords: ['notch', 'island', 'hover'] },
  { section: 'desktop', label: 'Show a desktop pet', keywords: ['pet', 'cat', 'duck', 'crab', 'mascot'] },
  { section: 'desktop', label: 'Character', keywords: ['pet', 'cat', 'duck', 'crab'] },
  { section: 'desktop', label: 'Movement', keywords: ['pet', 'calm', 'playful', 'chaotic', 'still'] },
  { section: 'desktop', label: 'Show notifications in its bubble', keywords: ['pet', 'bubble', 'questions', 'finished'] },
  { section: 'desktop', label: 'Climb on windows', keywords: ['pet', 'jump', 'fall'] },
  // Server
  { section: 'connection', label: 'This computer', keywords: ['built-in server', 'builtin', 'local', 'sidecar', 'backend', 'runs inside this app'], anchor: 'Computers' },
  { section: 'connection', label: 'Add a computer by address', keywords: ['saved server', 'server url', 'add a server', 'remote', 'host', 'backend', 'switch', 'use', 'connect'] },
  { section: 'connection', label: 'Access key', keywords: ['token', 'password', 'auth', 'server'], anchor: 'Add a computer by address' },
  { section: 'connection', label: 'Access from other devices', keywords: ['network', 'lan', 'phone', 'qr', 'scan', 'share', 'remote access'] },
  // Account
  { section: 'account', label: 'Sign in', keywords: ['account', 'cloud', 'login', 'phone', 'remote', 'anywhere', 'optional', 'guest', 'connect your phone', 'pair', 'qr', 'scan'], anchor: 'Account' },
  { section: 'account', label: 'Sign out', keywords: ['account', 'cloud', 'logout', 'remove this device'], anchor: 'Account' },
  // Agents, skills, connectors, plugins, memory
  { section: 'agents', label: 'Agent model', keywords: ['model', 'thinking', 'reasoning', 'effort', 'subagent', 'system prompt', 'tools'], anchor: 'Agents' },
  { section: 'skills', label: 'Skill instructions', keywords: ['skill.md', 'instruction pack', 'new skill', 'create skill'], anchor: 'Skills' },
  { section: 'mcp', label: 'Connector tools', keywords: ['mcp server', 'model context protocol', 'stdio', 'http', 'oauth', 'restart', 'new server', 'new connector', 'tool'], anchor: 'Connectors' },
  { section: 'plugins', label: 'Plugin folders', keywords: ['folder', 'bundle', 'skills', 'mcp servers', 'connectors', 'tools', 'permissions', 'enable', 'disable', 'reload', 'install', 'add plugin', 'agentd plugin add'], anchor: 'Plugin folders' },
  { section: 'plugins', label: 'Single-file plugins', keywords: ['hooks', 'extensions', 'python', 'typescript', 'javascript', 'provider'] },
  { section: 'memory', label: 'Memory pages', keywords: ['wiki', 'knowledge base', 'markdown', 'notes', 'remember'], anchor: 'Memory' },
  // Sessions: titles, summaries, goals, history
  { section: 'titles', label: 'Name sessions automatically', keywords: ['session name', 'rename', 'title', 'generate titles'] },
  { section: 'titles', label: 'Rename after a summary', keywords: ['session name', 'summary', 'update title after summarizing'] },
  { section: 'titles', label: 'Summarize when a session reaches', keywords: ['token threshold', 'summarize', 'summarization', 'compact', 'context window', 'long sessions'] },
  { section: 'titles', label: 'Summarize idle sessions', keywords: ['idle', 'summary', 'cache', 'idle trigger', 'percent'] },
  { section: 'titles', label: 'Keep going after approval', keywords: ['goal', 'plan', 'approve', 'continue', 'autonomous', 'by default'] },
  { section: 'titles', label: 'Turns per goal', keywords: ['goal', 'limit', 'max turns'] },
  { section: 'titles', label: 'Token budget per goal', keywords: ['goal', 'limit', 'cost', 'tokens'] },
  { section: 'titles', label: 'Allow questions during goals', keywords: ['goal', 'ask', 'questions', 'interrupt'] },
  { section: 'titles', label: 'Keep usage history forever', keywords: ['retention', 'delete', 'traces', 'privacy', 'keep forever'] },
  { section: 'titles', label: 'Keep usage history for', keywords: ['retention', 'days', 'delete', 'privacy', 'traces', 'keep traces for'], anchor: 'History' },
  // Workspaces, blocked files, media
  { section: 'workspaces', label: 'Let agents message other workspaces', keywords: ['cross workspace', 'send message', 'agents talk'] },
  { section: 'workspaces', label: 'Groups', keywords: ['workspace group', 'notes for agents', 'repos', 'color'] },
  { section: 'denied_paths', label: 'Blocked patterns', keywords: ['block', 'deny', 'denied patterns', 'gitignore', 'glob', 'files', 'folders', 'forbidden'], anchor: 'Blocked files' },
  { section: 'media', label: 'Image generation', keywords: ['image model', 'aspect ratio', 'size', 'output format', 'quality', 'picture'] },
  { section: 'media', label: 'Video generation', keywords: ['video model', 'resolution', 'duration', 'aspect ratio'] },
  // Models
  { section: 'providers', label: 'API keys', keywords: ['key', 'anthropic', 'openai', 'gemini', 'openrouter', 'save key', 'test key', 'credentials', 'provider'], anchor: 'Models' },
  { section: 'providers', label: 'Accounts and fallback order', keywords: ['tried in this order', 'use first', 'move down', 'standby', 'rate limit', 'quota', 'pinned', 'sign in', 'account', 'rotate'], anchor: 'Models' },
  { section: 'providers', label: 'Hide from pickers', keywords: ['hide a provider', 'hide', 'show', 'models list', 'visible models', 'picker'], anchor: 'Models' },
  { section: 'providers', label: 'Sign out of a subscription', keywords: ['provider', 'oauth', 'chatgpt', 'copilot', 'codex', 'subscription', 'logout', 'reconnect'], anchor: 'Models' },
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

  // A section named by the query leads; one found by its description or by a
  // name it used to have ("providers", "mcp servers") follows.
  const sectionRank = (s: SettingsSectionDef) => {
    const has = (text: string) => terms.every((t) => text.toLowerCase().includes(t))
    if (has(s.label)) return 0
    if (has(`${s.label} ${s.description}`)) return 1
    // An earlier name typed whole ("context") beats one that merely contains
    // the word ("model context protocol").
    if ((s.keywords ?? []).includes(q)) return 2
    return has(`${s.label} ${s.description} ${(s.keywords ?? []).join(' ')}`) ? 3 : -1
  }
  const sectionHits: SettingsHit[] = sections
    .map((s) => ({ s, rank: sectionRank(s) }))
    .filter(({ rank }) => rank >= 0)
    .sort((a, b) => a.rank - b.rank)
    .map(({ s }) => ({ kind: 'section', section: s.id, label: s.label, sectionLabel: s.label, description: s.description }))

  const scored: Array<{ hit: SettingsHit; rank: number }> = []
  for (const entry of SETTINGS_INDEX) {
    const section = byId.get(entry.section)
    if (!section) continue
    const label = entry.label.toLowerCase()
    const text = `${label} ${entry.keywords.join(' ')} ${section.label} ${(section.keywords ?? []).join(' ')}`.toLowerCase()
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
