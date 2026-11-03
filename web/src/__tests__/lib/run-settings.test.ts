import { beforeEach, describe, expect, it } from 'bun:test'
import type { ProviderInfo, ProviderUsageResponse, StoredCredential } from '@/api/client'
import {
  accountChoices,
  effectiveRun,
  loadRecentModels,
  quotaSummary,
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

describe('quotaSummary', () => {
  const usage = (...limits: ProviderUsageResponse['limits']): ProviderUsageResponse => ({ provider: 'codex', limits })
  const credits = (c: { has_credits: boolean; unlimited?: boolean; balance?: string | null }) => ({ credits: { unlimited: false, ...c } })
  const spend = (s: Partial<NonNullable<ProviderUsageResponse['limits'][number]['spend']>>) => ({ spend: { reached: false, ...s } })

  it('reports the tightest window as percent left', () => {
    const summary = quotaSummary(usage({ primary: { used_percent: 30 }, secondary: { used_percent: 82 } }))
    expect(summary).toMatchObject({ kind: 'percent', left: 18 })
  })

  it('takes the tightest window across every limit', () => {
    const summary = quotaSummary(usage({ primary: { used_percent: 30 } }, { primary: { used_percent: 95.4 } }))
    expect(summary).toMatchObject({ kind: 'percent', left: 5 })
  })

  it('is unknown when nothing is reported', () => {
    expect(quotaSummary({ provider: 'x', limits: [] })).toBeNull()
    expect(quotaSummary(undefined)).toBeNull()
    expect(quotaSummary(usage({ limit_id: 'a', plan_type: 'enterprise' }))).toBeNull()
  })

  it('shows what is left of a spend cap, in the currency when it is known', () => {
    const summary = quotaSummary(usage(spend({ currency: 'USD', limit: 50, used: 38, remaining: 12, used_percent: 76 })))
    expect(summary).toEqual({ kind: 'spend', text: '$12.00 of $50.00 left', tone: 'muted' })
  })

  it('works the remainder out from used and limit, and leaves an unknown unit as bare numbers', () => {
    const summary = quotaSummary(usage(spend({ limit: 700, used: 250.5 })))
    expect(summary).toMatchObject({ kind: 'spend', text: '449.5 of 700 left' })
  })

  it('falls back to percent left when a spend cap only reports used_percent', () => {
    expect(quotaSummary(usage(spend({ used_percent: 60 })))).toMatchObject({ kind: 'spend', text: '40% left', tone: 'muted' })
  })

  it('warns as a spend cap runs low', () => {
    expect(quotaSummary(usage(spend({ limit: 100, used: 95, remaining: 5, used_percent: 95 })))).toMatchObject({ kind: 'spend', tone: 'warning' })
  })

  // Credits ran out but the plan's windows still run the account: it was
  // shown as "Limit reached" though it still had room.
  it('lets a window with room lead over a reached cap, noting the credits are spent', () => {
    const summary = quotaSummary(usage({ primary: { used_percent: 20 }, ...credits({ has_credits: false }), ...spend({ reached: true, limit: 700, used: 800, remaining: 0 }) }))
    expect(summary).toEqual({ kind: 'percent', left: 80, tone: 'warning', note: 'no credits', detail: 'Spend cap reached' })
  })

  it('says Limit reached for a reached cap once the windows are spent too', () => {
    const summary = quotaSummary(usage({ primary: { used_percent: 100 }, ...credits({ has_credits: true, balance: '$84.50' }), ...spend({ reached: true }) }))
    expect(summary).toMatchObject({ kind: 'spend', text: 'Limit reached', tone: 'error' })
  })

  it('says Limit reached for a reached cap that reports no figures', () => {
    expect(quotaSummary(usage(spend({ reached: true })))).toMatchObject({ kind: 'spend', text: 'Limit reached', tone: 'error' })
  })

  it('shows a credit balance as left, and any other balance string as given', () => {
    expect(quotaSummary(usage(credits({ has_credits: true, balance: '$84.50' })))).toEqual({ kind: 'credits', text: '$84.50 left', tone: 'muted' })
    expect(quotaSummary(usage(credits({ has_credits: true, balance: '237/300' })))).toMatchObject({ kind: 'credits', text: '237/300' })
    expect(quotaSummary(usage(credits({ has_credits: true, unlimited: true, balance: '237/\u221e' })))).toMatchObject({ kind: 'credits', text: '237/\u221e' })
  })

  it('says Unlimited for unlimited credits with no balance', () => {
    expect(quotaSummary(usage(credits({ has_credits: true, unlimited: true })))).toEqual({ kind: 'credits', text: 'Unlimited', tone: 'muted' })
  })

  it('says No credits left, as an error, when there is nothing else to go on', () => {
    expect(quotaSummary(usage(credits({ has_credits: false })))).toEqual({ kind: 'credits', text: 'No credits left', tone: 'error' })
  })

  it('says Credits available when credits exist but no balance is given', () => {
    expect(quotaSummary(usage(credits({ has_credits: true })))).toMatchObject({ kind: 'credits', text: 'Credits available' })
  })

  it('lets a percent window lead and puts the balance in the detail', () => {
    const summary = quotaSummary(usage({ primary: { used_percent: 20 }, ...credits({ has_credits: true, balance: '$84.50' }) }))
    expect(summary).toEqual({ kind: 'percent', left: 80, tone: 'muted', detail: 'Balance $84.50' })
  })

  it('does not let empty credits hide a window that has room (plans without credits report none)', () => {
    const summary = quotaSummary(usage({ primary: { used_percent: 20 }, ...credits({ has_credits: false, balance: '0' }) }))
    expect(summary).toEqual({ kind: 'percent', left: 80, tone: 'muted' })
  })

  it('shows a spend cap that binds before the windows, with the balance in the detail', () => {
    const summary = quotaSummary(usage({
      primary: { used_percent: 30 },
      ...credits({ has_credits: true, balance: '$84.50' }),
      ...spend({ currency: 'USD', limit: 50, used: 45, remaining: 5, used_percent: 90 }),
    }))
    expect(summary).toEqual({ kind: 'spend', text: '$5.00 of $50.00 left', tone: 'warning', detail: 'Balance $84.50' })
  })

  it('lets a window that binds first lead, with the spend cap in the detail', () => {
    const summary = quotaSummary(usage({ primary: { used_percent: 90 }, ...spend({ currency: 'USD', limit: 50, used: 10, remaining: 40, used_percent: 20 }) }))
    expect(summary).toEqual({ kind: 'percent', left: 10, tone: 'muted', detail: 'Spend cap $40.00 of $50.00 left' })
  })

  it('ignores a currency code that is not one', () => {
    expect(quotaSummary(usage(spend({ currency: 'credits', limit: 10, remaining: 4 })))).toMatchObject({ text: '4 of 10 left' })
  })
})
