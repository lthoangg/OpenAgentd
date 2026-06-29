import { describe, it, expect } from 'bun:test'
import {
  splitFrontmatter,
  buildFrontmatter,
  combine,
  contentEquals,
} from '@/components/settings/frontmatter'

describe('splitFrontmatter', () => {
  it('returns empty fm when no --- delimiter', () => {
    const { fm, body } = splitFrontmatter('plain body\nwith lines')
    expect(fm).toBe('')
    expect(body).toBe('plain body\nwith lines')
  })

  it('extracts fm and body', () => {
    const raw = '---\nname: alpha\nrole: lead\n---\n\nbody text\n'
    const { fm, body } = splitFrontmatter(raw)
    expect(fm).toContain('name: alpha')
    expect(fm).toContain('role: lead')
    expect(body).toBe('body text\n')
  })

  it('handles CRLF line endings', () => {
    const raw = '---\r\nname: x\r\n---\r\nbody\r\n'
    const { fm, body } = splitFrontmatter(raw)
    expect(fm).toContain('name: x')
    expect(body).toContain('body')
  })
})

describe('buildFrontmatter', () => {
  it('emits required fields', () => {
    const out = buildFrontmatter({ name: 'alpha', role: 'lead' })
    expect(out).toBe('name: alpha\nrole: lead')
  })

  it('omits unset optional fields', () => {
    const out = buildFrontmatter({
      name: 'alpha',
      role: 'lead',
      description: null,
      model: null,
    })
    expect(out).not.toContain('description')
    expect(out).not.toContain('model')
  })

  it('emits tools and mcp servers as bullet lists', () => {
    const out = buildFrontmatter({
      name: 'a',
      role: 'member',
      tools: ['date', 'read'],
      mcp: ['example-skill'],
    })
    expect(out).toContain('tools:\n  - date\n  - read')
    expect(out).toContain('mcp:\n  - example-skill')
  })

  it('sorts tools and mcp servers alphabetically — order is not semantic', () => {
    const out = buildFrontmatter({
      name: 'a',
      role: 'member',
      tools: ['shell', 'date', 'read'],
      mcp: ['example-skill', 'lightpanda'],
    })
    // Sorted alphabetically regardless of input order.
    expect(out).toContain('tools:\n  - date\n  - read\n  - shell')
    expect(out).toContain('mcp:\n  - example-skill\n  - lightpanda')
  })

  it('produces identical output for reordered input', () => {
    const a = buildFrontmatter({
      name: 'x',
      role: 'member',
      tools: ['shell', 'date', 'read'],
      mcp: ['b', 'a'],
    })
    const b = buildFrontmatter({
      name: 'x',
      role: 'member',
      tools: ['read', 'shell', 'date'],
      mcp: ['a', 'b'],
    })
    expect(a).toBe(b)
  })

  it('quotes descriptions with colons', () => {
    const out = buildFrontmatter({
      name: 'a',
      role: 'member',
      description: 'Handles auth: logins and signups',
    })
    expect(out).toContain('description: "Handles auth: logins and signups"')
  })

  it('quotes reserved YAML scalars', () => {
    const out = buildFrontmatter({
      name: 'a',
      role: 'member',
      description: 'true',
    })
    expect(out).toContain('description: "true"')
  })
})

describe('combine', () => {
  it('produces a full .md file', () => {
    const file = combine({ name: 'alpha', role: 'lead' }, 'You are alpha.')
    expect(file.startsWith('---\n')).toBe(true)
    expect(file).toContain('name: alpha')
    expect(file).toContain('role: lead')
    expect(file.endsWith('You are alpha.\n')).toBe(true)
  })

  it('trims extra whitespace in body', () => {
    const file = combine({ name: 'a', role: 'member' }, '\n\n  body  \n\n')
    expect(file).toContain('\n\nbody\n')
  })
})

describe('contentEquals', () => {
  it('returns true for byte-identical input', () => {
    const raw = '---\nname: a\nrole: lead\n---\n\nbody\n'
    expect(contentEquals(raw, raw)).toBe(true)
  })

  it('ignores tools list ordering', () => {
    const a = '---\nname: a\nrole: lead\ntools:\n  - date\n  - shell\n  - ls\n  - read\n  - write\n---\n\nbody\n'
    const b = '---\nname: a\nrole: lead\ntools:\n  - date\n  - ls\n  - read\n  - shell\n  - write\n---\n\nbody\n'
    expect(contentEquals(a, b)).toBe(true)
  })

  it('ignores mcp list ordering', () => {
    const a = '---\nname: a\nrole: member\nmcp:\n  - b\n  - a\n---\n\nbody\n'
    const b = '---\nname: a\nrole: member\nmcp:\n  - a\n  - b\n---\n\nbody\n'
    expect(contentEquals(a, b)).toBe(true)
  })

  it('detects tool-set changes', () => {
    const a = '---\nname: a\nrole: lead\ntools:\n  - date\n  - shell\n---\n\nbody\n'
    const b = '---\nname: a\nrole: lead\ntools:\n  - date\n---\n\nbody\n'
    expect(contentEquals(a, b)).toBe(false)
  })

  it('detects scalar changes', () => {
    const a = '---\nname: a\nrole: lead\nmodel: x\n---\n\nbody\n'
    const b = '---\nname: a\nrole: lead\nmodel: y\n---\n\nbody\n'
    expect(contentEquals(a, b)).toBe(false)
  })

  it('tolerates body trailing whitespace differences', () => {
    const a = '---\nname: a\nrole: lead\n---\n\nbody\n'
    const b = '---\nname: a\nrole: lead\n---\n\nbody\n\n\n'
    expect(contentEquals(a, b)).toBe(true)
  })

  it('detects body changes', () => {
    const a = '---\nname: a\nrole: lead\n---\n\nbody one\n'
    const b = '---\nname: a\nrole: lead\n---\n\nbody two\n'
    expect(contentEquals(a, b)).toBe(false)
  })

  it('round-trips toggle: remove tool then add back', () => {
    // Disk content: user's authoring order.
    const onDisk =
      '---\nname: orchestrator\nrole: lead\nmodel: openai:gpt-5.4\ntools:\n  - date\n  - shell\n  - ls\n  - read\n  - write\n---\n\nYou are the lead.\n'
    // Form re-emits sorted.  Different order, same set.
    const reemitted =
      '---\nname: orchestrator\nrole: lead\nmodel: openai:gpt-5.4\ntools:\n  - date\n  - ls\n  - read\n  - shell\n  - write\n---\n\nYou are the lead.\n'
    expect(contentEquals(onDisk, reemitted)).toBe(true)
  })
})
