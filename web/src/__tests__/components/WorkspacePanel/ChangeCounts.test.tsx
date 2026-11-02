/**
 * The `+N -N A` trailer on changed-file rows and diff toolbars.
 */
import { afterEach, describe, expect, it } from 'bun:test'
import { cleanup, render, screen } from '@testing-library/react'

import { ChangeCounts } from '@/components/WorkspacePanel/ChangeCounts'
import type { ChangedFileInfo } from '@/components/WorkspacePanel/diff-helpers'

afterEach(cleanup)

function letterTone(status: ChangedFileInfo['status']): string {
  render(<ChangeCounts file={{ path: 'a.ts', status, additions: 1, deletions: 1 } as ChangedFileInfo} />)
  const letter = screen.getByText(status)
  return (letter.parentElement as HTMLElement).className
}

describe('ChangeCounts', () => {
  // Every letter was orange, so an added file read as modified.
  it('colors Added like its added lines', () => {
    expect(letterTone('A')).toContain('text-(--color-diff-add-text)')
  })

  it('colors Deleted like its removed lines', () => {
    expect(letterTone('D')).toContain('text-(--color-diff-del-text)')
  })

  it('keeps Modified orange', () => {
    expect(letterTone('M')).toContain('text-(--accent-orange-text)')
  })
})
