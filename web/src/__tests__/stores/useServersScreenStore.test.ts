import { describe, expect, it } from 'bun:test'

import { openServersScreen, takeServersPrefill, useServersScreenStore } from '@/stores/useServersScreenStore'

describe('useServersScreenStore', () => {
  it('counts each request and hands a link prefill over once', () => {
    const before = useServersScreenStore.getState().request
    openServersScreen({ baseUrl: 'http://10.0.0.2:4082', accessKey: 'k' })
    expect(useServersScreenStore.getState().request).toBe(before + 1)
    expect(takeServersPrefill()).toEqual({ baseUrl: 'http://10.0.0.2:4082', accessKey: 'k' })
    expect(takeServersPrefill()).toBeNull()
    openServersScreen()
    expect(useServersScreenStore.getState().request).toBe(before + 2)
  })
})
