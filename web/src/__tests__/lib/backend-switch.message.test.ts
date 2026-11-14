/**
 * What the app says when a server does not answer: an app user reads it, so
 * it names the setting to turn on, not a server flag.
 */
import { describe, expect, it } from 'bun:test'
import { connectionFailureMessage } from '@/lib/backend-switch'

describe('connectionFailureMessage', () => {
  it('names the setting that lets another device in, for a server on another computer', () => {
    const message = connectionFailureMessage('http://192.168.1.20:4082')
    expect(message).toContain('Access from other devices')
    expect(message).toContain('Settings → Server')
    expect(message).toContain('same network')
    expect(message).not.toContain('--host')
    expect(message).not.toContain('LAN IP')
  })

  it('says to check that it is running and the port, for a server on this computer', () => {
    for (const url of ['http://localhost:4082', 'http://127.0.0.1:4082', 'http://[::1]:4082']) {
      const message = connectionFailureMessage(url)
      expect(message).toContain('running')
      expect(message).toContain('port')
      expect(message).not.toContain('Access from other devices')
    }
  })
})
