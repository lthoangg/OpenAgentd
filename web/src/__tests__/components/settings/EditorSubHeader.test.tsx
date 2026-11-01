import { afterEach, describe, expect, it } from 'bun:test'
import { cleanup, render, screen } from '@testing-library/react'

import { EditorSubHeader } from '@/components/settings/EditorSubHeader'

afterEach(cleanup)

function renderHeader(props: Partial<Parameters<typeof EditorSubHeader>[0]> = {}) {
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
      onBack={() => {}}
      {...props}
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

})

describe('EditorSubHeader — one way to save', () => {
  it('has no Save of its own: the editor saves with the SaveBar under its form', () => {
    renderHeader()
    expect(screen.queryByRole('button', { name: /save|create/i })).toBeNull()
    expect(screen.getByRole('button', { name: 'Back to list' })).toBeTruthy()
  })

  it('still says why a save failed, or what to fix', () => {
    const failed = renderHeader({ error: 'disk is full' })
    expect(screen.getByRole('alert').textContent).toContain("Couldn't save")
    expect(screen.getByRole('alert').textContent).toContain('disk is full')
    failed.unmount()

    renderHeader({ invalid: true, validationHint: 'name is required' })
    expect(screen.getByRole('alert').textContent).toContain('Fix this to save')
    expect(screen.getByRole('alert').textContent).toContain('name is required')
  })
})
