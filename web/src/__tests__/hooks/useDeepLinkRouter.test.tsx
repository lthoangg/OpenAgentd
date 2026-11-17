import { describe, expect, it } from 'bun:test'
import { DEEP_LINK_PROMPT_MAX, deepLinkParts, parseDeepLinkUrl } from '@/hooks/useDeepLinkRouter'

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

  it('reads a connector sign-in the relay page sent to the app', () => {
    expect(parseDeepLinkUrl('openagentd://mcp-oauth?code=c1&state=s1.e30')).toEqual({ kind: 'mcp_oauth', search: '?code=c1&state=s1.e30' })
    expect(parseDeepLinkUrl('openagentd-dev://mcp-oauth?code=c1&state=s1')).toEqual({ kind: 'mcp_oauth', search: '?code=c1&state=s1' })
    expect(parseDeepLinkUrl('openagentd://mcp-oauth/extra?code=c1&state=s1')).toEqual({ kind: 'unknown' })
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

  it('ignores the link hosts of builds before v3.0.0', () => {
    expect(parseDeepLinkUrl('openagentd://cockpit/sess-999')).toEqual({ kind: 'unknown' })
    expect(parseDeepLinkUrl('openagentd://coding/sess-999')).toEqual({ kind: 'unknown' })
  })

  it('accepts the isolated development app scheme', () => {
    expect(parseDeepLinkUrl('openagentd-dev://session/dev-session')).toEqual({
      kind: 'navigate',
      path: '/dev-session',
    })
  })

  it('opens a new session for a link without a session id', () => {
    expect(parseDeepLinkUrl('openagentd://session/')).toEqual({ kind: 'navigate', path: '/' })
  })

  // Home-screen widget links.
  it('opens a session from a widget row', () => {
    expect(parseDeepLinkUrl('openagentd://session/01a17359-cd87')).toEqual({ kind: 'navigate', path: '/01a17359-cd87' })
  })

  it('reads the server a session link names: a widget token, an account computer, or an address', () => {
    expect(parseDeepLinkUrl('openagentd://session/s1?srv=k3x9a0b2c7d1')).toEqual({ kind: 'navigate', path: '/s1', server: { token: 'k3x9a0b2c7d1' } }) // gitleaks:allow (a fake widget token)
    expect(parseDeepLinkUrl('openagentd://session/s1?device=dev-mac&server=http%3A%2F%2F192.168.1.20%3A4082%2F')).toEqual({
      kind: 'navigate',
      path: '/s1',
      server: { deviceId: 'dev-mac', baseUrl: 'http://192.168.1.20:4082' },
    })
    // Only web addresses name a server; anything else is ignored.
    expect(parseDeepLinkUrl('openagentd://session/s1?server=javascript%3Aalert(1)')).toEqual({ kind: 'navigate', path: '/s1' })
    // A link with no session opens the app as before.
    expect(parseDeepLinkUrl('openagentd://session?srv=k3x9a0b2c7d1')).toEqual({ kind: 'navigate', path: '/' })
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

  it('fills a new draft with the prompt a link carries, cut to length', () => {
    expect(parseDeepLinkUrl('openagentd://new?prompt=hi%20there')).toEqual({ kind: 'new_session', workspace: null, prompt: 'hi there' })
    expect(parseDeepLinkUrl('openagentd://new?workspace=%2Frepo&prompt=fix+it')).toEqual({ kind: 'new_session', workspace: '/repo', prompt: 'fix it' })
    expect(parseDeepLinkUrl('openagentd://new?prompt=%20%0A')).toEqual({ kind: 'new_session', workspace: null })
    const long = parseDeepLinkUrl(`openagentd://new?prompt=${'a'.repeat(9000)}`)
    expect(long.kind === 'new_session' ? long.prompt?.length : 0).toBe(DEEP_LINK_PROMPT_MAX)
  })

  it('opens Settings, on the section a link names', () => {
    expect(parseDeepLinkUrl('openagentd://settings')).toEqual({ kind: 'open_settings', section: null })
    expect(parseDeepLinkUrl('openagentd://settings/')).toEqual({ kind: 'open_settings', section: null })
    expect(parseDeepLinkUrl('openagentd-dev://settings/models')).toEqual({ kind: 'open_settings', section: 'models' })
    expect(parseDeepLinkUrl('openagentd://settings/a/b')).toEqual({ kind: 'unknown' })
  })

  it('opens telemetry on the range, trace or session a link names', () => {
    expect(parseDeepLinkUrl('openagentd://telemetry')).toEqual({ kind: 'open_telemetry' })
    expect(parseDeepLinkUrl('openagentd://telemetry?days=7&traceId=t1&session=s1')).toEqual({ kind: 'open_telemetry', days: 7, traceId: 't1', session: 's1' })
    // A range the view has no button for, and empty values, are dropped.
    expect(parseDeepLinkUrl('openagentd://telemetry?days=5&traceId=&session=%20')).toEqual({ kind: 'open_telemetry' })
    expect(parseDeepLinkUrl('openagentd://telemetry/extra')).toEqual({ kind: 'unknown' })
  })

  it('reads a session link as one session id, not any app path', () => {
    expect(parseDeepLinkUrl('openagentd://session/abc')).toEqual({ kind: 'navigate', path: '/abc' })
    expect(parseDeepLinkUrl('openagentd://session/settings/models')).toEqual({ kind: 'unknown' })
    expect(parseDeepLinkUrl('openagentd://session/a/b?srv=k')).toEqual({ kind: 'unknown' })
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
