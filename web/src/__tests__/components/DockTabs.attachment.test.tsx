/**
 * Attachment tabs: a shell request opens the attachment as a dock tab, and
 * asking again for the same upload focuses that tab instead of adding one.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { cleanup, renderHook } from '@testing-library/react'
import { _resetTerminalStoreForTests } from '@/stores/useTerminalStore'
import { _resetKeyboardForTests } from '@/lib/keyboard/dispatcher'
import { useDockTabs } from '@/components/WorkspacePanel/useDockTabs'
import { attachmentTabId, dockTabLabel, type AttachmentTabRequest } from '@/components/WorkspacePanel/dock-tabs'
import type { FileLightboxItem } from '@/components/FileLightbox'

const pdf: FileLightboxItem = { type: 'pdf', src: '/api/agent/s1/uploads/a.pdf', name: 'a.pdf' }
const png: FileLightboxItem = { type: 'image', src: '/api/agent/s1/uploads/b.png', name: 'b.png' }

beforeEach(() => {
  _resetKeyboardForTests()
  _resetTerminalStoreForTests()
})
afterEach(cleanup)

function renderTabs() {
  return renderHook(({ attachmentRequest }: { attachmentRequest: AttachmentTabRequest | null }) => useDockTabs({
    workspace: '/w',
    chatWorkspace: false,
    terminalOpenKey: 0,
    viewRequest: null,
    attachmentRequest,
  }), { initialProps: { attachmentRequest: null as AttachmentTabRequest | null } })
}

describe('dock attachment tabs', () => {
  it('opens an attachment as the active tab', () => {
    const { result, rerender } = renderTabs()
    rerender({ attachmentRequest: { item: pdf, key: 1 } })

    expect(result.current.activeTab?.type).toBe('attachment')
    expect(result.current.activeTabId).toBe(attachmentTabId(pdf.src))
    expect(dockTabLabel(result.current.activeTab!)).toBe('Attachment a.pdf')
  })

  it('focuses the open tab when the same attachment is opened again', () => {
    const { result, rerender } = renderTabs()
    rerender({ attachmentRequest: { item: pdf, key: 1 } })
    rerender({ attachmentRequest: { item: png, key: 2 } })
    rerender({ attachmentRequest: { item: pdf, key: 3 } })

    expect(result.current.visibleTabs.map((tab) => tab.id)).toEqual([attachmentTabId(pdf.src), attachmentTabId(png.src)])
    expect(result.current.activeTabId).toBe(attachmentTabId(pdf.src))
  })
})
