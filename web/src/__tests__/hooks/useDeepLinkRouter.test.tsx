import { describe, expect, it } from 'bun:test'
import { deepLinkParts, parseDeepLinkUrl } from '@/hooks/useDeepLinkRouter'

describe('parseDeepLinkUrl', () => {
  it('leaves connect links to useConnectLink', () => {
    expect(parseDeepLinkUrl('openagentd://connect?url=http%3A%2F%2F192.168.1.20%3A4082&key=abc')).toEqual({ kind: 'unknown' })
  })

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

  it('normalizes legacy cockpit deep links to coding', () => {
    const res = parseDeepLinkUrl('openagentd://cockpit/sess-999')
    expect(res).toEqual({
      kind: 'navigate',
      path: '/sess-999',
    })
  })

  it('accepts the isolated development app scheme', () => {
    expect(parseDeepLinkUrl('openagentd-dev://coding/dev-session')).toEqual({
      kind: 'navigate',
      path: '/dev-session',
    })
  })

  it('opens a new session for a link without a session id', () => {
    expect(parseDeepLinkUrl('openagentd://coding')).toEqual({ kind: 'navigate', path: '/' })
    expect(parseDeepLinkUrl('openagentd://session/')).toEqual({ kind: 'navigate', path: '/' })
  })

  // Home-screen widget links.
  it('opens a session from a widget row', () => {
    expect(parseDeepLinkUrl('openagentd://session/01a17359-cd87')).toEqual({ kind: 'navigate', path: '/01a17359-cd87' })
  })

  it('starts a new session draft, in the named folder when given', () => {
    expect(parseDeepLinkUrl('openagentd://new')).toEqual({ kind: 'new_session', workspace: null })
    expect(parseDeepLinkUrl('openagentd-dev://new?workspace=%2FUsers%2Fme%2Frepo')).toEqual({
      kind: 'new_session',
      workspace: '/Users/me/repo',
    })
    expect(parseDeepLinkUrl('openagentd://new?workspace=%20')).toEqual({ kind: 'new_session', workspace: null })
  })

  it('opens the scheduler, on one task when given', () => {
    expect(parseDeepLinkUrl('openagentd://scheduler')).toEqual({ kind: 'open_scheduler', task: null })
    expect(parseDeepLinkUrl('openagentd://scheduler?task=task-1')).toEqual({ kind: 'open_scheduler', task: 'task-1' })
  })

  it('rejects widget hosts with extra path segments', () => {
    expect(parseDeepLinkUrl('openagentd://new/extra')).toEqual({ kind: 'unknown' })
    expect(parseDeepLinkUrl('openagentd://scheduler/extra')).toEqual({ kind: 'unknown' })
  })
})

// The Android System WebView's older Chromium reads `openagentd://scheduler`
// as host "" and pathname "//scheduler".
describe('deepLinkParts', () => {
  it('keeps a host the URL parser found', () => {
    expect(deepLinkParts({ host: 'session', pathname: '/abc' })).toEqual({ host: 'session', pathname: '/abc' })
  })

  it('splits the host out of an old-Chromium pathname', () => {
    expect(deepLinkParts({ host: '', pathname: '//scheduler' })).toEqual({ host: 'scheduler', pathname: '' })
    expect(deepLinkParts({ host: '', pathname: '//session/abc' })).toEqual({ host: 'session', pathname: '/abc' })
    expect(deepLinkParts({ host: '', pathname: '//auth/callback' })).toEqual({ host: 'auth', pathname: '/callback' })
  })

  it('leaves an ordinary empty-host path alone', () => {
    expect(deepLinkParts({ host: '', pathname: '/x' })).toEqual({ host: '', pathname: '/x' })
  })
})

export {}
