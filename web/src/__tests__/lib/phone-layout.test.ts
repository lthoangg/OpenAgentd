/**
 * Phone-width layout contracts from the 320/375px audit. happy-dom has no
 * layout, so these guard the class strings that keep names, paths and
 * toolbars readable on a narrow screen.
 */
import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const src = (rel: string) => readFileSync(fileURLToPath(new URL(`../../components/${rel}`, import.meta.url)), 'utf8')

describe('phone layout contracts', () => {
  it('hides the command palette key hints below md', () => {
    expect(src('CommandPalette.tsx')).toMatch(/data-palette-hints="" className="hidden [^"]*md:flex"/)
  })

  it('puts first-run provider picks in one column under 360px', () => {
    expect(src('NewSession/ModelSetupCard.tsx')).toContain('grid grid-cols-1 gap-1.5 min-[360px]:grid-cols-2')
  })

  it('wraps telemetry span values on phones and truncates them only from md', () => {
    expect(src('Telemetry/SpanDetailPanel.tsx')).toMatch(/<dd className="[^"]*\[overflow-wrap:anywhere\][^"]*md:truncate"/)
  })

  it('wraps the subagent banner on phones instead of truncating its sentence', () => {
    const view = src('AgentChatView/index.tsx')
    expect(view).toMatch(/data-subagent-banner="" className="flex flex-wrap [^"]*sm:flex-nowrap"/)
    expect(view).toContain('<span className="sm:truncate">The main agent directs this subagent.')
  })

  it('keeps long paths and workspace names inside their cards', () => {
    expect(src('AgentChatView/MissingFolderBanner.tsx')).toContain('<span className="font-mono [overflow-wrap:anywhere]">{workspace}</span>')
    expect(src('AgentView/UserBubble.tsx')).toMatch(/className="min-w-0 max-w-\[60%\] shrink-0 truncate font-mono[^"]*">\{source\.workspaceName\}/)
  })

  it('gives team member output no scroller of its own on phones', () => {
    expect(src('ToolResult.tsx')).toContain('data-team-member-output="" className="text-xs md:max-h-48 md:overflow-y-auto"')
  })

  it('keeps phone action-sheet titles clear of the close button', () => {
    expect(src('Sidebar.tsx').match(/<DialogHeader className="pr-8">/g)?.length).toBeGreaterThanOrEqual(2)
  })
})
