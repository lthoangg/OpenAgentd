import { beforeEach, describe, expect, it } from 'bun:test'
import type { ProviderInfo, ProviderUsageResponse, StoredCredential } from '@/api/client'
import {
  accountChoices,
  effectiveRun,
  loadRecentModels,
  accountInUse,
  quotaSegments,
  shortWindowLabel,
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

describe('accountInUse', () => {
  const work = credential('work', { label: 'Work' })
  const home = credential('home', { label: 'Home', in_use: true })
  const spare = credential('spare', { label: 'Spare' })

  it("follows the provider's account in use when nothing is locked", () => {
    expect(accountInUse([work, home, spare], null, null)?.id).toBe('home')
  })

  it('is the locked account while it has room, whatever answered last', () => {
    expect(accountInUse([work, home, spare], 'spare', 'Home')?.id).toBe('spare')
  })

  it('is the account a locked session moved to while the lock cools down', () => {
    const cooling = { ...spare, status: 'cooling_down' as const }
    expect(accountInUse([work, home, cooling], 'spare', 'Work')?.id).toBe('work')
    // Before anything answered, the account the provider moves on to.
    expect(accountInUse([work, home, cooling], 'spare', null)?.id).toBe('home')
  })

  it('takes the first account with room when the usual ones are limited, else the lock', () => {
    const limited = (c: StoredCredential) => ({ ...c, status: 'cooling_down' as const })
    expect(accountInUse([work, limited(home)], null, null)?.id).toBe('work')
    expect(accountInUse([limited(work), limited(home)], 'work', null)?.id).toBe('work')
  })

  it('is nothing when there is no choice of accounts', () => {
    expect(accountInUse(null, 'work', 'Work')).toBeNull()
  })
})

describe('shortWindowLabel', () => {
  it('names a window in a few letters', () => {
    expect(shortWindowLabel(300)).toBe('5h')
    expect(shortWindowLabel(10_080)).toBe('7d')
    expect(shortWindowLabel(30)).toBe('30m')
    expect(shortWindowLabel(null)).toBeNull()
  })
})

describe('quotaSegments', () => {
  const NOW = 1_700_000_000_000
  const usage = (...limits: ProviderUsageResponse['limits']): ProviderUsageResponse => ({ provider: 'codex', limits })
  const credits = (c: { has_credits: boolean; unlimited?: boolean; balance?: string | null }) => ({ credits: { unlimited: false, ...c } })
  const spend = (s: Partial<NonNullable<ProviderUsageResponse['limits'][number]['spend']>>) => ({ spend: { reached: false, ...s } })
  const texts = (u: ProviderUsageResponse) => quotaSegments(u, NOW)?.segments.map((s) => s.text)
  const tones = (u: ProviderUsageResponse) => quotaSegments(u, NOW)?.segments.map((s) => s.tone)

  it('lists both windows of the main limit in % used', () => {
    const u = usage({ primary: { used_percent: 12, window_minutes: 300 }, secondary: { used_percent: 64, window_minutes: 10_080 } })
    expect(texts(u)).toEqual(['5h 12%', '7d 64%'])
    expect(tones(u)).toEqual(['muted', 'muted'])
  })

  it('colours the limit that was hit red and one at 90% or more orange', () => {
    const u = usage({ primary: { used_percent: 100, window_minutes: 300 }, secondary: { used_percent: 91.2, window_minutes: 10_080 } })
    expect(texts(u)).toEqual(['5h 100%', '7d 91%'])
    expect(tones(u)).toEqual(['error', 'warning'])
  })

  it('says when each window resets, in the tooltip', () => {
    const u = usage({ primary: { used_percent: 100, window_minutes: 300, resets_at: NOW / 1000 + 102 * 60 }, secondary: { used_percent: 40, window_minutes: 10_080 } })
    expect(quotaSegments(u, NOW)?.detail).toBe('5-hour limit reached, resets in 1h 42m · Weekly limit 40% used')
  })

  it("keeps another model's windows to the tooltip", () => {
    const u = usage(
      { limit_id: 'codex', primary: { used_percent: 20, window_minutes: 300 } },
      { limit_id: 'spark', limit_name: 'Spark', primary: { used_percent: 100, window_minutes: 300 } },
    )
    expect(texts(u)).toEqual(['5h 20%'])
    expect(quotaSegments(u, NOW)?.detail).toBe('5-hour limit 20% used · Spark 5-hour limit reached')
  })

  it('reads a sub-percent use as <1%, not 0%', () => {
    expect(texts(usage({ primary: { used_percent: 0.4, window_minutes: 300 } }))).toEqual(['5h <1%'])
  })

  it('is unknown when nothing is reported', () => {
    expect(quotaSegments({ provider: 'x', limits: [] })).toBeNull()
    expect(quotaSegments(undefined)).toBeNull()
    expect(quotaSegments(usage({ limit_id: 'a', plan_type: 'enterprise' }))).toBeNull()
  })

  it('shows a spend cap used, in the currency when it is known', () => {
    expect(texts(usage(spend({ currency: 'USD', limit: 50, used: 38, remaining: 12, used_percent: 76 })))).toEqual(['$38.00 of $50.00 used'])
    expect(texts(usage(spend({ limit: 700, remaining: 449.5 })))).toEqual(['250.5 of 700 used'])
    expect(texts(usage(spend({ used_percent: 60 })))).toEqual(['Spend 60%'])
  })

  it('warns as a spend cap runs low, and is red once reached', () => {
    expect(tones(usage(spend({ limit: 100, used: 95, used_percent: 95 })))).toEqual(['warning'])
    expect(tones(usage(spend({ reached: true, limit: 100, used: 100 })))).toEqual(['error'])
  })

  it('shows windows, spend and credits side by side', () => {
    const u = usage({
      primary: { used_percent: 30, window_minutes: 300 },
      ...credits({ has_credits: true, balance: '$84.50' }),
      ...spend({ currency: 'USD', limit: 50, used: 45, used_percent: 90 }),
    })
    expect(texts(u)).toEqual(['5h 30%', '$45.00 of $50.00 used', '$84.50 left'])
    expect(tones(u)).toEqual(['muted', 'warning', 'muted'])
  })

  it('shows a credit balance as left, and any other balance string as given', () => {
    expect(texts(usage(credits({ has_credits: true, balance: '$84.50' })))).toEqual(['$84.50 left'])
    expect(texts(usage(credits({ has_credits: true, balance: '237/300' })))).toEqual(['237/300'])
    expect(texts(usage(credits({ has_credits: true, unlimited: true })))).toEqual(['Unlimited'])
    expect(texts(usage(credits({ has_credits: true })))).toEqual(['Credits available'])
  })

  it('shows empty credits in red when nothing else has room', () => {
    const u = usage(credits({ has_credits: false }))
    expect(texts(u)).toEqual(['No credits left'])
    expect(tones(u)).toEqual(['error'])
  })

  it('keeps empty credits orange while a window still has room, and hides them on a plan without credits', () => {
    const spent = usage({ primary: { used_percent: 20, window_minutes: 300 }, ...credits({ has_credits: false }), ...spend({ reached: true }) })
    expect(texts(spent)).toEqual(['5h 20%', 'No credits left'])
    expect(tones(spent)).toEqual(['muted', 'warning'])
    const none = usage({ primary: { used_percent: 20, window_minutes: 300 }, ...credits({ has_credits: false, balance: '0' }) })
    expect(texts(none)).toEqual(['5h 20%'])
  })

  it('says Limit reached for a reached cap that reports no figures', () => {
    const u = usage(spend({ reached: true }))
    expect(texts(u)).toEqual(['Limit reached'])
    expect(tones(u)).toEqual(['error'])
  })
})
