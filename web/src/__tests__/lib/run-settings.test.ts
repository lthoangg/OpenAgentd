import { beforeEach, describe, expect, it } from 'bun:test'
import type { ProviderInfo, ProviderUsageResponse, StoredCredential } from '@/api/client'
import {
  accountChoices,
  effectiveRun,
  loadRecentModels,
  quotaLeftPercent,
  rememberRecentModel,
  setFrontmatterScalars,
  splitModelId,
  stepThinkingLevel,
  thinkingLevelLabel,
  thinkingLevelShortLabel,
} from '@/lib/run-settings'

describe('splitModelId', () => {
  it('splits provider and model at the first colon', () => {
    expect(splitModelId('openrouter:anthropic/claude:beta')).toEqual({ provider: 'openrouter', model: 'anthropic/claude:beta' })
    expect(splitModelId('gpt-5')).toEqual({ provider: '', model: 'gpt-5' })
  })
})

describe('thinkingLevelLabel', () => {
  it('names levels in words', () => {
    expect(thinkingLevelLabel('none')).toBe('Off')
    expect(thinkingLevelLabel('high')).toBe('High')
    expect(thinkingLevelLabel('very-deep')).toBe('Very Deep')
  })

  it('has a short form for a level whose name is long', () => {
    expect(thinkingLevelShortLabel('xhigh')).toBe('XHigh')
    expect(thinkingLevelShortLabel('high')).toBe('High')
    expect(thinkingLevelShortLabel('very-deep')).toBe('Very Deep')
  })
})

describe('recent models', () => {
  beforeEach(() => window.localStorage.clear())

  it('keeps the five most recent, newest first, without repeats', () => {
    for (const id of ['a:1', 'a:2', 'a:3', 'a:4', 'a:5', 'a:6', 'a:3']) rememberRecentModel(id)
    expect(loadRecentModels()).toEqual(['a:3', 'a:6', 'a:5', 'a:4', 'a:2'])
  })
})

describe('setFrontmatterScalars', () => {
  const raw = '---\nname: code\nrole: lead\nmodel: old:model\nresponses_api: true\n---\n\nYou help.\n'

  it('replaces and adds keys, keeping every other line', () => {
    expect(setFrontmatterScalars(raw, { model: 'agy:claude', thinking_level: 'high' }))
      .toBe('---\nname: code\nrole: lead\nmodel: agy:claude\nresponses_api: true\nthinking_level: high\n---\n\nYou help.\n')
  })

  it('removes a key set to null', () => {
    expect(setFrontmatterScalars(raw, { model: null })).toBe('---\nname: code\nrole: lead\nresponses_api: true\n---\n\nYou help.\n')
  })

  it('leaves a file without frontmatter alone', () => {
    expect(setFrontmatterScalars('Just text', { model: 'x:y' })).toBe('Just text')
  })
})

describe('effectiveRun', () => {
  const agent = { model: 'anthropic:sonnet', thinkingLevel: 'medium' }

  it('runs the agent model and level when the session sets nothing', () => {
    expect(effectiveRun({ model: null, thinkingLevel: null }, agent)).toEqual({ model: 'anthropic:sonnet', thinkingLevel: 'medium', overridden: false })
  })

  it('drops the agent level once the session picks another model', () => {
    expect(effectiveRun({ model: 'openai:gpt-5', thinkingLevel: null }, agent)).toEqual({ model: 'openai:gpt-5', thinkingLevel: null, overridden: true })
  })

  it('prefers the session level', () => {
    expect(effectiveRun({ model: null, thinkingLevel: 'high' }, agent).thinkingLevel).toBe('high')
  })
})

describe('stepThinkingLevel', () => {
  const levels = ['none', 'low', 'medium', 'high']

  it('moves one level and stops at either end', () => {
    expect(stepThinkingLevel(levels, 'low', 1)).toBe('medium')
    expect(stepThinkingLevel(levels, 'high', 1)).toBe('high')
    expect(stepThinkingLevel(levels, 'none', -1)).toBe('none')
  })

  it('starts from the first level when none is chosen', () => {
    expect(stepThinkingLevel(levels, null, 1)).toBe('none')
  })
})

function credential(id: string, extra: Partial<StoredCredential> = {}): StoredCredential {
  return { id, label: id, disabled: false, kind: 'api_key', hint: null, settings: {}, status: 'ready', in_use: false, cooldown_until: null, cooldown_reason: null, ...extra }
}

describe('accountChoices', () => {
  const provider = (extra: Partial<ProviderInfo>) => ({ stored_credentials: [credential('a'), credential('b')], supports_multiple_credentials: true, ...extra }) as ProviderInfo

  it('lists the enabled accounts of a provider that holds several', () => {
    expect(accountChoices(provider({}))?.map((c) => c.id)).toEqual(['a', 'b'])
  })

  it('offers no choice for one account, an environment key, or a single-key provider', () => {
    expect(accountChoices(provider({ stored_credentials: [credential('a')] }))).toBeNull()
    expect(accountChoices(provider({ env_pinned: true }))).toBeNull()
    expect(accountChoices(provider({ supports_multiple_credentials: false }))).toBeNull()
  })

  it('leaves out disabled accounts', () => {
    const p = provider({ stored_credentials: [credential('a'), credential('b', { disabled: true }), credential('c')] })
    expect(accountChoices(p)?.map((c) => c.id)).toEqual(['a', 'c'])
  })
})

describe('quotaLeftPercent', () => {
  it('reports the tightest window', () => {
    const usage: ProviderUsageResponse = {
      provider: 'codex',
      limits: [{ primary: { used_percent: 30 }, secondary: { used_percent: 82 } }],
    }
    expect(quotaLeftPercent(usage)).toBe(18)
  })

  it('is unknown without windows', () => {
    expect(quotaLeftPercent({ provider: 'x', limits: [] })).toBeNull()
    expect(quotaLeftPercent(undefined)).toBeNull()
  })
})
