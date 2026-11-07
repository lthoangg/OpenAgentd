import { beforeEach, describe, expect, it, mock } from 'bun:test'

const calls: Array<{ cmd: string; args?: unknown }> = []
mock.module('@tauri-apps/api/core', () => ({
  invoke: async (cmd: string, args?: unknown) => {
    calls.push({ cmd, args })
    if (cmd === 'updater_channel') return 'testflight'
    return { status: 'up_to_date' }
  },
}))

import { queryClient } from '@/lib/query-client'
import { queryKeys } from '@/queries/keys'
import { appChannel, channelLabel, checkForUpdates, openStoreLabel } from '@/lib/updater'

beforeEach(() => {
  calls.length = 0
  queryClient.clear()
})

describe('updater', () => {
  it('passes the server version so a TestFlight copy can compare', async () => {
    queryClient.setQueryData(queryKeys.health(), { status: 'ok', version: '3.50.0' })
    await checkForUpdates(true)
    expect(calls[0]).toEqual({ cmd: 'updater_check', args: { request: { silent: true, server_version: '3.50.0' } } })
  })

  it('checks without a server version when none is connected', async () => {
    await checkForUpdates(false)
    expect(calls[0].args).toEqual({ request: { silent: false, server_version: undefined } })
  })

  it('reads and names the install channel', async () => {
    expect(await appChannel()).toBe('testflight')
    expect(channelLabel('testflight')).toBe('TestFlight beta')
    expect(channelLabel('appstore')).toBe('App Store')
    expect(channelLabel('apk')).toBeNull()
  })

  it('only TestFlight opens another app', () => {
    expect(openStoreLabel({ status: 'available', channel: 'testflight' })).toBe('Open TestFlight')
    expect(openStoreLabel({ status: 'available', channel: 'appstore' })).toBeNull()
    expect(openStoreLabel({ status: 'available', channel: 'apk' })).toBeNull()
  })
})
