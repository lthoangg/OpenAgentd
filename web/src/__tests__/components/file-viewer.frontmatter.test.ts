import { describe, expect, it } from 'bun:test'
import { parseFrontmatter } from '@/components/file-viewer/frontmatter'

const fm = (yaml: string, body = '# Body\n') => `---\n${yaml}\n---\n${body}`

describe('parseFrontmatter', () => {
  it('returns the whole text as body when there is no frontmatter', () => {
    expect(parseFrontmatter('# Title\n\ntext')).toEqual({ fields: null, raw: null, body: '# Title\n\ntext' })
  })

  it('leaves an unclosed block alone', () => {
    const text = '---\ntitle: x\n# Body'
    expect(parseFrontmatter(text)).toEqual({ fields: null, raw: null, body: text })
  })

  it('reads plain scalars and splits the body', () => {
    const parsed = parseFrontmatter(fm('title: OpenAgentd Features\nstatus: stable\nupdated: 2026-09-10\ncount: 3'))
    expect(parsed.body).toBe('# Body\n')
    expect(parsed.raw).toBe('title: OpenAgentd Features\nstatus: stable\nupdated: 2026-09-10\ncount: 3')
    expect(parsed.fields).toEqual([
      { key: 'title', value: { kind: 'text', text: 'OpenAgentd Features' } },
      { key: 'status', value: { kind: 'text', text: 'stable' } },
      { key: 'updated', value: { kind: 'text', text: '2026-09-10' } },
      { key: 'count', value: { kind: 'text', text: '3' } },
    ])
  })

  it('keeps colons inside values and drops trailing comments', () => {
    const parsed = parseFrontmatter(fm('description: Workflow: commit it  # note\nurl: https://x.dev/a#b'))
    expect(parsed.fields).toEqual([
      { key: 'description', value: { kind: 'text', text: 'Workflow: commit it' } },
      { key: 'url', value: { kind: 'text', text: 'https://x.dev/a#b' } },
    ])
  })

  it('unquotes single and double quoted scalars', () => {
    const parsed = parseFrontmatter(fm(`a: "say \\"hi\\"" # c\nb: 'it''s'\nc: "#3F3429"`))
    expect(parsed.fields?.map((f) => f.value)).toEqual([
      { kind: 'text', text: 'say "hi"' },
      { kind: 'text', text: "it's" },
      { kind: 'text', text: '#3F3429' },
    ])
  })

  it('folds `>-` and keeps line breaks for `|`', () => {
    const parsed = parseFrontmatter(fm('description: >-\n  Warm paper\n  design.\n\n  Second.\nnotes: |\n  line one\n    indented\nname: x'))
    expect(parsed.fields).toEqual([
      { key: 'description', value: { kind: 'text', text: 'Warm paper design.\nSecond.' } },
      { key: 'notes', value: { kind: 'text', text: 'line one\n  indented' } },
      { key: 'name', value: { kind: 'text', text: 'x' } },
    ])
  })

  it('reads block and flow lists of strings', () => {
    const parsed = parseFrontmatter(fm("tools:\n  - read\n  - 'shell'\ntags:\n- a\n- b\nflow: [one, \"two, three\", four]\nempty: []"))
    expect(parsed.fields).toEqual([
      { key: 'tools', value: { kind: 'list', items: ['read', 'shell'] } },
      { key: 'tags', value: { kind: 'list', items: ['a', 'b'] } },
      { key: 'flow', value: { kind: 'list', items: ['one', 'two, three', 'four'] } },
      { key: 'empty', value: { kind: 'list', items: [] } },
    ])
  })

  it('keeps nested maps, lists of maps and flow maps as YAML source', () => {
    const parsed = parseFrontmatter(fm('colors:\n  # roles\n  primary: "#3F3429"  # Bark\n  bg: "#FAF6EC"\nitems:\n  - name: a\n    x: 1\ninline: {a: 1}\nname: x'))
    expect(parsed.fields).toEqual([
      { key: 'colors', value: { kind: 'raw', text: '# roles\nprimary: "#3F3429"  # Bark\nbg: "#FAF6EC"' } },
      { key: 'items', value: { kind: 'raw', text: '- name: a\n  x: 1' } },
      { key: 'inline', value: { kind: 'raw', text: '{a: 1}' } },
      { key: 'name', value: { kind: 'text', text: 'x' } },
    ])
  })

  it('falls back to no fields when a top-level line is not a key', () => {
    const parsed = parseFrontmatter(fm('title: x\njust some words'))
    expect(parsed.fields).toBeNull()
    expect(parsed.raw).toBe('title: x\njust some words')
    expect(parsed.body).toBe('# Body\n')
  })

  it('handles CRLF line endings and an empty value', () => {
    const parsed = parseFrontmatter('---\r\ntitle: x\r\ndraft:\r\n---\r\nBody')
    expect(parsed.fields).toEqual([
      { key: 'title', value: { kind: 'text', text: 'x' } },
      { key: 'draft', value: { kind: 'text', text: '' } },
    ])
    expect(parsed.body).toBe('Body')
  })
})
