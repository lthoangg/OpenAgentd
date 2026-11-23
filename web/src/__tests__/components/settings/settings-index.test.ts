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
    expect(labelsFor('gitignore')).toContain('setting:blocked_files:Blocked patterns')
    expect(labelsFor('retention days')).toContain('setting:sessions:Keep usage history for')
  })

  it('finds the Detail setting by its new name and by every old one', () => {
    for (const query of ['detail', 'simple', 'full', 'reader', 'detailed', 'transcript']) {
      expect(labelsFor(query)).toContain('setting:general:Detail')
    }
    for (const query of ['previews', 'manually', 'review panel', 'automatically']) {
      expect(labelsFor(query)).toContain('setting:general:Open the Browser tab')
    }
  })

  it('finds the fallback order of accounts under Models', () => {
    for (const query of ['use first', 'rate limit', 'tried in this order', 'pinned']) {
      expect(labelsFor(query)).toContain('setting:models:Accounts and fallback order')
    }
  })

  it('finds plugin folders and single-file plugins under Plugins', () => {
    for (const query of ['folder', 'bundle', 'agentd plugin add', 'permissions', 'reload']) {
      expect(labelsFor(query)).toContain('setting:plugins:Plugin folders')
    }
    for (const query of ['single-file', 'hooks', 'typescript']) {
      expect(labelsFor(query)).toContain('setting:plugins:Single-file plugins')
    }
  })

  it('scrolls to the page\'s own headings for the two plugin lists', () => {
    const anchors = Object.fromEntries(
      searchSettings('plugins', SETTINGS_SECTIONS).flatMap((hit) => (hit.kind === 'setting' && hit.section === 'plugins' ? [[hit.label, hit.anchor]] : [])),
    )
    expect(anchors).toEqual({ 'Plugin folders': 'Plugin folders', 'Single-file plugins': 'Single-file plugins' })
  })

  it('finds every renamed page by the name it had', () => {
    const firstSection = (query: string) => searchSettings(query, SETTINGS_SECTIONS).find((hit) => hit.kind === 'section')
    expect(firstSection('mcp')).toMatchObject({ section: 'connectors', label: 'Connectors' })
    expect(firstSection('mcp servers')).toMatchObject({ section: 'connectors', label: 'Connectors' })
    expect(firstSection('provider')).toMatchObject({ section: 'models', label: 'Models' })
    expect(firstSection('providers')).toMatchObject({ section: 'models', label: 'Models' })
    expect(firstSection('denied')).toMatchObject({ section: 'blocked_files', label: 'Blocked files' })
    expect(firstSection('denied paths')).toMatchObject({ section: 'blocked_files', label: 'Blocked files' })
    expect(firstSection('server')).toMatchObject({ section: 'switch_computer', label: 'Switch computer' })
    expect(firstSection('about openagentd')).toMatchObject({ section: 'about', label: 'About' })
  })

  it('finds Sessions by each of the four pages it replaced, and their settings by the old names', () => {
    for (const query of ['session titles', 'context', 'goals', 'retention']) {
      expect(searchSettings(query, SETTINGS_SECTIONS).find((hit) => hit.kind === 'section')).toMatchObject({ section: 'sessions', label: 'Sessions' })
    }
    expect(labelsFor('token threshold')).toContain('setting:sessions:Summarize when a session reaches')
    expect(labelsFor('idle trigger')).toContain('setting:sessions:Summarize idle sessions')
    expect(labelsFor('keep forever')).toContain('setting:sessions:Keep usage history forever')
    expect(labelsFor('generate titles')).toContain('setting:sessions:Name sessions automatically')
  })

  it('finds the list of computers by the words the Server page used, and names each result as the page does', () => {
    const settingsFor = (query: string) => searchSettings(query, SETTINGS_SECTIONS).filter((hit) => hit.kind === 'setting')
    expect(settingsFor('built-in server')).toContainEqual(expect.objectContaining({ section: 'switch_computer', label: 'This computer', anchor: 'Computers' }))
    for (const query of ['saved server', 'server url', 'add a server', 'computer']) {
      expect({ query, hits: settingsFor(query) }).toEqual({ query, hits: expect.arrayContaining([expect.objectContaining({ section: 'switch_computer', label: 'Add a computer by address', anchor: 'Add a computer by address' })]) })
    }
    const labels = SETTINGS_INDEX.filter((entry) => entry.section === 'switch_computer').map((entry) => entry.label)
    expect(labels.filter((label) => /server/i.test(label))).toEqual([])
  })

  it('needs every word of the query, in any order', () => {
    expect(labelsFor('size text')).toContain('setting:general:Text size')
    expect(labelsFor('text zzz')).toEqual([])
  })

  it('lists matching sections first, then settings whose name starts with the query', () => {
    const hits = searchSettings('server', SETTINGS_SECTIONS)
    expect(hits[0]).toMatchObject({ kind: 'section', section: 'switch_computer', label: 'Switch computer' })
    const settings = searchSettings('add', SETTINGS_SECTIONS).filter((hit) => hit.kind === 'setting').map((hit) => hit.label)
    expect(settings[0]).toBe('Add a computer by address')
    expect(settings.length).toBeGreaterThan(1)
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

  it('focuses a button named by the setting itself (Add a computer by address)', () => {
    const root = document.createElement('div')
    root.innerHTML = '<h2>Computers</h2><button type="button">Use</button><button type="button">Add a computer by address</button>'
    document.body.append(root)
    try {
      expect(revealSetting(root, 'Add a computer by address')).toBe(true)
      expect(document.activeElement?.textContent).toBe('Add a computer by address')
    } finally {
      root.remove()
    }
  })

  it('reports a setting the page has not shown (yet)', () => {
    expect(revealSetting(page(), 'Nothing like this')).toBe(false)
    expect(revealSetting(null, 'Theme')).toBe(false)
  })
})
