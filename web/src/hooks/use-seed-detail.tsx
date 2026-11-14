/**
 * Settles the Detail setting of an install that stored none (see
 * ``useDisplayPrefsStore.seedDetail``): Simple for a new install, Full for one
 * whose server already has sessions. It reads the sidebar's own session list,
 * so it adds no request, and it stops listening once the style is settled.
 */
import { useEffect } from 'react'

import { useSessionsQuery } from '@/queries'
import { useDisplayPrefsStore } from '@/stores/useDisplayPrefsStore'

function SeedFromSessions() {
  const { data } = useSessionsQuery()
  const firstPage = data?.pages[0]
  useEffect(() => {
    if (firstPage) useDisplayPrefsStore.getState().seedDetail(firstPage.data.length > 0)
  }, [firstPage])
  return null
}

export function DetailSeed() {
  const seeded = useDisplayPrefsStore((s) => s.detailSeeded)
  return seeded ? null : <SeedFromSessions />
}
