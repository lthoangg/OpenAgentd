import { describe, it, expect } from 'bun:test'
import {
  emptyDraft,
  draftFromServerBody,
  draftToServerBody,
  validateDraft,
  draftEquals,
  SERVER_NAME_REGEX,
  type McpServerDraft,
} from '@/components/settings/McpServerDraft'
import type { ServerBody } from '@/api/client'

// ── emptyDraft ───────────────────────────────────────────────────────────────

describe('emptyDraft', () => {
  it('returns a draft with default values', () => {
    const draft = emptyDraft()
    expect(draft.name).toBe('')
    expect(draft.transport).toBe('stdio')
    expect(draft.enabled).toBe(true)
    expect(draft.command).toBe('')
    expect(draft.argsText).toBe('')
    expect(draft.envPairs).toEqual([])
    expect(draft.url).toBe('')
    expect(draft.headerPairs).toEqual([])
  })
})

// ── draftFromServerBody ──────────────────────────────────────────────────────

describe('draftFromServerBody', () => {
  it('hydrates a stdio server from ServerBody', () => {
    const body: ServerBody = {
      transport: 'stdio',
      command: 'npx',
      args: ['@modelcontextprotocol/server-filesystem', '/tmp'],
      env: { PATH: '/usr/bin', HOME: '/home/user' },
      enabled: true,
    }
    const draft = draftFromServerBody('filesystem', body)
    expect(draft.name).toBe('filesystem')
    expect(draft.transport).toBe('stdio')
    expect(draft.command).toBe('npx')
    expect(draft.argsText).toBe('@modelcontextprotocol/server-filesystem\n/tmp')
    expect(draft.envPairs).toEqual([
      { key: 'PATH', value: '/usr/bin' },
      { key: 'HOME', value: '/home/user' },
    ])
    expect(draft.url).toBe('')
    expect(draft.headerPairs).toEqual([])
  })

  it('hydrates an http server from ServerBody', () => {
    const body: ServerBody = {
      transport: 'http',
      url: 'https://mcp.example.com/v1',
      headers: { Authorization: 'Bearer token123', 'X-Custom': 'value' },
      enabled: false,
    }
    const draft = draftFromServerBody('remote', body)
    expect(draft.name).toBe('remote')
    expect(draft.transport).toBe('http')
    expect(draft.url).toBe('https://mcp.example.com/v1')
    expect(draft.headerPairs).toEqual([
      { key: 'Authorization', value: 'Bearer token123' },
      { key: 'X-Custom', value: 'value' },
    ])
    expect(draft.enabled).toBe(false)
    expect(draft.command).toBe('')
    expect(draft.argsText).toBe('')
    expect(draft.envPairs).toEqual([])
  })

  it('handles empty env and headers', () => {
    const stdioBody: ServerBody = {
      transport: 'stdio',
      command: 'cmd',
      args: [],
      env: {},
      enabled: true,
    }
    const draft = draftFromServerBody('test', stdioBody)
    expect(draft.envPairs).toEqual([])
  })
})

// ── draftToServerBody ────────────────────────────────────────────────────────

describe('draftToServerBody', () => {
  it('serializes a stdio draft to ServerBody', () => {
    const draft: McpServerDraft = {
      ...emptyDraft(),
      ...emptyDraft(),
      name: 'filesystem',
      transport: 'stdio',
      enabled: true,
      command: 'npx',
      argsText: '@modelcontextprotocol/server-filesystem\n/tmp',
      envPairs: [
        { key: 'PATH', value: '/usr/bin' },
        { key: 'HOME', value: '/home/user' },
      ],
      url: '',
      headerPairs: [],
    }
    const result = draftToServerBody(draft)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.body.transport).toBe('stdio')
      if (result.body.transport === 'stdio') {
        expect(result.body.command).toBe('npx')
        expect(result.body.args).toEqual([
          '@modelcontextprotocol/server-filesystem',
          '/tmp',
        ])
        expect(result.body.env).toEqual({
          PATH: '/usr/bin',
          HOME: '/home/user',
        })
      }
      expect(result.body.enabled).toBe(true)
    }
  })

  it('serializes an http draft to ServerBody', () => {
    const draft: McpServerDraft = {
      ...emptyDraft(),
      ...emptyDraft(),
      name: 'remote',
      transport: 'http',
      enabled: false,
      command: '',
      argsText: '',
      envPairs: [],
      url: 'https://mcp.example.com/v1',
      headerPairs: [
        { key: 'Authorization', value: 'Bearer token123' },
        { key: 'X-Custom', value: 'value' },
      ],
    }
    const result = draftToServerBody(draft)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.body.transport).toBe('http')
      if (result.body.transport === 'http') {
        expect(result.body.url).toBe('https://mcp.example.com/v1')
        expect(result.body.headers).toEqual({
          Authorization: 'Bearer token123',
          'X-Custom': 'value',
        })
      }
      expect(result.body.enabled).toBe(false)
    }
  })

  it('rejects stdio draft with empty command', () => {
    const draft: McpServerDraft = {
      ...emptyDraft(),
      ...emptyDraft(),
      name: 'test',
      transport: 'stdio',
      enabled: true,
      command: '',
      argsText: '',
      envPairs: [],
      url: '',
      headerPairs: [],
    }
    const result = draftToServerBody(draft)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('Command is required')
    }
  })

  it('rejects http draft with empty url', () => {
    const draft: McpServerDraft = {
      ...emptyDraft(),
      ...emptyDraft(),
      name: 'test',
      transport: 'http',
      enabled: true,
      command: '',
      argsText: '',
      envPairs: [],
      url: '',
      headerPairs: [],
    }
    const result = draftToServerBody(draft)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('URL is required')
    }
  })

  it('trims command and url whitespace', () => {
    const draft: McpServerDraft = {
      ...emptyDraft(),
      ...emptyDraft(),
      name: 'test',
      transport: 'stdio',
      enabled: true,
      command: '  npx  ',
      argsText: '',
      envPairs: [],
      url: '',
      headerPairs: [],
    }
    const result = draftToServerBody(draft)
    expect(result.ok).toBe(true)
    if (result.ok && result.body.transport === 'stdio') {
      expect(result.body.command).toBe('npx')
    }
  })

  it('filters empty args from argsText', () => {
    const draft: McpServerDraft = {
      ...emptyDraft(),
      ...emptyDraft(),
      name: 'test',
      transport: 'stdio',
      enabled: true,
      command: 'cmd',
      argsText: 'arg1\n\n  \narg2',
      envPairs: [],
      url: '',
      headerPairs: [],
    }
    const result = draftToServerBody(draft)
    expect(result.ok).toBe(true)
    if (result.ok && result.body.transport === 'stdio') {
      expect(result.body.args).toEqual(['arg1', 'arg2'])
    }
  })

  it('filters empty key pairs from env and headers', () => {
    const draft: McpServerDraft = {
      ...emptyDraft(),
      ...emptyDraft(),
      name: 'test',
      transport: 'stdio',
      enabled: true,
      command: 'cmd',
      argsText: '',
      envPairs: [
        { key: 'KEY1', value: 'val1' },
        { key: '', value: 'orphan' },
        { key: 'KEY2', value: 'val2' },
      ],
      url: '',
      headerPairs: [],
    }
    const result = draftToServerBody(draft)
    expect(result.ok).toBe(true)
    if (result.ok && result.body.transport === 'stdio') {
      expect(result.body.env).toEqual({
        KEY1: 'val1',
        KEY2: 'val2',
      })
    }
  })

  it('does not leak stdio fields into http body', () => {
    const draft: McpServerDraft = {
      ...emptyDraft(),
      ...emptyDraft(),
      name: 'test',
      transport: 'http',
      enabled: true,
      command: 'should-not-appear',
      argsText: 'should-not-appear',
      envPairs: [{ key: 'SHOULD_NOT', value: 'appear' }],
      url: 'https://example.com',
      headerPairs: [],
    }
    const result = draftToServerBody(draft)
    expect(result.ok).toBe(true)
    if (result.ok) {
      const body = result.body as Record<string, unknown>
      expect(body.command).toBeUndefined()
      expect(body.args).toBeUndefined()
      expect(body.env).toBeUndefined()
    }
  })

  it('does not leak http fields into stdio body', () => {
    const draft: McpServerDraft = {
      ...emptyDraft(),
      ...emptyDraft(),
      name: 'test',
      transport: 'stdio',
      enabled: true,
      command: 'cmd',
      argsText: '',
      envPairs: [],
      url: 'should-not-appear',
      headerPairs: [{ key: 'SHOULD_NOT', value: 'appear' }],
    }
    const result = draftToServerBody(draft)
    expect(result.ok).toBe(true)
    if (result.ok) {
      const body = result.body as Record<string, unknown>
      expect(body.url).toBeUndefined()
      expect(body.headers).toBeUndefined()
    }
  })
})

// ── validateDraft ────────────────────────────────────────────────────────────

describe('validateDraft', () => {
  it('returns null for a valid new stdio draft', () => {
    const draft: McpServerDraft = {
      ...emptyDraft(),
      ...emptyDraft(),
      name: 'filesystem',
      transport: 'stdio',
      enabled: true,
      command: 'npx',
      argsText: 'arg1\narg2',
      envPairs: [{ key: 'KEY', value: 'val' }],
      url: '',
      headerPairs: [],
    }
    const errors = validateDraft(draft, { isNew: true })
    expect(errors).toBeNull()
  })

  it('returns null for a valid new http draft', () => {
    const draft: McpServerDraft = {
      ...emptyDraft(),
      ...emptyDraft(),
      name: 'remote',
      transport: 'http',
      enabled: true,
      command: '',
      argsText: '',
      envPairs: [],
      url: 'https://example.com',
      headerPairs: [{ key: 'Auth', value: 'token' }],
    }
    const errors = validateDraft(draft, { isNew: true })
    expect(errors).toBeNull()
  })

  it('requires name for new drafts', () => {
    const draft: McpServerDraft = {
      ...emptyDraft(),
      ...emptyDraft(),
      name: '',
      transport: 'stdio',
      enabled: true,
      command: 'cmd',
      argsText: '',
      envPairs: [],
      url: '',
      headerPairs: [],
    }
    const errors = validateDraft(draft, { isNew: true })
    expect(errors).toBeTruthy()
    expect(errors?.name).toContain('Name is required')
  })

  it('validates name format matches SERVER_NAME_REGEX', () => {
    const invalidNames = ['123start', '-start', '_start', 'has space', 'has@symbol']
    for (const name of invalidNames) {
      const draft: McpServerDraft = {
        ...emptyDraft(),
        name,
        transport: 'stdio',
        enabled: true,
        command: 'cmd',
        argsText: '',
        envPairs: [],
        url: '',
        headerPairs: [],
      }
      const errors = validateDraft(draft, { isNew: true })
      expect(errors?.name).toBeTruthy()
    }
  })

  it('accepts valid names matching SERVER_NAME_REGEX', () => {
    const validNames = ['filesystem', 'my_server', 'my-server', 'MyServer123']
    for (const name of validNames) {
      const draft: McpServerDraft = {
        ...emptyDraft(),
        name,
        transport: 'stdio',
        enabled: true,
        command: 'cmd',
        argsText: '',
        envPairs: [],
        url: '',
        headerPairs: [],
      }
      const errors = validateDraft(draft, { isNew: true })
      expect(errors?.name).toBeUndefined()
    }
  })

  it('does not require name for existing drafts (isNew=false)', () => {
    const draft: McpServerDraft = {
      ...emptyDraft(),
      ...emptyDraft(),
      name: '',
      transport: 'stdio',
      enabled: true,
      command: 'cmd',
      argsText: '',
      envPairs: [],
      url: '',
      headerPairs: [],
    }
    const errors = validateDraft(draft, { isNew: false })
    expect(errors?.name).toBeUndefined()
  })

  it('requires command for stdio transport', () => {
    const draft: McpServerDraft = {
      ...emptyDraft(),
      ...emptyDraft(),
      name: 'test',
      transport: 'stdio',
      enabled: true,
      command: '',
      argsText: '',
      envPairs: [],
      url: '',
      headerPairs: [],
    }
    const errors = validateDraft(draft, { isNew: true })
    expect(errors?.command).toContain('Command is required')
  })

  it('requires url for http transport', () => {
    const draft: McpServerDraft = {
      ...emptyDraft(),
      ...emptyDraft(),
      name: 'test',
      transport: 'http',
      enabled: true,
      command: '',
      argsText: '',
      envPairs: [],
      url: '',
      headerPairs: [],
    }
    const errors = validateDraft(draft, { isNew: true })
    expect(errors?.url).toContain('URL is required')
  })

  it('detects duplicate env keys', () => {
    const draft: McpServerDraft = {
      ...emptyDraft(),
      ...emptyDraft(),
      name: 'test',
      transport: 'stdio',
      enabled: true,
      command: 'cmd',
      argsText: '',
      envPairs: [
        { key: 'KEY', value: 'val1' },
        { key: 'KEY', value: 'val2' },
      ],
      url: '',
      headerPairs: [],
    }
    const errors = validateDraft(draft, { isNew: true })
    expect(errors?.env).toContain('Duplicate environment variable: KEY')
  })

  it('detects duplicate header keys', () => {
    const draft: McpServerDraft = {
      ...emptyDraft(),
      ...emptyDraft(),
      name: 'test',
      transport: 'http',
      enabled: true,
      command: '',
      argsText: '',
      envPairs: [],
      url: 'https://example.com',
      headerPairs: [
        { key: 'X-Custom', value: 'val1' },
        { key: 'X-Custom', value: 'val2' },
      ],
    }
    const errors = validateDraft(draft, { isNew: true })
    expect(errors?.headers).toContain('Duplicate header: X-Custom')
  })

  it('ignores empty keys when checking for duplicates', () => {
    const draft: McpServerDraft = {
      ...emptyDraft(),
      ...emptyDraft(),
      name: 'test',
      transport: 'stdio',
      enabled: true,
      command: 'cmd',
      argsText: '',
      envPairs: [
        { key: '', value: 'val1' },
        { key: '', value: 'val2' },
      ],
      url: '',
      headerPairs: [],
    }
    const errors = validateDraft(draft, { isNew: true })
    expect(errors?.env).toBeUndefined()
  })
})

// ── draftEquals ──────────────────────────────────────────────────────────────

describe('draftEquals', () => {
  it('returns true for identical drafts', () => {
    const draft: McpServerDraft = {
      ...emptyDraft(),
      name: 'test',
      transport: 'stdio',
      enabled: true,
      command: 'cmd',
      argsText: 'arg1\narg2',
      envPairs: [{ key: 'KEY', value: 'val' }],
      url: '',
      headerPairs: [],
    }
    expect(draftEquals(draft, draft)).toBe(true)
  })

  it('returns true for structurally equal drafts', () => {
    const draft1: McpServerDraft = {
      ...emptyDraft(),
      name: 'test',
      transport: 'stdio',
      enabled: true,
      command: 'cmd',
      argsText: 'arg1',
      envPairs: [{ key: 'KEY', value: 'val' }],
      url: '',
      headerPairs: [],
    }
    const draft2: McpServerDraft = {
      ...emptyDraft(),
      name: 'test',
      transport: 'stdio',
      enabled: true,
      command: 'cmd',
      argsText: 'arg1',
      envPairs: [{ key: 'KEY', value: 'val' }],
      url: '',
      headerPairs: [],
    }
    expect(draftEquals(draft1, draft2)).toBe(true)
  })

  it('returns false when name differs', () => {
    const draft1: McpServerDraft = {
      ...emptyDraft(),
      name: 'test1',
      transport: 'stdio',
      enabled: true,
      command: 'cmd',
      argsText: '',
      envPairs: [],
      url: '',
      headerPairs: [],
    }
    const draft2: McpServerDraft = {
      ...emptyDraft(),
      name: 'test2',
      transport: 'stdio',
      enabled: true,
      command: 'cmd',
      argsText: '',
      envPairs: [],
      url: '',
      headerPairs: [],
    }
    expect(draftEquals(draft1, draft2)).toBe(false)
  })

  it('returns false when transport differs', () => {
    const draft1: McpServerDraft = {
      ...emptyDraft(),
      name: 'test',
      transport: 'stdio',
      enabled: true,
      command: 'cmd',
      argsText: '',
      envPairs: [],
      url: '',
      headerPairs: [],
    }
    const draft2: McpServerDraft = {
      ...emptyDraft(),
      name: 'test',
      transport: 'http',
      enabled: true,
      command: '',
      argsText: '',
      envPairs: [],
      url: 'https://example.com',
      headerPairs: [],
    }
    expect(draftEquals(draft1, draft2)).toBe(false)
  })

  it('returns false when enabled differs', () => {
    const draft1: McpServerDraft = {
      ...emptyDraft(),
      name: 'test',
      transport: 'stdio',
      enabled: true,
      command: 'cmd',
      argsText: '',
      envPairs: [],
      url: '',
      headerPairs: [],
    }
    const draft2: McpServerDraft = {
      ...emptyDraft(),
      name: 'test',
      transport: 'stdio',
      enabled: false,
      command: 'cmd',
      argsText: '',
      envPairs: [],
      url: '',
      headerPairs: [],
    }
    expect(draftEquals(draft1, draft2)).toBe(false)
  })

  it('returns false when stdio command differs', () => {
    const draft1: McpServerDraft = {
      ...emptyDraft(),
      name: 'test',
      transport: 'stdio',
      enabled: true,
      command: 'cmd1',
      argsText: '',
      envPairs: [],
      url: '',
      headerPairs: [],
    }
    const draft2: McpServerDraft = {
      ...emptyDraft(),
      name: 'test',
      transport: 'stdio',
      enabled: true,
      command: 'cmd2',
      argsText: '',
      envPairs: [],
      url: '',
      headerPairs: [],
    }
    expect(draftEquals(draft1, draft2)).toBe(false)
  })

  it('returns false when stdio argsText differs', () => {
    const draft1: McpServerDraft = {
      ...emptyDraft(),
      name: 'test',
      transport: 'stdio',
      enabled: true,
      command: 'cmd',
      argsText: 'arg1',
      envPairs: [],
      url: '',
      headerPairs: [],
    }
    const draft2: McpServerDraft = {
      ...emptyDraft(),
      name: 'test',
      transport: 'stdio',
      enabled: true,
      command: 'cmd',
      argsText: 'arg2',
      envPairs: [],
      url: '',
      headerPairs: [],
    }
    expect(draftEquals(draft1, draft2)).toBe(false)
  })

  it('returns false when stdio envPairs differ', () => {
    const draft1: McpServerDraft = {
      ...emptyDraft(),
      name: 'test',
      transport: 'stdio',
      enabled: true,
      command: 'cmd',
      argsText: '',
      envPairs: [{ key: 'KEY1', value: 'val1' }],
      url: '',
      headerPairs: [],
    }
    const draft2: McpServerDraft = {
      ...emptyDraft(),
      name: 'test',
      transport: 'stdio',
      enabled: true,
      command: 'cmd',
      argsText: '',
      envPairs: [{ key: 'KEY2', value: 'val2' }],
      url: '',
      headerPairs: [],
    }
    expect(draftEquals(draft1, draft2)).toBe(false)
  })

  it('returns false when http url differs', () => {
    const draft1: McpServerDraft = {
      ...emptyDraft(),
      name: 'test',
      transport: 'http',
      enabled: true,
      command: '',
      argsText: '',
      envPairs: [],
      url: 'https://example1.com',
      headerPairs: [],
    }
    const draft2: McpServerDraft = {
      ...emptyDraft(),
      name: 'test',
      transport: 'http',
      enabled: true,
      command: '',
      argsText: '',
      envPairs: [],
      url: 'https://example2.com',
      headerPairs: [],
    }
    expect(draftEquals(draft1, draft2)).toBe(false)
  })

  it('returns false when http headerPairs differ', () => {
    const draft1: McpServerDraft = {
      ...emptyDraft(),
      name: 'test',
      transport: 'http',
      enabled: true,
      command: '',
      argsText: '',
      envPairs: [],
      url: 'https://example.com',
      headerPairs: [{ key: 'Auth', value: 'token1' }],
    }
    const draft2: McpServerDraft = {
      ...emptyDraft(),
      name: 'test',
      transport: 'http',
      enabled: true,
      command: '',
      argsText: '',
      envPairs: [],
      url: 'https://example.com',
      headerPairs: [{ key: 'Auth', value: 'token2' }],
    }
    expect(draftEquals(draft1, draft2)).toBe(false)
  })
})

// ── SERVER_NAME_REGEX ────────────────────────────────────────────────────────

describe('SERVER_NAME_REGEX', () => {
  it('matches valid server names', () => {
    const validNames = [
      'a',
      'A',
      'filesystem',
      'my_server',
      'my-server',
      'MyServer123',
      'a1b2c3',
      'a_b-c',
    ]
    for (const name of validNames) {
      expect(SERVER_NAME_REGEX.test(name)).toBe(true)
    }
  })

  it('rejects names starting with digits', () => {
    expect(SERVER_NAME_REGEX.test('1server')).toBe(false)
  })

  it('rejects names starting with underscore', () => {
    expect(SERVER_NAME_REGEX.test('_server')).toBe(false)
  })

  it('rejects names starting with hyphen', () => {
    expect(SERVER_NAME_REGEX.test('-server')).toBe(false)
  })

  it('rejects names with spaces', () => {
    expect(SERVER_NAME_REGEX.test('my server')).toBe(false)
  })

  it('rejects names with special characters', () => {
    expect(SERVER_NAME_REGEX.test('my@server')).toBe(false)
    expect(SERVER_NAME_REGEX.test('my.server')).toBe(false)
    expect(SERVER_NAME_REGEX.test('my/server')).toBe(false)
  })

  it('rejects empty string', () => {
    expect(SERVER_NAME_REGEX.test('')).toBe(false)
  })
})

describe('tool timeout', () => {
  const body: ServerBody = { transport: 'stdio', command: 'npx', args: [], env: {}, enabled: true, timeout: 120 }

  it('round-trips through the draft', () => {
    const draft = draftFromServerBody('fs', body)
    expect(draft.timeoutText).toBe('120')
    const out = draftToServerBody(draft)
    expect(out.ok && out.body.timeout).toBe(120)
  })

  it('is omitted when empty', () => {
    const out = draftToServerBody({ ...draftFromServerBody('fs', body), timeoutText: '' })
    expect(out.ok && 'timeout' in out.body).toBe(false)
  })

  it('rejects values outside 1–270', () => {
    for (const bad of ['0', '271', '1.5', 'abc']) {
      expect(validateDraft({ ...draftFromServerBody('fs', body), timeoutText: bad }, { isNew: false })?.timeout).toBeDefined()
    }
    expect(validateDraft({ ...draftFromServerBody('fs', body), timeoutText: '270' }, { isNew: false })).toBeNull()
  })

  it('counts towards dirty state', () => {
    const a = draftFromServerBody('fs', body)
    expect(draftEquals(a, { ...a, timeoutText: '60' })).toBe(false)
  })
})
