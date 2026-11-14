import { afterEach, describe, expect, it } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { WorktreeFields, defaultWorktreeBranch } from '@/components/Sidebar/WorktreeFields'

afterEach(cleanup)

function Harness({ onChange }: { onChange?: (name: string, branch: string) => void }) {
  const [name, setName] = useState('')
  const [branch, setBranch] = useState('')
  onChange?.(name, branch)
  return <WorktreeFields name={name} branch={branch} onNameChange={setName} onBranchChange={setBranch} />
}

describe('defaultWorktreeBranch', () => {
  it('is the name as the server slugs it, under openagentd/', () => {
    expect(defaultWorktreeBranch('Feature Login!')).toBe('openagentd/feature-login')
    expect(defaultWorktreeBranch('  fix/api_v2  ')).toBe('openagentd/fix-api-v2')
  })

  it('uses "session" for an empty name', () => {
    expect(defaultWorktreeBranch('')).toBe('openagentd/session')
    expect(defaultWorktreeBranch('---')).toBe('openagentd/session')
  })
})

describe('WorktreeFields', () => {
  it('asks for one name and shows the branch it gives', () => {
    render(<Harness />)
    expect(screen.getAllByRole('textbox')).toHaveLength(1)
    expect(screen.getByText('openagentd/session')).toBeTruthy()

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'feature-login' } })
    expect(screen.getByText('openagentd/feature-login')).toBeTruthy()
  })

  it('"Change" opens the branch field on the branch shown, and what is typed there is sent', () => {
    let last = { name: '', branch: '' }
    render(<Harness onChange={(name, branch) => { last = { name, branch } }} />)
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'feature-login' } })
    // Left alone, the branch is the server's to derive.
    expect(last).toEqual({ name: 'feature-login', branch: '' })

    fireEvent.click(screen.getByRole('button', { name: 'Change' }))
    const branch = screen.getByLabelText('Branch') as HTMLInputElement
    expect(branch.value).toBe('openagentd/feature-login')
    expect(screen.queryByRole('button', { name: 'Change' })).toBeNull()

    fireEvent.change(branch, { target: { value: 'fix/login' } })
    expect(last).toEqual({ name: 'feature-login', branch: 'fix/login' })
  })
})
