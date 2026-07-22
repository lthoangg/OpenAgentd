import { describe, expect, it } from 'bun:test'
import { parseDeepLinkUrl } from '@/hooks/useDeepLinkRouter'

describe('parseDeepLinkUrl', () => {
  it('parses the exact auth callback path with a provider and code', () => {
    const res = parseDeepLinkUrl('openagentd://auth/callback?provider=codex&code=abc123code')
    expect(res).toEqual({
      kind: 'auth_callback',
      provider: 'codex',
      code: 'abc123code',
    })
  })

  it('preserves the callback state in the existing code#state callback format', () => {
    const res = parseDeepLinkUrl('openagentd://auth/callback?provider=copilot&code=code123&state=state456')
    expect(res).toEqual({
      kind: 'auth_callback',
      provider: 'copilot',
      code: 'code123#state456',
    })
  })

  it('rejects callback lookalike paths and callbacks missing required values', () => {
    for (const url of [
      'openagentd://auth/callback/extra?provider=codex&code=abc',
      'openagentd://auth/callbacks?provider=codex&code=abc',
      'openagentd://auth-callback?provider=codex&code=abc',
      'openagentd://auth/callback?code=abc',
      'openagentd://auth/callback?provider=&code=abc',
      'openagentd://auth/callback?provider=%20&code=abc',
      'openagentd://auth/callback?provider=codex',
      'openagentd://auth/callback?provider=codex&code=',
      'openagentd://auth/callback?provider=codex&code=%20',
    ]) {
      expect(parseDeepLinkUrl(url)).toEqual({ kind: 'unknown' })
    }
  })

  it('parses navigation deep links for cockpit session', () => {
    const res = parseDeepLinkUrl('openagentd://cockpit/sess-999')
    expect(res).toEqual({
      kind: 'navigate',
      path: '/cockpit/sess-999',
    })
  })

  it('accepts the isolated development app scheme', () => {
    expect(parseDeepLinkUrl('openagentd-dev://coding/dev-session')).toEqual({
      kind: 'navigate',
      path: '/coding/dev-session',
    })
  })
})

export {}
