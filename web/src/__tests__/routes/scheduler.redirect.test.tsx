/**
 * /scheduler is a deep-link shim: it asks the chat view to open the
 * scheduler on the linked task, then replaces the URL with the app.
 */
import { afterEach, describe, expect, it, mock } from 'bun:test'
import { cleanup, render } from '@testing-library/react'

const navigate = mock(() => Promise.resolve())
let search: Record<string, unknown> = {}
mock.module('@tanstack/react-router', () => ({
  useNavigate: () => navigate,
  useSearch: () => search,
}))

import { SchedulerPage } from '@/routes/scheduler'
import { useUIStore } from '@/stores/useUIStore'

afterEach(() => {
  cleanup()
  navigate.mockClear()
  search = {}
  useUIStore.setState({ schedulerOpenPending: false, scheduledTaskFocus: null })
})

describe('/scheduler', () => {
  it('asks for the scheduler on the linked task, then goes to /', () => {
    search = { task: 'task-3' }
    render(<SchedulerPage />)

    expect(useUIStore.getState()).toMatchObject({ schedulerOpenPending: true, scheduledTaskFocus: 'task-3' })
    expect(navigate).toHaveBeenCalledWith({ to: '/', replace: true })
  })

  it('opens the scheduler without a task focus when none is linked', () => {
    render(<SchedulerPage />)

    expect(useUIStore.getState()).toMatchObject({ schedulerOpenPending: true, scheduledTaskFocus: null })
  })
})
