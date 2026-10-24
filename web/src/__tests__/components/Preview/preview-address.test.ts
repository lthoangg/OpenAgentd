import { describe, expect, it } from 'bun:test'

import { parseAddress } from '@/components/Preview/preview-address'

const WS = '/Users/me/project'

describe('parseAddress', () => {
  it('ignores an empty address', () => {
    expect(parseAddress('   ', WS)).toBeNull()
  })

  it('reads a rooted path as a page on the tab’s own server', () => {
    expect(parseAddress('/pricing?plan=pro#faq', WS)).toEqual({ kind: 'page', path: '/pricing?plan=pro#faq' })
  })

  it('reads addresses with a scheme, a port or a loopback host as URLs', () => {
    for (const url of ['http://localhost:5173/a', 'https://127.0.0.1:8443', 'localhost:3000', 'localhost', '127.0.0.1:8080/x', '[::1]:3000']) {
      expect(parseAddress(url, WS)).toEqual({ kind: 'url', url })
    }
  })

  it('reads anything else as a workspace-relative file', () => {
    expect(parseAddress('web/.preview/index.html', WS)).toEqual({ kind: 'file', path: 'web/.preview/index.html' })
    expect(parseAddress('./docs/mockup.html', WS)).toEqual({ kind: 'file', path: 'docs/mockup.html' })
    expect(parseAddress('.agents/plans/x/mockup.html', WS)).toEqual({ kind: 'file', path: '.agents/plans/x/mockup.html' })
    expect(parseAddress('index.html', WS)).toEqual({ kind: 'file', path: 'index.html' })
  })

  it('turns a full path inside the workspace into a file, keeping the path as a fallback', () => {
    expect(parseAddress(`${WS}/docs/a.html`, WS)).toEqual({ kind: 'file', path: 'docs/a.html', fallback: `${WS}/docs/a.html` })
    expect(parseAddress(`${WS}/docs/a.html`, `${WS}/`)).toEqual({ kind: 'file', path: 'docs/a.html', fallback: `${WS}/docs/a.html` })
    // A sibling folder that only shares the prefix is not inside the workspace.
    expect(parseAddress(`${WS}-old/a.html`, WS)).toEqual({ kind: 'page', path: `${WS}-old/a.html` })
  })

  it('turns a file:// link inside the workspace into a file', () => {
    expect(parseAddress(`file://${WS}/docs/my%20page.html`, WS)).toEqual({ kind: 'file', path: 'docs/my page.html' })
    expect(parseAddress('file:///etc/hosts', WS)).toEqual({ kind: 'invalid', message: "'/etc/hosts' is outside the workspace." })
  })

  it('understands Windows paths', () => {
    const ws = 'C:\\Users\\me\\project'
    expect(parseAddress('C:\\Users\\me\\project\\docs\\a.html', ws)).toEqual({ kind: 'file', path: 'docs/a.html' })
    expect(parseAddress('file:///C:/Users/me/project/docs/a.html', ws)).toEqual({ kind: 'file', path: 'docs/a.html' })
  })
})
