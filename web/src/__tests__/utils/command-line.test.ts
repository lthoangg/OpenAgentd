import { describe, expect, it } from 'bun:test'

import { commandLine } from '@/utils/command-line'

describe('commandLine', () => {
  it('joins a program and its arguments with spaces', () => {
    expect(commandLine('npx', ['-y', '@example/github-mcp'])).toBe('npx -y @example/github-mcp')
  })

  it('shows a program with no arguments as itself', () => {
    expect(commandLine('uvx')).toBe('uvx')
    expect(commandLine('uvx', [])).toBe('uvx')
  })

  it('leaves flags, paths, versions and key=value words as they are', () => {
    expect(commandLine('/usr/local/bin/node', ['server.js', '--port=8080', '--root', './src', 'pkg@1.2.3', 'a,b:c+d%e'])).toBe(
      '/usr/local/bin/node server.js --port=8080 --root ./src pkg@1.2.3 a,b:c+d%e',
    )
  })

  it('single-quotes a word with a space, so each argument can be told apart', () => {
    expect(commandLine('node', ['server.js', '--title', 'Release notes'])).toBe("node server.js --title 'Release notes'")
  })

  it('quotes an empty argument, which would otherwise vanish', () => {
    expect(commandLine('tool', ['', 'x'])).toBe("tool '' x")
  })

  it('quotes shell characters, and escapes a quote inside a quoted word', () => {
    expect(commandLine('sh', ['-c', 'echo $HOME && ls'])).toBe("sh -c 'echo $HOME && ls'")
    expect(commandLine('say', ["it's"])).toBe("say 'it'\\''s'")
  })

  it('quotes the program too when its path has a space', () => {
    expect(commandLine('/Applications/My Tool/bin/tool', ['run'])).toBe("'/Applications/My Tool/bin/tool' run")
  })
})
