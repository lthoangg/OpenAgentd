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
 * page text of its own (a button in a list) sets `anchor`: a heading or
 * label the page always shows. `settings-index.anchors.test.ts` checks that
 * every one of them is text in its section's page.
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
  // General
  { section: 'general', label: 'Theme', keywords: ['dark', 'light', 'system', 'color', 'colour', 'mode', 'appearance'] },
  { section: 'general', label: 'Text size', keywords: ['font', 'compact', 'default', 'large', 'bigger', 'smaller', 'zoom', 'type', 'appearance'] },
  { section: 'general', label: 'Detail', keywords: ['simple', 'full', 'reader', 'detailed', 'transcript', 'style', 'thinking', 'tool calls', 'chat layout', 'chat'] },
  { section: 'general', label: 'Open previews', keywords: ['previews', 'review panel', 'web page', 'browser', 'auto open', 'automatically', 'manually', 'on click', 'when i choose', 'chat'] },
  // Desktop
  { section: 'desktop', label: 'Open at login', keywords: ['startup', 'autostart', 'launch', 'boot', 'background', 'sign in', 'login items'] },
  { section: 'desktop', label: 'Agent status in the notch', keywords: ['notch', 'island', 'menu bar', 'macos', 'status'] },
  { section: 'desktop', label: 'Show while OpenAgentd is in front', keywords: ['notch', 'frontmost', 'island'] },
  { section: 'desktop', label: 'Keep finished sessions until opened', keywords: ['notch', 'done', 'failed', 'island'] },
  { section: 'desktop', label: 'Expand on hover', keywords: ['notch', 'island', 'hover'] },
  { section: 'desktop', label: 'Show a desktop pet', keywords: ['pet', 'cat', 'duck', 'crab', 'mascot'] },
  { section: 'desktop', label: 'Character', keywords: ['pet', 'cat', 'duck', 'crab'] },
  { section: 'desktop', label: 'Movement', keywords: ['pet', 'calm', 'playful', 'chaotic', 'still'] },
  { section: 'desktop', label: 'Show notifications in its bubble', keywords: ['pet', 'bubble', 'questions', 'finished'] },
  { section: 'desktop', label: 'Climb on windows', keywords: ['pet', 'jump', 'fall'] },
  // Switch computer
  { section: 'switch_computer', label: 'This computer', keywords: ['built-in server', 'builtin', 'local', 'sidecar', 'backend', 'runs inside this app'], anchor: 'Computers' },
  { section: 'switch_computer', label: 'Add a computer by address', keywords: ['saved server', 'server url', 'add a server', 'remote', 'host', 'backend', 'switch', 'use', 'connect'] },
  { section: 'switch_computer', label: 'Access key of a computer you add', keywords: ['token', 'password', 'auth', 'server'], anchor: 'Add a computer by address' },
  { section: 'switch_computer', label: 'Let other devices connect', keywords: ['network', 'lan', 'phone', 'qr', 'scan', 'share', 'remote access', 'access from other devices', 'network access', 'port'] },
  { section: 'switch_computer', label: "This computer's access key", keywords: ['network key', 'regenerate', 'token', 'password', 'lan'], anchor: 'Let other devices connect' },
  { section: 'switch_computer', label: "Let your account's devices connect directly", keywords: ['direct', 'home network', 'account devices', 'relay'], anchor: 'Let other devices connect' },
  // Remote control
  { section: 'remote', label: 'Sign in', keywords: ['account', 'cloud', 'login', 'phone', 'remote', 'anywhere', 'optional', 'guest', 'connect your phone', 'pair', 'qr', 'scan'] },
  { section: 'remote', label: 'Devices', keywords: ['account', 'cloud', 'sign out', 'logout', 'add a device', 'remove this device', 'can add devices'] },
  // Agents, skills, connectors, plugins, memory
  { section: 'agents', label: 'Agent model', keywords: ['model', 'thinking', 'reasoning', 'effort', 'subagent', 'main agent', 'system prompt', 'tools'], anchor: 'Agents' },
  { section: 'skills', label: 'Skill instructions', keywords: ['skill.md', 'instruction pack', 'new skill', 'create skill'], anchor: 'Skills' },
  { section: 'connectors', label: 'Connector tools', keywords: ['mcp server', 'model context protocol', 'stdio', 'http', 'oauth', 'restart', 'new server', 'new connector', 'tool'], anchor: 'Connectors' },
  { section: 'plugins', label: 'Plugin folders', keywords: ['folder', 'bundle', 'skills', 'mcp servers', 'connectors', 'tools', 'permissions', 'enable', 'disable', 'reload', 'install', 'add plugin', 'agentd plugin add'] },
  { section: 'plugins', label: 'Single-file plugins', keywords: ['hooks', 'extensions', 'python', 'typescript', 'javascript', 'provider'] },
  { section: 'memory', label: 'Memory pages', keywords: ['wiki', 'knowledge base', 'markdown', 'notes', 'remember'], anchor: 'Memory' },
  // Sessions: titles, summaries, goals, history
  { section: 'sessions', label: 'Name sessions automatically', keywords: ['session name', 'rename', 'title', 'generate titles'] },
  { section: 'sessions', label: 'Rename after a summary', keywords: ['session name', 'summary', 'update title after summarizing'] },
  { section: 'sessions', label: 'Summarize when a session reaches', keywords: ['token threshold', 'summarize', 'summarization', 'compact', 'context window', 'long sessions'] },
  { section: 'sessions', label: 'Summarize idle sessions', keywords: ['idle', 'summary', 'cache', 'idle trigger', 'percent'] },
  { section: 'sessions', label: 'Keep going after approval', keywords: ['goal', 'plan', 'approve', 'continue', 'autonomous', 'by default'] },
  { section: 'sessions', label: 'Turns per goal', keywords: ['goal', 'limit', 'max turns'] },
  { section: 'sessions', label: 'Allow questions during goals', keywords: ['goal', 'ask', 'questions', 'interrupt'] },
  { section: 'sessions', label: 'Keep usage history forever', keywords: ['retention', 'delete', 'traces', 'privacy', 'keep forever'] },
  { section: 'sessions', label: 'Keep usage history for', keywords: ['retention', 'days', 'delete', 'privacy', 'traces', 'keep traces for'], anchor: 'History' },
  // Workspaces, blocked files, media
  { section: 'workspaces', label: 'Let agents message other workspaces', keywords: ['cross workspace', 'send message', 'agents talk'] },
  { section: 'workspaces', label: 'Groups', keywords: ['workspace group', 'notes for agents', 'repos', 'color'] },
  { section: 'blocked_files', label: 'Blocked patterns', keywords: ['block', 'deny', 'denied patterns', 'gitignore', 'glob', 'files', 'folders', 'forbidden'], anchor: 'Blocked files' },
  { section: 'browser', label: 'Sites the agent may use', keywords: ['allow all sites', 'ask', 'approve', 'permission', 'websites', 'agent access'] },
  { section: 'browser', label: 'Allowed sites', keywords: ['allow', 'allowlist', 'trusted', 'domains', 'websites'] },
  { section: 'browser', label: 'Blocked sites', keywords: ['block', 'blocklist', 'deny', 'domains', 'websites'] },
  { section: 'browser', label: 'Clear browsing data', keywords: ['cookies', 'sign out', 'cache', 'history', 'profile', 'logout'] },
  { section: 'secrets', label: 'Secrets', keywords: ['api key', 'token', 'env', '.env', 'replace key', 'delete key'], anchor: 'Secrets' },
  { section: 'media', label: 'Image generation', keywords: ['image model', 'aspect ratio', 'size', 'output format', 'quality', 'picture'] },
  { section: 'media', label: 'Video generation', keywords: ['video model', 'resolution', 'duration', 'aspect ratio'] },
  // Models
  { section: 'models', label: 'API keys', keywords: ['key', 'anthropic', 'openai', 'gemini', 'openrouter', 'save key', 'test key', 'credentials', 'provider'], anchor: 'Models' },
  { section: 'models', label: 'Accounts and fallback order', keywords: ['tried in this order', 'use first', 'move down', 'standby', 'rate limit', 'quota', 'pinned', 'sign in', 'account', 'rotate'], anchor: 'Models' },
  { section: 'models', label: 'Hide from pickers', keywords: ['hide a provider', 'hide', 'show', 'models list', 'visible models', 'picker'], anchor: 'Models' },
  { section: 'models', label: 'Sign out of a subscription', keywords: ['provider', 'oauth', 'chatgpt', 'copilot', 'codex', 'subscription', 'logout', 'reconnect'], anchor: 'Models' },
  // About
  { section: 'about', label: 'Check for updates', keywords: ['version', 'update', 'download', 'restart', 'upgrade', 'release'], anchor: 'Version' },
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
  for (const el of root.querySelectorAll<HTMLElement>('h1, h2, h3, h4, label, p, span, div, legend, button')) {
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
  // A button named by the setting is its own control.
  if (label.matches(FOCUSABLE)) {
    label.focus({ preventScroll: true })
    return true
  }
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
