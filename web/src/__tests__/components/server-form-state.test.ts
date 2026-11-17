import { describe, expect, it } from 'bun:test'
import { FORM_CLOSED, serverFormMachine, serverFormStep, type ServerFormEvent, type ServerFormState } from '@/components/server-form-state'
import { IllegalTransition } from '@/lib/machine'

const VALUES = { baseUrl: 'http://127.0.0.1:4082', serverName: 'Desk', accessKey: 'k' }
const OPEN_ADD: ServerFormEvent = { type: 'open', target: { kind: 'add' }, values: VALUES, scanned: true }
const OPEN_EDIT: ServerFormEvent = {
  type: 'open',
  target: { kind: 'edit', baseUrl: 'http://127.0.0.1:4082', label: 'Desk', inUse: false },
  values: VALUES,
  original: { baseUrl: 'http://127.0.0.1:4082', accessKey: '' },
}
const run = (events: ServerFormEvent[], from: ServerFormState = FORM_CLOSED) => events.reduce(serverFormStep, from)

describe('server form', () => {
  it('takes no typing while closed', () => {
    expect(() => serverFormMachine.transition(FORM_CLOSED, { type: 'input', field: 'baseUrl', value: 'x' })).toThrow(IllegalTransition)
  })

  it('drops everything it held when it closes', () => {
    const open = run([OPEN_ADD, { type: 'tested', baseUrl: VALUES.baseUrl }, { type: 'error', error: 'no' }])
    expect(run([{ type: 'close' }], open)).toEqual(FORM_CLOSED)
    expect(run([{ type: 'close' }, { type: 'open', target: { kind: 'add' }, values: VALUES }], open)).toMatchObject({
      scanned: false, tested: null, error: null, original: null,
    })
  })

  it('drops a test reply or a key read that lands after it closed', () => {
    expect(run([{ type: 'tested', baseUrl: 'x' }, { type: 'error', error: 'late' }, { type: 'keyLoaded', baseUrl: 'x', accessKey: 'k' }])).toBe(FORM_CLOSED)
  })

  it('puts a stored key only into the edit form it was read for', () => {
    const add = run([OPEN_ADD, { type: 'keyLoaded', baseUrl: VALUES.baseUrl, accessKey: 'stored' }])
    expect(add.kind === 'open' && add.values.accessKey).toBe('k')
    const edit = run([OPEN_EDIT, { type: 'keyLoaded', baseUrl: VALUES.baseUrl, accessKey: 'stored' }])
    expect(edit).toMatchObject({ values: { accessKey: 'stored' }, original: { accessKey: 'stored' } })
  })

  it('needs a new test for a new address or key, not for a new name', () => {
    const tested = run([OPEN_ADD, { type: 'tested', baseUrl: VALUES.baseUrl }])
    expect(run([{ type: 'input', field: 'serverName', value: 'Other' }], tested)).toMatchObject({ tested: VALUES.baseUrl })
    expect(run([{ type: 'input', field: 'accessKey', value: 'k2' }], tested)).toMatchObject({ tested: null })
  })
})
