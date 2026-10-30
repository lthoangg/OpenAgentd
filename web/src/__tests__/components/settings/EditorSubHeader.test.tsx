import { afterEach, describe, expect, it } from 'bun:test'
import { cleanup, render, screen } from '@testing-library/react'

import { EditorSubHeader } from '@/components/settings/EditorSubHeader'

afterEach(cleanup)

function renderHeader() {
  return render(
    <EditorSubHeader
      name="code-reviewer"
      path="~/.openagentd/agents/code-reviewer.md"
      kind="agent"
      dirty
      invalid={false}
      saving={false}
      mode="form"
      onModeChange={() => {}}
      onSave={() => {}}
      onBack={() => {}}
    />,
  )
}

describe('EditorSubHeader — phone layout', () => {
  it('moves the Form/Source switch to its own row below sm, leaving the name the width', () => {
    const { container } = renderHeader()
    const header = container.querySelector('header') as HTMLElement
    expect(header.className).toContain('max-sm:flex-wrap')
    const tabs = screen.getByRole('tab', { name: 'Form' }).closest('[data-editor-mode]') as HTMLElement
    expect(tabs.className).toContain('max-sm:order-last')
    expect(tabs.className).toContain('max-sm:w-full')
  })

  it('keeps Save named while its label is hidden below sm', () => {
    renderHeader()
    const save = screen.getByRole('button', { name: 'Save' })
    expect(save.querySelector('.max-sm\\:sr-only')?.textContent).toBe('Save')
  })
})
