import { beforeEach, describe, expect, it } from 'bun:test'

import { consumeConnectPhone, startConnectPhone, useConnectPhoneStore } from '@/lib/connect-phone'
import { useSettingsStore } from '@/stores/useSettingsStore'

describe('Connect your phone', () => {
  beforeEach(() => {
    useConnectPhoneStore.setState({ requested: 0, handled: 0 })
    useSettingsStore.setState({ open: false, section: 'general' })
  })

  it('opens Settings → Remote control with a sign-in request', () => {
    startConnectPhone()

    expect(useSettingsStore.getState().open).toBe(true)
    expect(useSettingsStore.getState().section).toBe('remote')
    expect(useConnectPhoneStore.getState().requested).toBe(1)
  })

  it('hands each request out once', () => {
    startConnectPhone()

    expect(consumeConnectPhone()).toBe(true)
    expect(consumeConnectPhone()).toBe(false)
    startConnectPhone()
    expect(consumeConnectPhone()).toBe(true)
  })

  it('opens Account without a request while a sign-in is already under way', () => {
    startConnectPhone({ signIn: false })

    expect(useSettingsStore.getState().section).toBe('remote')
    expect(consumeConnectPhone()).toBe(false)
  })
})
