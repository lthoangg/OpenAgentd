/**
 * Reading and changing the agent's site rules (`BrowserSites`) for one site,
 * as the server applies them (`appv3/crates/agent/src/site_access.rs`): a
 * blocked site stays blocked whatever else matches, an entry `example.com`
 * also covers `www.example.com`, and `*.example.com` covers subdomains only.
 */
import type { BrowserSites } from '@/api/client'

/** What the agent may do on a site: use it, ask the user first, or nothing. */
export type SiteChoice = 'allow' | 'ask' | 'block'

/** The name a site goes by in the lists: its host without a leading `www.`. */
export function siteName(host: string): string {
  const lower = host.toLowerCase().replace(/\.$/, '')
  return lower.startsWith('www.') ? lower.slice(4) : lower
}

/** What a typed site is stored as, as far as that can be told here; the server decides. */
export function ruleName(raw: string): string {
  const text = raw.trim().toLowerCase()
  if (text.startsWith('*.')) return text
  try {
    return siteName(new URL(text.includes('://') ? text : `https://${text}`).hostname)
  } catch {
    return text
  }
}

function ruleMatches(rule: string, host: string): boolean {
  if (rule.startsWith('*.')) return host.endsWith(rule.slice(1)) && host.length > rule.length - 1
  return host === rule || host === `www.${rule}`
}

export function siteAccess(rules: BrowserSites, host: string): SiteChoice {
  const lower = host.toLowerCase().replace(/\.$/, '')
  if (rules.blocked.some((rule) => ruleMatches(rule, lower))) return 'block'
  if (rules.default === 'allow' || rules.allowed.some((rule) => ruleMatches(rule, lower))) return 'allow'
  return 'ask'
}

/** The rules with `host`'s site set to `choice`. Wildcard entries are left as they are. */
export function withSiteAccess(rules: BrowserSites, host: string, choice: SiteChoice): BrowserSites {
  const name = siteName(host)
  const without = (list: string[]) => list.filter((rule) => rule !== name)
  const allowed = without(rules.allowed)
  const blocked = without(rules.blocked)
  if (choice === 'allow') allowed.push(name)
  if (choice === 'block') blocked.push(name)
  return { default: rules.default, allowed, blocked }
}
