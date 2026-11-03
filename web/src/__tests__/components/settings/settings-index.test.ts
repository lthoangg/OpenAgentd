/**
 * The settings search index: single settings are findable by their name or a
 * word people use for them, and a result can be scrolled to.
 */
import { afterEach, describe, expect, it, mock } from 'bun:test'

import { SETTINGS_SECTIONS } from '@/components/settings/sections'
import { revealSetting, searchSettings, SETTINGS_INDEX } from '@/components/settings/settings-index'

afterEach(() => {
  document.body.innerHTML = ''
})

const labelsFor = (query: string, sections = SETTINGS_SECTIONS) =>
  searchSettings(query, sections).map((hit) => `${hit.kind}:${hit.section}:${hit.label}`)

describe('searchSettings', () => {
  it('finds nothing for an empty query', () => {
    expect(searchSettings('', SETTINGS_SECTIONS)).toEqual([])
    expect(searchSettings('   ', SETTINGS_SECTIONS)).toEqual([])
  })

  it('finds a single setting by its name, or by a word people use for it', () => {
    expect(labelsFor('text size')).toContain('setting:general:Text size')
    expect(labelsFor('dark')).toContain('setting:general:Theme')
    expect(labelsFor('gitignore')).toContain('setting:denied_paths:Denied patterns')
    expect(labelsFor('retention days')).toContain('setting:telemetry:Keep traces and metrics for')
  })

  it('finds the fallback order of accounts under Providers', () => {
    for (const query of ['use first', 'rate limit', 'tried in this order', 'pinned']) {
      expect(labelsFor(query)).toContain('setting:providers:Accounts and fallback order')
    }
  })

  it('finds plugin bundles and single-file plugins under Plugins', () => {
    for (const query of ['bundle', 'agentd plugin add', 'permissions', 'reload']) {
      expect(labelsFor(query)).toContain('setting:plugins:Plugin bundles')
    }
    for (const query of ['single-file', 'hooks', 'typescript']) {
      expect(labelsFor(query)).toContain('setting:plugins:Single-file plugins')
    }
  })

  it('scrolls to the page\'s own headings for the two plugin lists', () => {
    const anchors = Object.fromEntries(
      searchSettings('plugins', SETTINGS_SECTIONS).flatMap((hit) => (hit.kind === 'setting' && hit.section === 'plugins' ? [[hit.label, hit.anchor]] : [])),
    )
    expect(anchors).toEqual({ 'Plugin bundles': 'Bundles', 'Single-file plugins': 'Single-file plugins' })
  })

  it('needs every word of the query, in any order', () => {
    expect(labelsFor('size text')).toContain('setting:general:Text size')
    expect(labelsFor('text zzz')).toEqual([])
  })

  it('lists matching sections first, then settings whose name starts with the query', () => {
    const hits = searchSettings('server', SETTINGS_SECTIONS)
    expect(hits[0]).toMatchObject({ kind: 'section', section: 'connection', label: 'Server' })
    const settings = hits.filter((hit) => hit.kind === 'setting').map((hit) => hit.label)
    expect(settings.indexOf('Server URL')).toBeLessThan(settings.indexOf('Access key'))
  })

  it('names the section a setting lives in', () => {
    const hit = searchSettings('climb', SETTINGS_SECTIONS).find((h) => h.label === 'Climb on windows')
    expect(hit).toMatchObject({ kind: 'setting', section: 'desktop', sectionLabel: 'Desktop' })
  })

  it('finds the pet\'s jumping and falling under climbing on windows', () => {
    for (const query of ['jump', 'fall']) {
      const hit = searchSettings(query, SETTINGS_SECTIONS).find((h) => h.label === 'Climb on windows')
      expect(hit).toMatchObject({ kind: 'setting', section: 'desktop' })
    }
    expect(SETTINGS_INDEX.some((e) => e.label === 'Ladders')).toBe(false)
  })

  it('skips settings of a section this app does not show', () => {
    const without = SETTINGS_SECTIONS.filter((s) => s.id !== 'desktop')
    expect(labelsFor('notch', without).some((l) => l.includes(':desktop:'))).toBe(false)
    expect(labelsFor('notch').some((l) => l.includes(':desktop:'))).toBe(true)
  })

  it('indexes only sections that exist', () => {
    const ids = new Set(SETTINGS_SECTIONS.map((s) => s.id))
    for (const entry of SETTINGS_INDEX) expect([entry.label, ids.has(entry.section)]).toEqual([entry.label, true])
  })
})

describe('revealSetting', () => {
  function page() {
    document.body.innerHTML = `
      <main>
        <div class="row"><span>Theme</span><button role="radio">Light</button></div>
        <div class="row"><div><span>Expand on hover</span><p>Point at it.</p></div><button role="switch" id="hover"></button></div>
      </main>`
    return document.querySelector('main') as HTMLElement
  }

  it('scrolls to the setting and focuses its control', () => {
    const scrolled = mock(() => {})
    HTMLElement.prototype.scrollIntoView = scrolled
    const root = page()
    expect(revealSetting(root, 'expand on hover')).toBe(true)
    expect(scrolled).toHaveBeenCalledTimes(1)
    expect(document.activeElement?.id).toBe('hover')
  })

  it('reports a setting the page has not shown (yet)', () => {
    expect(revealSetting(page(), 'Nothing like this')).toBe(false)
    expect(revealSetting(null, 'Theme')).toBe(false)
  })
})
