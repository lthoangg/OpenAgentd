import { describe, it, expect } from 'bun:test'
import { parseDeepLinkUrl } from '@/hooks/useDeepLinkRouter'

describe('parseDeepLinkUrl', () => {
  it('parses auth callback deep links correctly', () => {
    const res = parseDeepLinkUrl('openagentd://auth/callback?provider=codex&code=abc123code')
    expect(res).toEqual({
      kind: 'auth_callback',
      provider: 'codex',
      code: 'abc123code',
    })
  })

  it('parses auth callback with code#state format', () => {
    const res = parseDeepLinkUrl('openagentd://auth/callback?provider=copilot&code=code123&state=state456')
    expect(res).toEqual({
      kind: 'auth_callback',
      provider: 'copilot',
      code: 'code123#state456',
    })
  })

  it('parses navigation deep links for cockpit session', () => {
    const res = parseDeepLinkUrl('openagentd://cockpit/sess-999')
    expect(res).toEqual({
      kind: 'navigate',
      path: '/cockpit/sess-999',
    })
  })
})
